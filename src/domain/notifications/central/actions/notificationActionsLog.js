// =============================================================================
// Logs — Notification Actions Engine (Fase 3.5C.1.A2)
// =============================================================================

const PREFIX = "[S7_ACTIONS]";

/**
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} [payload]
 */
export function logNotificationActions(eventSuffix, payload = {}) {
  console.info(`${PREFIX}_${eventSuffix}`, payload);
}
