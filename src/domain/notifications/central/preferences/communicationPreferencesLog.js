// =============================================================================
// Logs formais S5.9 — [S7_COMMS_PREF]_*
// Fluxos legados mantêm logCentralNotification / logNotificationActions / logNotificationPref.
// =============================================================================

const PREFIX = "[S7_COMMS_PREF]";

/**
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} [payload]
 */
export function logCommunicationPreferences(eventSuffix, payload = {}) {
  console.info(`${PREFIX}_${eventSuffix}`, payload);
}
