// =============================================================================
// Logs formais S5.10 — [S7_MOTOR_OBS]_*
// Não substitui logCentralNotification nem logs por canal.
// =============================================================================

const PREFIX = "[S7_MOTOR_OBS]";

/**
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} [payload]
 */
export function logMotorObservability(eventSuffix, payload = {}) {
  console.info(`${PREFIX}_${eventSuffix}`, payload);
}
