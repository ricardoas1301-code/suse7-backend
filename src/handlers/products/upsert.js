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
} from "./create.js";

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
    const { product, mode = "create", variants = [] } = body;
    const productId = product?.id;

    if (!product) {
      return fail(res, { code: "INVALID_INPUT", message: "product é obrigatório" }, 400, traceId);
    }

    const normalized = normalizeProductPayload(product);
    const isUpdate = mode === "edit" && productId;

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
        .select("id, format, user_id, status")
        .eq("id", productId)
        .eq("user_id", user.id)
        .single();

      if (fetchError || !existing) {
        return fail(res, { code: "PRODUCT_NOT_FOUND", message: "Produto não encontrado" }, 404, traceId);
      }

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

      // TODO: Se product.format === "variants" e variants.length > 0:
      // Inserir em public.product_variants vinculando product_id.
      // sort_order seguindo array order. user_id = auth.uid.
      // Validar SKU obrigatório por variação.

      return ok(res, {
        ok: true,
        productId: newProductId,
        message: "Produto criado com sucesso",
      });
    }

    // ------------------------------------------------------
    // UPDATE: (lógica existente retorna aqui após validações)
    // Por ora o update ainda não persiste; manter contrato.
    // ------------------------------------------------------
    return ok(res, {
      ok: true,
      productId: productId || null,
      message: "Validação concluída",
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
