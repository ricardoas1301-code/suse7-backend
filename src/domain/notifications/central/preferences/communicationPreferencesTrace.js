// =============================================================================
// S7 — Preferências de Comunicação (Fase S5.9) — rastreabilidade
// =============================================================================

export const S7_COMMUNICATION_PREF_TRACE_FIELDS = Object.freeze({
  SELLER_ID: "seller_id",
  CATEGORY: "category",
  TYPE: "type",
  MANDATORY: "mandatory",
  ENABLED_CHANNELS: "enabled_channels",
  RECIPIENT_COUNT: "recipient_count",
  CHANNEL: "channel",
});

/**
 * @param {Record<string, unknown>} input
 */
export function buildCommunicationPreferencesTraceSummary(input = {}) {
  return {
    seller_id: input.seller_id ?? null,
    category: input.category ?? null,
    type: input.type ?? null,
    mandatory: input.mandatory ?? null,
    enabled_channels: input.enabled_channels ?? input.enabledChannels ?? null,
    recipient_count: input.recipient_count ?? null,
    channel: input.channel ?? null,
    tables: {
      preferences: "s7_notification_preferences",
      recipients: "s7_notification_recipients",
      event_rules: "s7_notification_event_delivery_rules",
    },
    log_prefix: "[S7_COMMS_PREF]_",
    legacy_log_prefixes: ["[S7_NOTIFICATION]_PREFERENCES_RESOLVED", "[S7_ACTIONS]_PREFERENCES_RESOLVED"],
  };
}
