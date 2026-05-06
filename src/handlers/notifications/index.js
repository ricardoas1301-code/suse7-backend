// ==================================================
// SUSE7 — Handler: Notifications List
// Arquivo: src/handlers/notifications/index.js
// ==================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";

export async function handleNotifications(req, res) {
  const traceId = getTraceId(req);
  const emptyPage = {
    ok: true,
    items: [],
    notifications: [],
    unread_count: 0,
    critical_count: 0,
    page: 1,
    page_size: 20,
    total: 0,
    pagination: { page: 1, page_size: 20, total: 0 },
  };

  if (req.method !== "GET") {
    return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Método não permitido" }, 405, traceId);
  }

  try {
    // Valida config Supabase (evita 500 por env vars ausentes)
    if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
      console.error("[Suse7][API][notifications] failed", {
        message: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente",
      });
      return ok(res, emptyPage);
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
    const filterRead = url.searchParams.get("unread"); // unread=true => read_at IS NULL
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      200,
      Math.max(1, Number.parseInt(url.searchParams.get("page_size") || url.searchParams.get("limit") || "20", 10) || 20)
    );
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    // Colunas mínimas (evitar 42703): id, user_id, type, read_at, created_at
    // payload, product_id etc. podem não existir em prod
    let q = supabase
      .from("notifications")
      .select("id, user_id, type, read_at, created_at", { count: "exact" })
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (filterRead === "true") {
      q = q.is("read_at", null);
    } else if (filterRead === "false") {
      q = q.not("read_at", "is", null);
    }

    console.log("[notifications] traceId:", traceId, "query params:", {
      userId: user.id,
      filterRead,
      page,
      pageSize,
    });

    const { data, error, count } = await q;

    if (error) {
      console.error("[Suse7][API][notifications] failed", {
        message: error?.message,
        code: error?.code,
        details: error?.details,
      });
      return ok(res, { ...emptyPage, page, page_size: pageSize, pagination: { page, page_size: pageSize, total: 0 } });
    }

    const rows = Array.isArray(data) ? data : [];
    const unreadCount = rows.filter((n) => n?.read_at == null).length;
    return ok(res, {
      ok: true,
      items: rows,
      notifications: rows,
      unread_count: unreadCount,
      critical_count: 0,
      page,
      page_size: pageSize,
      total: Number.isFinite(count) ? count : rows.length,
      pagination: {
        page,
        page_size: pageSize,
        total: Number.isFinite(count) ? count : rows.length,
      },
    });
  } catch (err) {
    console.error("[Suse7][API][notifications] failed", {
      message: err?.message,
      code: err?.code,
      details: err?.details,
    });
    return ok(res, emptyPage);
  }
}
