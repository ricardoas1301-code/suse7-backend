// ======================================================================
// Tempo acelerado DEV — 1 minuto = 1 dia simulado (somente com env explícita)
// ======================================================================

const MS_PER_REAL_DAY = 24 * 60 * 60 * 1000;
const MS_PER_SIM_DAY = 60 * 1000;

/**
 * Ativo apenas quando BILLING_RENEWAL_TEST_ACCELERATED=1 (DEV).
 */
export function isBillingRenewalTestAccelerated() {
  const raw = String(process.env.BILLING_RENEWAL_TEST_ACCELERATED || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Milissegundos equivalentes a um "dia" na simulação.
 */
export function getSimulatedDayMs() {
  return isBillingRenewalTestAccelerated() ? MS_PER_SIM_DAY : MS_PER_REAL_DAY;
}

/**
 * Dias até o vencimento (ou negativo se vencido). Em modo teste: minutos → dias simulados.
 *
 * @param {unknown} renewalDueDate
 * @param {Date} [now]
 */
export function daysUntilRenewalDueSimulated(renewalDueDate, now = new Date()) {
  const due = renewalDueDate ? new Date(String(renewalDueDate)) : null;
  if (!due || Number.isNaN(due.getTime())) return null;
  return Math.ceil((due.getTime() - now.getTime()) / getSimulatedDayMs());
}
