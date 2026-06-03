// =============================================================================
// Logs estruturados — [S7_POPUP]_* (Fase S5.7)
// =============================================================================

const PREFIX = "[S7_POPUP]";

/**
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} [payload]
 */
export function logPopupNotification(eventSuffix, payload = {}) {
  console.info(`${PREFIX}_${eventSuffix}`, payload);
}
