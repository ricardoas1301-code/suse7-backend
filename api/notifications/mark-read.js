// ======================================================================
// API /api/notifications/mark-read — Marcar notificações como lidas
// POST { ids: [uuid] } OU { all: true }
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../src/infra/config.js";
import { ok, fail, getTraceId } from "../../src/infra/http.js";
import { withCors } from "../../src/utils/withCors.js";

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
    const { ids, all } = body;

    if (all === true) {
      const { data: updated, error } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("user_id", user.id)
        .is("read_at", null)
        .select("id");

      if (error) {
        console.error("[notifications/mark-read] update all error:", error);
        return fail(res, { code: "DB_ERROR", message: "Erro ao marcar notificações" }, 500, traceId);
      }

      return ok(res, { ok: true, count: (updated || []).length, message: "Todas marcadas como lidas" });
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      return fail(
        res,
        { code: "INVALID_INPUT", message: "ids (array de UUID) ou all: true é obrigatório" },
        400,
        traceId
      );
    }

    const validIds = ids.filter((id) => typeof id === "string" && id.trim().length > 0);
    if (validIds.length === 0) {
      return fail(
        res,
        { code: "INVALID_INPUT", message: "Nenhum id válido fornecido" },
        400,
        traceId
      );
    }

    const { data: updated, error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .in("id", validIds)
      .select("id");

    if (error) {
      console.error("[notifications/mark-read] update error:", error);
      return fail(res, { code: "DB_ERROR", message: "Erro ao marcar notificações" }, 500, traceId);
    }

    return ok(res, { ok: true, count: (updated || []).length, message: "Notificações marcadas como lidas" });
  } catch (err) {
    console.error("[notifications/mark-read] fail", err);
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
