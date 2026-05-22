// =============================================================================
// Logs estruturados — [S7_IN_APP]_* (Fase 3.3)
// =============================================================================

const PREFIX = "[S7_IN_APP]";

/**
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} [payload]
 */
export function logInAppNotification(eventSuffix, payload = {}) {
  console.info(`${PREFIX}_${eventSuffix}`, payload);
}
