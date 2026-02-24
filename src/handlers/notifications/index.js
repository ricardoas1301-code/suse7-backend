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
      console.error("[notifications] traceId:", traceId, "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente");
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

    // Parse query da URL (não depende de req.query)
    const url = new URL(req.url || "", `http://${req.headers?.host || "localhost"}`);
    const active = url.searchParams.get("active");
    const unread = url.searchParams.get("unread");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50) || 50, 1), 200);

    let q = supabase
      .from("notifications")
      .select("id, type, product_id, variant_id, variant_key, payload, dedupe_key, created_at, read_at, resolved_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    // active => resolved_at (active=true = não resolvida = resolved_at IS NULL)
    if (active === "true") {
      q = q.is("resolved_at", null);
    } else if (active === "false") {
      q = q.not("resolved_at", "is", null);
    }

    // unread => read_at (unread=true = read_at IS NULL)
    if (unread === "true") {
      q = q.is("read_at", null);
    } else if (unread === "false") {
      q = q.not("read_at", "is", null);
    }

    const { data, error } = await q;

    if (error) {
      console.error("[notifications] traceId:", traceId, "Supabase error:", error?.code, error?.message, error?.details, error?.hint);
      return res.status(400).json({
        ok: false,
        code: error?.code || "DB_ERROR",
        message: error?.message || "Erro ao listar notificações",
        details: error?.details,
        hint: error?.hint,
        traceId,
      });
    }

    return ok(res, { notifications: data || [] });
  } catch (err) {
    console.error("[notifications] traceId:", traceId, "fail:", err?.message, err?.stack);
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
