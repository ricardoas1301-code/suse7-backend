// =============================================================================
// Logs estruturados — Central Sininho (Fase S5.8)
// Reutiliza prefixo legado [S7_INAPP]_ sem alterar comportamento.
// =============================================================================

const SININHO_PREFIX = "[S7_SININHO]";

/**
 * Logs formais S5.8 (prefixo dedicado). Fluxo legado continua em logInAppNotification.
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} [payload]
 */
export function logSininhoNotification(eventSuffix, payload = {}) {
  console.info(`${SININHO_PREFIX}_${eventSuffix}`, payload);
}
