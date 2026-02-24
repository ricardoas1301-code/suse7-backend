// ==================================================
// SUSE7 — Handler: Notifications List
// Arquivo: src/handlers/notifications/index.js
// ==================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";

export async function handleNotifications(req, res) {
  const traceId = getTraceId(req);

  if (req.method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" }, 405, traceId);
  }

  try {
    // Valida config Supabase (evita 500 por env vars ausentes)
    if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
      console.error("[notifications] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente");
      return fail(res, { code: "CONFIG_ERROR", message: "Configuração do banco indisponível" }, 503, traceId);
    }

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

    const q = req.query || {};
    const unread = q.unread === "1";
    const active = q.active === "1";
    const limit = Math.min(parseInt(q.limit || "50", 10) || 50, 100);

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
      console.error("[notifications] GET error:", error?.message || error, "code:", error?.code);
      return fail(res, { code: "DB_ERROR", message: "Erro ao listar notificações" }, 500, traceId);
    }

    return ok(res, { notifications: data || [] });
  } catch (err) {
    console.error("[notifications] fail", err?.message, err?.stack);
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
