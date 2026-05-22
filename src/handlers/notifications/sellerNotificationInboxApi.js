// =============================================================================
// APIs seller — Inbox in-app (Fase 3.3)
// GET  /api/notifications/inbox
// PATCH /api/notifications/inbox/:id/read
// PATCH /api/notifications/inbox/read-all
// =============================================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import {
  listSellerNotificationInbox,
  markAllSellerInboxRead,
  markSellerInboxItemRead,
} from "../../domain/notifications/central/seller/sellerNotificationInboxService.js";

function parseBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === "string") {
    try {
      return req.body.trim() ? JSON.parse(req.body) : {};
    } catch {
      return null;
    }
  }
  return typeof req.body === "object" ? req.body : {};
}

function jsonError(res, status, code, message) {
  return res.status(status).json({ ok: false, error: code, message });
}

/**
 * GET /api/notifications/inbox
 */
export async function handleNotificationInboxList(req, res) {
  if (req.method !== "GET") {
    return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Método não permitido");
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const sellerId = String(auth.user.id);
  const url = new URL(req.url || "", `http://${req.headers?.host || "localhost"}`);
  const limit = Number(url.searchParams.get("limit") || url.searchParams.get("page_size") || "20");
  const cursor = url.searchParams.get("cursor");
  const unreadOnly = url.searchParams.get("unread") === "true";

  try {
    const payload = await listSellerNotificationInbox(auth.supabase, {
      sellerId,
      limit,
      cursor,
      unreadOnly,
    });
    return res.status(200).json({ ok: true, ...payload });
  } catch (e) {
    return jsonError(res, 500, "INTERNAL", e?.message ?? "Erro ao carregar inbox");
  }
}

/**
 * PATCH /api/notifications/inbox/:id/read
 */
export async function handleNotificationInboxMarkRead(req, res, dispatchId) {
  if (req.method !== "PATCH") {
    return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Método não permitido");
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const id = String(dispatchId ?? "").trim();
  if (!id) return jsonError(res, 400, "INVALID_ID", "ID inválido");

  try {
    const result = await markSellerInboxItemRead(auth.supabase, String(auth.user.id), id);
    if (!result.ok) return jsonError(res, 404, "NOT_FOUND", "Notificação não encontrada");
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return jsonError(res, 500, "INTERNAL", e?.message ?? "Erro ao marcar como lida");
  }
}

/**
 * PATCH /api/notifications/inbox/read-all
 */
export async function handleNotificationInboxMarkAllRead(req, res) {
  if (req.method !== "PATCH") {
    return jsonError(res, 405, "METHOD_NOT_ALLOWED", "Método não permitido");
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  parseBody(req);

  try {
    const result = await markAllSellerInboxRead(auth.supabase, String(auth.user.id));
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return jsonError(res, 500, "INTERNAL", e?.message ?? "Erro ao marcar todas como lidas");
  }
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} path
 */
export async function handleNotificationInboxRoutes(req, res, path) {
  if (path === "/api/notifications/inbox" && req.method === "GET") {
    return handleNotificationInboxList(req, res);
  }
  if (path === "/api/notifications/inbox/read-all" && req.method === "PATCH") {
    return handleNotificationInboxMarkAllRead(req, res);
  }
  const match = path.match(/^\/api\/notifications\/inbox\/([^/]+)\/read$/);
  if (match && req.method === "PATCH") {
    return handleNotificationInboxMarkRead(req, res, match[1]);
  }
  return jsonError(res, 404, "NOT_FOUND", "Rota não encontrada");
}
