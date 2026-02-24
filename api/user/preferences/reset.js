// ======================================================================
// API /api/user/preferences/reset — Resetar preferências por prefixo
// POST { prefix: "modal." }
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../../src/infra/config.js";
import { ok, fail, getTraceId } from "../../../src/infra/http.js";
import { applyCors } from "../../../src/middlewares/cors.js";
import { recordAuditEvent } from "../../../src/infra/auditService.js";

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
    const { prefix } = body;

    if (!prefix || typeof prefix !== "string" || prefix.trim().length === 0) {
      return fail(
        res,
        { code: "KEY_INVALID", message: "prefix é obrigatório" },
        400,
        traceId
      );
    }

    const prefixNorm = prefix.trim().toLowerCase();

    // Buscar preferências que começam com o prefixo
    const { data: toDelete, error: fetchError } = await supabase
      .from("user_preferences")
      .select("id, key, value")
      .eq("user_id", user.id)
      .ilike("key", `${prefixNorm}%`);

    if (fetchError) {
      console.error("[user/preferences/reset] fetch error:", fetchError);
      return fail(res, { code: "DB_ERROR", message: "Erro ao buscar preferências" }, 500, traceId);
    }

    const items = toDelete || [];
    if (items.length === 0) {
      return ok(res, { ok: true, count: 0, message: "Nenhuma preferência encontrada para o prefixo" });
    }

    const ids = items.map((i) => i.id);
    const { error: deleteError } = await supabase
      .from("user_preferences")
      .delete()
      .eq("user_id", user.id)
      .in("id", ids);

    if (deleteError) {
      console.error("[user/preferences/reset] delete error:", deleteError);
      return fail(res, { code: "DB_ERROR", message: "Erro ao resetar preferências" }, 500, traceId);
    }

    try {
      await recordAuditEvent({
        userId: user.id,
        entityType: "user_preference",
        entityId: `reset_${Date.now()}`,
        action: "update",
        diff: {
          action: "reset_preferences",
          prefix: prefixNorm,
          count: items.length,
          keys: items.map((i) => i.key),
        },
        traceId,
      });
    } catch (auditErr) {
      console.error("[user/preferences/reset] audit fail", auditErr);
    }

    return ok(res, {
      ok: true,
      count: items.length,
      message: `${items.length} preferência(s) resetada(s)`,
    });
  } catch (err) {
    console.error("[user/preferences/reset] fail", err);
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
