// =============================================================================
// Logs formais S5.11 — [S7_NOTIFICATION_CATALOG]_*
// =============================================================================

const PREFIX = "[S7_NOTIFICATION_CATALOG]";

/**
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} [payload]
 */
export function logNotificationCatalog(eventSuffix, payload = {}) {
  console.info(`${PREFIX}_${eventSuffix}`, payload);
}
