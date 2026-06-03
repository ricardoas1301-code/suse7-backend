// =============================================================================
// Tipos e status — Notification Actions Engine (Fase 3.5C.1.A2)
// =============================================================================

import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";

export const NOTIFICATION_ACTION_STATUS = Object.freeze({
  PLANNED: "planned",
  QUEUED: "queued",
  SENT: "sent",
  FAILED: "failed",
  SKIPPED: "skipped",
});

/** Canais suportados pelo actions engine nesta fase. */
export const NOTIFICATION_ACTION_CHANNELS = Object.freeze({
  IN_APP: S7_NOTIFICATION_CHANNEL.IN_APP,
  EMAIL: S7_NOTIFICATION_CHANNEL.EMAIL,
  WHATSAPP: S7_NOTIFICATION_CHANNEL.WHATSAPP,
});

/**
 * @typedef {Object} NotificationActionsEngineInput
 * @property {string} seller_id
 * @property {string} event_type
 * @property {string} category_key
 * @property {string} [severity]
 * @property {Record<string, unknown>} [payload]
 * @property {Record<string, unknown>} [metadata]
 * @property {string} [correlation_id]
 * @property {string} [event_id]
 * @property {string} [marketplace_account_id]
 * @property {string} [entity_type]
 * @property {string} [entity_id]
 * @property {string} [source_module]
 */

/**
 * @typedef {Object} PlannedNotificationAction
 * @property {string} seller_id
 * @property {string} channel
 * @property {string | null} recipient_id
 * @property {string | null} recipient_contact
 * @property {string} template_key
 * @property {{ subject: string; body: string; variables: Record<string, unknown> }} message_payload
 * @property {string} status
 * @property {Record<string, unknown>} metadata
 * @property {string} [slot_key]
 * @property {string} [skip_reason]
 */

/**
 * @param {unknown} input
 * @returns {NotificationActionsEngineInput}
 */
export function normalizeActionsEngineInput(input) {
  const row = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};
  return {
    seller_id: String(row.seller_id ?? "").trim(),
    event_type: String(row.event_type ?? row.type_key ?? "").trim(),
    category_key: String(row.category_key ?? row.category ?? row.category_code ?? "").trim(),
    severity: row.severity != null ? String(row.severity) : undefined,
    payload:
      row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? /** @type {Record<string, unknown>} */ (row.payload)
        : {},
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? /** @type {Record<string, unknown>} */ (row.metadata)
        : {},
    correlation_id: row.correlation_id != null ? String(row.correlation_id) : null,
    event_id: row.event_id != null ? String(row.event_id) : null,
    marketplace_account_id:
      row.marketplace_account_id != null ? String(row.marketplace_account_id) : null,
    entity_type: row.entity_type != null ? String(row.entity_type) : null,
    entity_id: row.entity_id != null ? String(row.entity_id) : null,
    source_module: row.source_module != null ? String(row.source_module) : null,
  };
}

/**
 * @param {Record<string, unknown>} event
 * @returns {NotificationActionsEngineInput}
 */
export function actionsInputFromPersistedEvent(event) {
  return normalizeActionsEngineInput({
    seller_id: event.seller_id,
    event_type: event.type_key,
    category_key: event.category_code,
    severity: event.severity,
    payload: event.payload,
    // S5.1/S5.2: propaga a metadata padronizada do Contrato Global (antes era {}).
    metadata: event.metadata,
    correlation_id: event.correlation_id,
    event_id: event.id,
    marketplace_account_id: event.marketplace_account_id,
    entity_type: event.entity_type,
    entity_id: event.entity_id,
    source_module: event.source_module,
  });
}
