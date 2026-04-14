// ======================================================================
// POST /api/products/upsert — Cria ou atualiza produto
// Base Enterprise: http helpers, domain service, auditoria, traceId
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import {
  normalizeProductPayload,
  validateFormatTransition,
  validateSkuUniqueness,
} from "../../domain/ProductDomainService.js";
import {
  validateStatusTransition,
  validateReadyRequirements,
} from "../../domain/ProductStatusDomainService.js";
import { recordAuditEvent } from "../../infra/auditService.js";
import {
  validateCreatePayload,
  buildProductInsertPayload,
  buildProductUpdatePayload,
} from "./create.js";
import { syncProductVariantsAfterParentUpdate } from "./variantSync.js";
import { resolveCatalogCompleteness } from "../../domain/productCatalogCompleteness.js";
import { syncListingsFinancialBlockForProduct } from "../ml/_helpers/mlListingProductLink.js";

export async function handleProductsUpsert(req, res) {
  if (req.method !== "POST") {
    const traceId = getTraceId(req);
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" }, 405, traceId);
  }

  const traceId = getTraceId(req);

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return fail(res, { code: "UNAUTHORIZED", message: "Token não informado" }, 401, traceId);
    }
    const token = authHeader.slice(7);

    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user?.id) {
      return fail(res, { code: "UNAUTHORIZED", message: "Token inválido" }, 401, traceId);
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const { product, mode: modeRaw = "create", variants = [] } = body;
    const modeNorm = String(modeRaw || "create").trim().toLowerCase();

    if (process.env.NODE_ENV !== "production") {
      const vc = Array.isArray(variants) ? variants.length : -1;
      console.info("[products/upsert] request", {
        mode: modeNorm,
        productId: product?.id ?? "(create)",
        format: product?.format,
        variantCount: vc,
        bodyKeys: Object.keys(body),
      });
    }
    const productId =
      product?.id != null && String(product.id).trim() !== "" ? String(product.id).trim() : "";

    if (!product) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[products/upsert] body keys recebido:", Object.keys(body));
      }
      const hint =
        process.env.NODE_ENV === "development"
          ? " Verifique se o body da requisição foi enviado como JSON com chave 'product'."
          : "";
      return fail(
        res,
        { code: "INVALID_INPUT", message: "product é obrigatório" + hint },
        400,
        traceId
      );
    }

    const normalized = normalizeProductPayload(product);
    delete normalized.catalog_completeness;
    delete normalized.catalog_source;
    const isUpdate = modeNorm === "edit" && Boolean(productId);

    // ------------------------------------------------------
    // CREATE: validar payload mínimo
    // ------------------------------------------------------
    if (!isUpdate) {
      normalized.status = "draft";
      const createCheck = validateCreatePayload(normalized);
      if (!createCheck.valid) {
        return fail(
          res,
          { code: createCheck.code, message: createCheck.message },
          400,
          traceId
        );
      }
    }

    /** Origem do catálogo (preservada no update; não vem do client). */
    let catalogSourceForUpdate = "manual";

    const skuCheck = await validateSkuUniqueness(normalized, variants, {
      supabase,
      userId: user.id,
      productId: isUpdate ? productId : undefined,
    });
    if (!skuCheck.valid) {
      return fail(
        res,
        {
          code: skuCheck.code,
          message: skuCheck.message,
          details: skuCheck.details,
        },
        409,
        traceId
      );
    }

    if (isUpdate) {
      const { data: existing, error: fetchError } = await supabase
        .from("products")
        .select(
          "id, format, user_id, status, catalog_source, catalog_completeness, cost_price, packaging_cost, operational_cost"
        )
        .eq("id", productId)
        .eq("user_id", user.id)
        .single();

      if (fetchError || !existing) {
        return fail(res, { code: "PRODUCT_NOT_FOUND", message: "Produto não encontrado" }, 404, traceId);
      }

      catalogSourceForUpdate =
        existing.catalog_source != null && String(existing.catalog_source).trim() !== ""
          ? String(existing.catalog_source).trim()
          : "manual";

      const formatCheck = validateFormatTransition(existing, normalized);
      if (!formatCheck.valid) {
        return fail(
          res,
          { code: formatCheck.code, message: formatCheck.message },
          409,
          traceId
        );
      }

      const nextStatus = normalized.status;
      if (nextStatus != null && String(nextStatus).trim() !== "") {
        const currentStatus = (existing.status || "draft").toLowerCase();
        const nextStatusNorm = String(nextStatus).trim().toLowerCase();

        const statusCheck = validateStatusTransition(currentStatus, nextStatusNorm);
        if (!statusCheck.valid) {
          return fail(
            res,
            {
              code: statusCheck.code,
              message: statusCheck.message,
              details: statusCheck.details,
            },
            409,
            traceId
          );
        }

        if (nextStatusNorm === "ready") {
          const readyCheck = validateReadyRequirements(normalized, variants);
          if (!readyCheck.valid) {
            return fail(
              res,
              {
                code: readyCheck.code,
                message: readyCheck.message,
                details: readyCheck.details,
              },
              409,
              traceId
            );
          }
        }

        try {
          await recordAuditEvent({
            userId: user.id,
            entityType: "product_status",
            entityId: productId,
            action: "update",
            diff: { before: currentStatus, after: nextStatusNorm },
            traceId,
          });
        } catch (auditErr) {
          console.error("[products/upsert] audit status fail", auditErr);
        }
      }

      try {
        const diff = { before: existing, after: normalized };
        await recordAuditEvent({
          userId: user.id,
          entityType: "product",
          entityId: productId,
          action: "update",
          diff,
          traceId,
        });
      } catch (auditErr) {
        console.error("[products/upsert] audit update fail", auditErr);
      }
    } else {
      // ------------------------------------------------------
      // CREATE: inserir em public.products
      // ------------------------------------------------------
      const insertPayload = buildProductInsertPayload(normalized, user.id);
      insertPayload.catalog_source = insertPayload.catalog_source ?? "manual";
      insertPayload.catalog_completeness = resolveCatalogCompleteness(
        {
          cost_price: insertPayload.cost_price,
          packaging_cost: insertPayload.packaging_cost,
          operational_cost: insertPayload.operational_cost,
        },
        { catalog_source: "manual" }
      );
      insertPayload.is_imported_from_marketplace = false;
      insertPayload.completion_status =
        insertPayload.catalog_completeness === "complete" ? "complete" : "incomplete";
      insertPayload.missing_required_costs = insertPayload.catalog_completeness !== "complete";

      const { data: inserted, error: insertError } = await supabase
        .from("products")
        .insert(insertPayload)
        .select("id")
        .single();

      if (insertError) {
        console.error("[products/upsert] create insert fail", insertError);
        const errMsg = insertError?.message || String(insertError);
        const isColumnMissing = /column.*does not exist|ad_titles/i.test(errMsg);
        const message = isColumnMissing
          ? "Erro ao criar produto. Aplique a migration ad_titles no Supabase (APPLY_MANUAL_products_ad_titles.sql)."
          : "Erro ao criar produto";
        return fail(
          res,
          {
            code: "DB_ERROR",
            message,
            details: errMsg,
            traceId,
          },
          500,
          traceId
        );
      }

      const newProductId = inserted?.id ?? null;

      try {
        const diff = { before: null, after: normalized };
        await recordAuditEvent({
          userId: user.id,
          entityType: "product",
          entityId: newProductId,
          action: "create",
          diff,
          traceId,
        });
      } catch (auditErr) {
        console.error("[products/upsert] audit create fail", auditErr);
      }

      const formatCreate = String(normalized.format || "simple").toLowerCase();
      if (
        newProductId &&
        formatCreate === "variants" &&
        Array.isArray(variants) &&
        variants.length > 0
      ) {
        const sync = await syncProductVariantsAfterParentUpdate({
          supabase,
          userId: user.id,
          productId: newProductId,
          variants,
        });
        if (!sync.ok) {
          console.error("[products/upsert] variant sync fail (create)", sync.message);
          return fail(
            res,
            {
              code: "VARIANT_SYNC_ERROR",
              message:
                sync.message ||
                "Produto criado, mas falhou ao salvar variações. Edite o produto e salve novamente.",
              traceId,
            },
            500,
            traceId
          );
        }
      }

      return ok(res, {
        ok: true,
        productId: newProductId,
        message: "Produto criado com sucesso",
      });
    }

    // ------------------------------------------------------
    // UPDATE: persistir campos em public.products (incl. product_images jsonb)
    // ------------------------------------------------------
    const updatePayload = buildProductUpdatePayload(normalized, user.id);
    updatePayload.catalog_completeness = resolveCatalogCompleteness(
      {
        cost_price: updatePayload.cost_price,
        packaging_cost: updatePayload.packaging_cost,
        operational_cost: updatePayload.operational_cost,
      },
      { catalog_source: catalogSourceForUpdate }
    );
    updatePayload.completion_status =
      updatePayload.catalog_completeness === "complete" ? "complete" : "incomplete";
    updatePayload.missing_required_costs = updatePayload.catalog_completeness !== "complete";
    const { data: updatedRows, error: updateError } = await supabase
      .from("products")
      .update(updatePayload)
      .eq("id", productId)
      .eq("user_id", user.id)
      .select("id");

    if (updateError) {
      console.error("[products/upsert] update fail", updateError);
      return fail(
        res,
        {
          code: "DB_ERROR",
          message: "Erro ao atualizar produto",
          details: updateError.message,
          traceId,
        },
        500,
        traceId
      );
    }

    if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
      console.error("[products/upsert] update affected 0 rows", { productId, userId: user.id });
      return fail(
        res,
        {
          code: "PRODUCT_NOT_UPDATED",
          message: "Nenhuma linha foi atualizada. Verifique se o produto existe e pertence à sua conta.",
          traceId,
        },
        404,
        traceId
      );
    }

    const formatNorm = String(normalized.format || "simple").toLowerCase();
    if (formatNorm === "variants" && Array.isArray(variants) && variants.length > 0) {
      const sync = await syncProductVariantsAfterParentUpdate({
        supabase,
        userId: user.id,
        productId,
        variants,
      });
      if (!sync.ok) {
        console.error("[products/upsert] variant sync fail", sync.message);
        return fail(
          res,
          {
            code: "VARIANT_SYNC_ERROR",
            message: sync.message || "Produto atualizado, mas falhou ao salvar variações.",
            traceId,
          },
          500,
          traceId
        );
      }
    }

    try {
      await syncListingsFinancialBlockForProduct(
        supabase,
        user.id,
        productId,
        /** @type {"complete" | "incomplete_required_costs" | "draft_imported_from_marketplace"} */ (
          updatePayload.catalog_completeness
        )
      );
    } catch (syncL) {
      console.warn("[products/upsert] sync listing financial flags warn", syncL);
    }

    return ok(res, {
      ok: true,
      productId: productId || null,
      message: "Produto atualizado com sucesso",
    });
  } catch (err) {
    console.error("[products/upsert] fail", err);
    const errMsg = err?.message || String(err);
    return fail(
      res,
      {
        code: "INTERNAL_ERROR",
        message: "Erro interno",
        details: errMsg,
        traceId,
      },
      500,
      traceId
    );
  }
}
