// =============================================================================
// S7 — Canal WhatsApp (Fase S5.6) — histórico e rastreabilidade
// Backend como fonte de verdade: estrutura de correlação e resumo de entrega.
// =============================================================================

/** Campos de correlação esperados em metadata / provider_response. */
export const S7_WHATSAPP_TRACE_FIELDS = Object.freeze({
  EVENT_ID: "event_id",
  DISPATCH_ID: "dispatch_id",
  OUTBOX_ID: "outbox_id",
  SELLER_ID: "seller_id",
  RECIPIENT_ID: "recipient_id",
  CORRELATION_ID: "correlation_id",
  PROVIDER_MESSAGE_ID: "provider_message_id",
  MANUAL_RAYX_FLOW: "manual_sale_rayx_flow",
  LIVE_DESTINATION_SOURCE: "live_destination_source",
});

/**
 * Monta resumo de rastreio a partir de linhas já persistidas (read-model puro).
 * @param {{
 *   event_id?: string | null;
 *   dispatch_id?: string | null;
 *   outbox_id?: string | null;
 *   seller_id?: string | null;
 *   recipient_id?: string | null;
 *   correlation_id?: string | null;
 *   status?: string | null;
 *   provider?: string | null;
 *   provider_message_id?: string | null;
 *   attempt_count?: number | null;
 *   metadata?: Record<string, unknown> | null;
 * }} input
 */
export function buildWhatsAppDeliveryTraceSummary(input) {
  const meta = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  return {
    event_id: input.event_id ?? meta.event_id ?? null,
    dispatch_id: input.dispatch_id ?? null,
    outbox_id: input.outbox_id ?? null,
    seller_id: input.seller_id ?? null,
    recipient_id: input.recipient_id ?? meta.recipient_id ?? null,
    correlation_id: input.correlation_id ?? meta.correlation_id ?? null,
    status: input.status ?? null,
    provider: input.provider ?? meta.provider ?? null,
    provider_message_id: input.provider_message_id ?? null,
    attempt_count: input.attempt_count ?? null,
    audit_tables: {
      dispatches: "s7_notification_dispatches",
      outbox: "s7_notification_whatsapp_outbox",
      delivery_logs: "s7_notification_delivery_logs",
      events: "s7_notification_events",
    },
    log_prefix: "[S7_WHATSAPP]_",
  };
}
