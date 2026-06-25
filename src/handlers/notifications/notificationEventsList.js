// ============================================================
// GET /api/notifications/events — lista paginada (Fase 3)
// ============================================================

import { requireAuthUser } from "../ml/_helpers/requireAuthUser.js";
import { attachEventSummaries, groupDeliveriesByEventId } from "./notificationHistoryHelpers.js";

function parseIntDef(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} eventIds
 */
async function fetchDeliveriesBulk(supabase, userId, eventIds) {
  if (eventIds.length === 0) return [];
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("id, notification_event_id, status, notification_channel")
    .eq("user_id", userId)
    .in("notification_event_id", eventIds);

  if (error) {
    console.error("[notificationEventsList] deliveries bulk", error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

export async function handleNotificationEventsList(req, res) {
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
  const pageSize = parseIntDef(req.query?.page_size ?? req.query?.limit, 20, 1, 100);

  const notificationType =
    req.query?.notification_type != null ? String(req.query.notification_type).trim() : "";
  const marketplaceAccountId =
    req.query?.marketplace_account_id != null ? String(req.query.marketplace_account_id).trim() : "";
  const severity = req.query?.severity != null ? String(req.query.severity).trim() : "";
  const entityType = req.query?.entity_type != null ? String(req.query.entity_type).trim() : "";
  const entityId = req.query?.entity_id != null ? String(req.query.entity_id).trim() : "";
  const createdFrom = req.query?.created_from != null ? String(req.query.created_from).trim() : "";
  const createdTo = req.query?.created_to != null ? String(req.query.created_to).trim() : "";
  const deliveryStatus =
    req.query?.delivery_status != null ? String(req.query.delivery_status).trim().toLowerCase() : "";
  const notificationChannel =
    req.query?.notification_channel != null ? String(req.query.notification_channel).trim().toLowerCase() : "";

  const buildQuery = (withCount) =>
    /** @type {import("@supabase/supabase-js").PostgrestFilterBuilder<any>} */ (
      (() => {
        let q = supabase
          .from("notification_events")
          .select("*", withCount ? { count: "exact" } : {})
          .eq("user_id", uid)
          .order("created_at", { ascending: false });

        if (notificationType) q = q.eq("notification_type", notificationType);
        if (marketplaceAccountId) q = q.eq("marketplace_account_id", marketplaceAccountId);
        if (severity) q = q.eq("severity", severity);
        if (entityType) q = q.eq("entity_type", entityType);
        if (entityId) q = q.eq("entity_id", entityId);
        if (createdFrom) q = q.gte("created_at", createdFrom);
        if (createdTo) q = q.lte("created_at", createdTo);
        return q;
      })()
    );

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const needsDeliveryScan = Boolean(deliveryStatus) || Boolean(notificationChannel);

  if (!needsDeliveryScan) {
    const { data: events, error, count } = await buildQuery(true).range(from, to);
    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    const rows = Array.isArray(events) ? events : [];
    const ids = rows.map((e) => String(e.id));
    const deliveries = await fetchDeliveriesBulk(supabase, uid, ids);
    const map = groupDeliveriesByEventId(deliveries);
    const items = attachEventSummaries(rows, map);

    return res.status(200).json({
      ok: true,
      items,
      page,
      page_size: pageSize,
      total: Number.isFinite(count) ? count : rows.length,
    });
  }

  const scanBatch = Math.min(150, pageSize * 12);
  /** @type {unknown[]} */
  const matched = [];
  let scanOffset = 0;
  let safety = 0;
  const skipBeforePage = (page - 1) * pageSize;

  while (matched.length < skipBeforePage + pageSize && safety++ < 40) {
    const { data: batch, error } = await buildQuery(false).range(scanOffset, scanOffset + scanBatch - 1);
    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    const evs = Array.isArray(batch) ? batch : [];
    if (evs.length === 0) break;

    const ids = evs.map((e) => String(e.id));
    const deliveries = await fetchDeliveriesBulk(supabase, uid, ids);
    const map = groupDeliveriesByEventId(deliveries);

    for (const ev of attachEventSummaries(evs, map)) {
      /** @type {{ derived_status?: string, summary?: { channels_used?: string[] } }} */
      const row = ev;
      if (deliveryStatus && row.derived_status !== deliveryStatus) continue;
      if (notificationChannel) {
        const chans = row.summary?.channels_used ?? [];
        const norm = Array.isArray(chans) ? chans.map((c) => String(c).toLowerCase()) : [];
        if (!norm.includes(notificationChannel)) continue;
      }
      matched.push(ev);
    }

    scanOffset += evs.length;
    if (evs.length < scanBatch) break;
  }

  const pageItems = matched.slice(skipBeforePage, skipBeforePage + pageSize);

  return res.status(200).json({
    ok: true,
    items: pageItems,
    page,
    page_size: pageSize,
    total: null,
    filtered_pagination: true,
    note:
      "Filtro por status de entrega e/ou canal: paginação por varredura — total exato omitido; avance page gradualmente.",
  });
}
