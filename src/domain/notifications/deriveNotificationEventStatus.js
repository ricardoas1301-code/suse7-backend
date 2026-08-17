// ============================================================
// Status agregado de um evento a partir das deliveries (Fase 3)
// Prioridade alinhada ao prompt: processing → pending → outcomes finais
// ============================================================

/** @typedef {'pending'|'processing'|'delivered'|'failed'|'partial'|'cancelled'} DerivedEventStatus */

/**
 * @param {Array<{ status?: string | null }>} deliveries
 * @returns {DerivedEventStatus}
 */
export function deriveNotificationEventStatus(deliveries) {
  const list = Array.isArray(deliveries) ? deliveries : [];
  if (list.length === 0) return "pending";

  /** @type {Record<string, number>} */
  const c = { pending: 0, processing: 0, sent: 0, delivered: 0, failed: 0, cancelled: 0 };
  for (const d of list) {
    const s = String(d?.status ?? "").trim().toLowerCase();
    if (s in c) c[s]++;
    else c.pending++;
  }

  const total = list.length;
  const okCount = c.delivered + c.sent;

  if (c.processing > 0) return "processing";
  if (c.pending > 0) return "pending";

  if (c.cancelled === total) return "cancelled";
  if (okCount === total) return "delivered";
  if (c.failed === total) return "failed";
  if (okCount > 0 && c.failed > 0) return "partial";
  if (okCount > 0 && c.cancelled > 0) return "partial";
  if (c.failed > 0 && c.cancelled > 0) return "partial";

  return "partial";
}

/**
 * Contagens por status + canais distintos (histórico / cards).
 * @param {Array<{ status?: string | null, notification_channel?: string | null }>} deliveries
 */
export function summarizeDeliveries(deliveries) {
  const list = Array.isArray(deliveries) ? deliveries : [];
  /** @type {Record<string, number>} */
  const byStatus = {};
  /** @type {Set<string>} */
  const channels = new Set();

  for (const d of list) {
    const st = String(d?.status ?? "unknown").trim().toLowerCase();
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    const ch = String(d?.notification_channel ?? "").trim().toLowerCase();
    if (ch) channels.add(ch);
  }

  return {
    total_deliveries: list.length,
    pending_count: byStatus.pending ?? 0,
    processing_count: byStatus.processing ?? 0,
    delivered_count: (byStatus.delivered ?? 0) + (byStatus.sent ?? 0),
    failed_count: byStatus.failed ?? 0,
    cancelled_count: byStatus.cancelled ?? 0,
    channels_used: [...channels],
    by_status: byStatus,
  };
}
