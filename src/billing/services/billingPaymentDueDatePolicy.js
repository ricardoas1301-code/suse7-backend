// ======================================================================
// Política temporária de vencimento/expiração de cobrança manual
// ======================================================================

import { formatBillingCivilDateInSaoPaulo } from "./billingCycleService.js";

/**
 * @param {unknown} value
 */
function asDateOnly(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const civil = formatBillingCivilDateInSaoPaulo(raw);
  return civil;
}

/**
 * Resolve vencimento/expiração apresentável para cobrança manual de renovação.
 * Política definitiva (carência) será configurada na trilha completa de assinaturas.
 *
 * @param {{
 *   cycleDueDate?: unknown;
 *   paymentMethod?: string | null;
 *   now?: Date;
 * }} input
 */
export function resolveRenewalChargeDueDatePolicy(input) {
  const now = input.now instanceof Date ? input.now : new Date();
  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const cycleDue = asDateOnly(input.cycleDueDate);
  const dueDate = cycleDue && civilNow && cycleDue >= civilNow ? cycleDue : civilNow ?? cycleDue;

  return {
    due_date: dueDate,
    expires_at: dueDate ? `${dueDate}T23:59:59.999-03:00` : null,
    policy_version: "block_b_temporary",
    payment_method: input.paymentMethod ?? null,
  };
}
