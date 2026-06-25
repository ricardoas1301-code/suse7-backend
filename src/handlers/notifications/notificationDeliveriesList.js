// ============================================================
// GET /api/notifications/deliveries — lista operacional (Fase 3)
// ============================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { maskDeliveryDestination, sanitizeJsonForApi } from "../../domain/notifications/notificationHistorySanitize.js";

function parseIntDef(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export async function handleNotificationDeliveriesList(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Método não permitido" });
  }

  const auth = await requireAuthUser(req);
  if (auth.error) {
    return res.status(auth.error.status ?? 401).json({ ok: false, error: auth.error.message });
  }

  const { user, supabase } = auth;
  const uid = String(user.id);

  const page = parseIntDef(req.query?.page, 1, 1, 5000);
  const pageSize = parseIntDef(req.query?.page_size ?? req.query?.limit, 50, 1, 150);

  let q = supabase
    .from("notification_deliveries")
    .select("*", { count: "exact" })
    .eq("user_id", uid)
    .order("created_at", { ascending: false });

  const st = req.query?.status != null ? String(req.query.status).trim() : "";
  const ch = req.query?.channel != null ? String(req.query.channel).trim() : "";
  const provider = req.query?.provider != null ? String(req.query.provider).trim() : "";
  const contactId = req.query?.contact_id != null ? String(req.query.contact_id).trim() : "";
  const eventId = req.query?.notification_event_id != null ? String(req.query.notification_event_id).trim() : "";
  const createdFrom = req.query?.created_from != null ? String(req.query.created_from).trim() : "";
  const createdTo = req.query?.created_to != null ? String(req.query.created_to).trim() : "";

  if (st) q = q.eq("status", st);
  if (ch) q = q.eq("notification_channel", ch);
  if (provider) q = q.eq("provider", provider);
  if (contactId) q = q.eq("contact_id", contactId);
  if (eventId) q = q.eq("notification_event_id", eventId);
  if (createdFrom) q = q.gte("created_at", createdFrom);
  if (createdTo) q = q.lte("created_at", createdTo);

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await q.range(from, to);

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  const items = (data ?? []).map((row) => {
    const chan = String(row.notification_channel ?? "");
    return {
      ...row,
      destination_masked: maskDeliveryDestination(row.destination, chan),
      destination: undefined,
      provider_response: sanitizeJsonForApi(row.provider_response),
    };
  });

  return res.status(200).json({
    ok: true,
    items,
    page,
    page_size: pageSize,
    total: Number.isFinite(count) ? count : items.length,
  });
}
