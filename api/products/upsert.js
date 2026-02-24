// ======================================================================
// POST /api/products/upsert — Cria ou atualiza produto
// Base Enterprise: http helpers, domain service, auditoria, traceId
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../src/infra/config.js";
import { ok, fail, getTraceId } from "../../src/infra/http.js";
import { applyCors } from "../../src/middlewares/cors.js";
import {
  normalizeProductPayload,
  validateFormatTransition,
  validateSkuUniqueness,
} from "../../src/domain/ProductDomainService.js";
import {
  validateStatusTransition,
  validateReadyRequirements,
} from "../../src/domain/ProductStatusDomainService.js";
import { recordAuditEvent } from "../../src/infra/auditService.js";

export default async function handler(req, res) {
  const finished = applyCors(req, res);
  if (finished) return;

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

    if (!isUpdate) {
      normalized.status = "draft";
    }

    // ------------------------------------------------------------------
    // Domain: validar unicidade de SKU (payload + banco)
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // Domain: validar transição de formato (variants → simple bloqueado)
    // Domain: validar transição de status (se payload.status presente)
    // ------------------------------------------------------------------
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

      // ------------------------------------------------------------------
      // Auditoria: update (before/after)
      // ------------------------------------------------------------------
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
      // ------------------------------------------------------------------
      // Auditoria: create
      // ------------------------------------------------------------------
      try {
        const entityId = productId ?? crypto.randomUUID();
        const diff = { before: null, after: normalized };
        await recordAuditEvent({
          userId: user.id,
          entityType: "product",
          entityId,
          action: "create",
          diff,
          traceId,
        });
      } catch (auditErr) {
        console.error("[products/upsert] audit create fail", auditErr);
      }
    }

    // Placeholder: persistência real será implementada quando frontend integrar
    return ok(res, {
      ok: true,
      productId: productId || null,
      message: "Validação concluída",
    });
  } catch (err) {
    console.error("[products/upsert] fail", err);
    return fail(
      res,
      {
        code: "INTERNAL_ERROR",
        message: "Erro interno",
        details: process.env.NODE_ENV === "development" ? String(err?.message) : undefined,
      },
      500,
      traceId
    );
  }
}
