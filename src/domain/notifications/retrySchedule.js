// ============================================================
// Retry exponencial — delays entre tentativas falhas (Fase 2)
// Tentativa após falha 1 → +5min, 2 → +15min, 3 → +1h, 4 → +6h
// Total de até 5 envios; após a 5ª falha → failed permanente.
// ============================================================

/** Tentativas de envio no máximo (inclui a primeira). */
export const NOTIFICATION_DELIVERY_MAX_ATTEMPTS = 5;

const RETRY_DELAY_MS = Object.freeze([
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
]);

/**
 * @param {number} attemptsAfterThisFailure — valor de `attempts` após a tentativa que falhou
 * @returns {number | null} próximo delay em ms ou null se sem retry (failed permanente)
 */
export function calculateNotificationRetryDelayMs(attemptsAfterThisFailure) {
  const n = Number(attemptsAfterThisFailure);
  if (!Number.isFinite(n) || n < 1) return null;
  if (n >= NOTIFICATION_DELIVERY_MAX_ATTEMPTS) return null;
  const idx = n - 1;
  if (idx < 0 || idx >= RETRY_DELAY_MS.length) return null;
  return RETRY_DELAY_MS[idx];
}

/** Alias solicitado no prompt da Fase 2 */
export const calculateNotificationRetryDelay = calculateNotificationRetryDelayMs;
