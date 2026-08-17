// =============================================================================
// S7 — Central Sininho (Fase S5.8) — rastreabilidade
// =============================================================================

import { S7_SININHO_INBOX_TABLE } from "./sininhoChannelContract.js";

export const S7_SININHO_TRACE_FIELDS = Object.freeze({
  EVENT_ID: "event_id",
  DISPATCH_ID: "dispatch_id",
  SELLER_ID: "seller_id",
  CORRELATION_ID: "correlation_id",
  CHANNEL: "channel",
  STATUS: "status",
  READ_AT: "read_at",
  DEEP_LINK: "deep_link",
});

/**
 * @param {Record<string, unknown>} input
 */
export function buildSininhoDeliveryTraceSummary(input = {}) {
  return {
    dispatch_id: input.id ?? input.dispatch_id ?? null,
    event_id: input.event_id ?? null,
    seller_id: input.seller_id ?? null,
    correlation_id: input.correlation_id ?? null,
    channel: input.channel ?? "in_app",
    status: input.status ?? null,
    provider_key: input.provider_key ?? "s7_in_app",
    read_at: input.read_at ?? null,
    deep_link: input.deep_link ?? null,
    audit_table: S7_SININHO_INBOX_TABLE,
    audit_filter: { channel: "in_app" },
    related_tables: {
      events: "s7_notification_events",
      delivery_logs: "s7_notification_delivery_logs",
    },
    log_prefix: "[S7_SININHO]_",
    legacy_log_prefix: "[S7_INAPP]_",
  };
}
