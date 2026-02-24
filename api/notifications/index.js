// ======================================================================
// API /api/notifications — Listar notificações do seller
// GET ?unread=1&active=1&limit=50
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../src/infra/config.js";
import { ok, fail, getTraceId } from "../../src/infra/http.js";
import { withCors } from "../../src/utils/withCors.js";

async function handler(req, res) {
  if (req.method !== "GET") {
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

    const params = req.url?.split("?")[1] ? new URLSearchParams(req.url.split("?")[1]) : null;
    const unread = params?.get("unread") === "1";
    const active = params?.get("active") === "1";
    const limit = Math.min(parseInt(params?.get("limit") || "50", 10) || 50, 100);

    let query = supabase
      .from("notifications")
      .select("id, type, product_id, variant_id, variant_key, payload, dedupe_key, created_at, read_at, resolved_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (unread) {
      query = query.is("read_at", null);
    }
    if (active) {
      query = query.is("resolved_at", null);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[notifications] GET error:", error);
      return fail(res, { code: "DB_ERROR", message: "Erro ao listar notificações" }, 500, traceId);
    }

    return ok(res, { notifications: data || [] });
  } catch (err) {
    console.error("[notifications] fail", err);
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
