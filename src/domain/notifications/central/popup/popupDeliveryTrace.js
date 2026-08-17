// =============================================================================
// S7 — Canal Pop-up (Fase S5.7) — rastreabilidade
// =============================================================================

import { S7_POPUP_DELIVERIES_TABLE } from "./popupChannelContract.js";

export const S7_POPUP_TRACE_FIELDS = Object.freeze({
  EVENT_ID: "event_id",
  DISPATCH_ID: "dispatch_id",
  DELIVERY_ID: "delivery_id",
  SELLER_ID: "seller_id",
  DISPLAY_TYPE: "display_type",
  DISPLAY_MODE: "display_mode",
  STATUS: "status",
  DISPLAYED_AT: "displayed_at",
  READ_AT: "read_at",
  DISMISSED_AT: "dismissed_at",
});

/**
 * @param {Record<string, unknown>} input
 */
export function buildPopupDeliveryTraceSummary(input = {}) {
  return {
    delivery_id: input.id ?? input.delivery_id ?? null,
    event_id: input.event_id ?? null,
    dispatch_id: input.dispatch_id ?? null,
    seller_id: input.seller_id ?? null,
    display_type: input.display_type ?? null,
    display_mode: input.display_mode ?? null,
    status: input.status ?? null,
    priority: input.priority ?? null,
    displayed_at: input.displayed_at ?? null,
    read_at: input.read_at ?? null,
    dismissed_at: input.dismissed_at ?? null,
    expires_at: input.expires_at ?? null,
    audit_table: S7_POPUP_DELIVERIES_TABLE,
    related_tables: {
      events: "s7_notification_events",
      dispatches: "s7_notification_dispatches",
      delivery_logs: "s7_notification_delivery_logs",
    },
    log_prefix: "[S7_POPUP]_",
  };
}
