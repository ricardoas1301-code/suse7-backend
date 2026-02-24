// ======================================================================
// POST /api/products/change-status — Mudança explícita de status
// Valida transição e requisitos (ready). Atualiza apenas status.
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../src/infra/config.js";
import { ok, fail, getTraceId } from "../../src/infra/http.js";
import { withCors } from "../../src/utils/withCors.js";
import {
  validateStatusTransition,
  validateReadyRequirements,
} from "../../src/domain/ProductStatusDomainService.js";
import { recordAuditEvent } from "../../src/infra/auditService.js";

async function handler(req, res) {
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
    const { product_id, status } = body;

    if (!product_id || !status) {
      return fail(
        res,
        { code: "INVALID_INPUT", message: "product_id e status são obrigatórios" },
        400,
        traceId
      );
    }

    const nextStatus = String(status).trim().toLowerCase();

    const { data: existing, error: fetchError } = await supabase
      .from("products")
      .select("id, user_id, status, product_name, sku, format, cost_price")
      .eq("id", product_id)
      .eq("user_id", user.id)
      .single();

    if (fetchError || !existing) {
      return fail(res, { code: "PRODUCT_NOT_FOUND", message: "Produto não encontrado" }, 404, traceId);
    }

    const currentStatus = (existing.status || "draft").toLowerCase();

    const statusCheck = validateStatusTransition(currentStatus, nextStatus);
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

    if (nextStatus === "ready") {
      let variants = [];
      if (existing.format === "variants") {
        const { data: vars } = await supabase
          .from("product_variants")
          .select("id")
          .eq("product_id", product_id);
        variants = vars || [];
      }

      const readyCheck = validateReadyRequirements(existing, variants);
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

    const { error: updateError } = await supabase
      .from("products")
      .update({ status: nextStatus })
      .eq("id", product_id)
      .eq("user_id", user.id);

    if (updateError) {
      console.error("[products/change-status] update error:", updateError);
      return fail(res, { code: "DB_ERROR", message: "Erro ao atualizar status" }, 500, traceId);
    }

    try {
      await recordAuditEvent({
        userId: user.id,
        entityType: "product_status",
        entityId: product_id,
        action: "update",
        diff: { before: currentStatus, after: nextStatus },
        traceId,
      });
    } catch (auditErr) {
      console.error("[products/change-status] audit fail", auditErr);
    }

    return ok(res, { ok: true, productId: product_id, status: nextStatus });
  } catch (err) {
    console.error("[products/change-status] fail", err);
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

export default withCors(handler);
