// ============================================================
// Helpers compartilhados — histórico de notificações (Fase 3)
// ============================================================

import {
  deriveNotificationEventStatus,
  summarizeDeliveries,
} from "../../domain/notifications/deriveNotificationEventStatus.js";

/**
 * @param {Array<{ notification_event_id?: string, status?: string, notification_channel?: string }>} rows
 * @returns {Map<string, Array<unknown>>}
 */
export function groupDeliveriesByEventId(rows) {
  /** @type {Map<string, Array<unknown>>} */
  const map = new Map();
  for (const row of rows ?? []) {
    const eid = row.notification_event_id != null ? String(row.notification_event_id) : "";
    if (!eid) continue;
    if (!map.has(eid)) map.set(eid, []);
    map.get(eid).push(row);
  }
  return map;
}

/**
 * @param {unknown[]} deliveries
 */
export function channelBreakdownForUi(deliveries) {
  const list = Array.isArray(deliveries) ? deliveries : [];
  /** @type {Record<string, { delivered: number, failed: number, pending: number }>} */
  const out = {
    app: { delivered: 0, failed: 0, pending: 0 },
    whatsapp: { delivered: 0, failed: 0, pending: 0 },
    email: { delivered: 0, failed: 0, pending: 0 },
  };

  for (const d of list) {
    const ch = String(d?.notification_channel ?? "").toLowerCase();
    if (!out[ch]) continue;
    const st = String(d?.status ?? "").toLowerCase();
    if (st === "delivered" || st === "sent") out[ch].delivered++;
    else if (st === "failed") out[ch].failed++;
    else if (st === "pending" || st === "processing") out[ch].pending++;
  }

  return out;
}

/**
 * Anexa resumo agregado a cada evento.
 * @param {unknown[]} events
 * @param {Map<string, unknown[]>} deliveryMap
 */
export function attachEventSummaries(events, deliveryMap) {
  return events.map((ev) => {
    /** @type {{ id?: string }} */
    const e = ev;
    const id = e?.id != null ? String(e.id) : "";
    const deliveries = deliveryMap.get(id) ?? [];
    const summary = summarizeDeliveries(deliveries);
    const derived_status = deriveNotificationEventStatus(deliveries);
    const channel_breakdown = channelBreakdownForUi(deliveries);
    return { ...e, summary, derived_status, channel_breakdown };
  });
}
