// ======================================================================
// CEP do titular — normalização e validação antes do Asaas
// ======================================================================

import { logBilling } from "../billingLog.js";

export const INVALID_CARD_HOLDER_POSTAL_CODE_MESSAGE =
  "CEP do titular do cartão inválido. Atualize o endereço de cobrança antes de pagar com cartão.";

/**
 * @param {unknown} value
 */
export function onlyDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * @param {unknown} rawPostalCode
 * @returns {string | null} 8 dígitos ou null se inválido
 */
export function normalizeCardHolderPostalCode(rawPostalCode) {
  const digits = onlyDigits(rawPostalCode);
  return digits.length === 8 ? digits : null;
}

/**
 * @param {unknown} rawPostalCode
 * @param {{
 *   user_id?: string;
 *   plan_key?: string;
 *   card_type?: string;
 *   request_id?: string;
 * }} [audit]
 * @returns {string}
 */
export function assertValidCardHolderPostalCode(rawPostalCode, audit = {}) {
  const digits = onlyDigits(rawPostalCode);
  const hasPostalCode = digits.length > 0;

  if (digits.length !== 8) {
    logBilling("billing", "BILLING_CARD_HOLDER_INFO_INVALID", {
      user_id: audit.user_id ?? undefined,
      plan_key: audit.plan_key ?? undefined,
      card_type: audit.card_type ?? undefined,
      reason: "invalid_postal_code",
      postal_code_length: digits.length,
      has_postal_code: hasPostalCode,
      postal_code_source: audit.postal_code_source ?? null,
      request_id: audit.request_id ?? undefined,
    });

    const err = new Error(INVALID_CARD_HOLDER_POSTAL_CODE_MESSAGE);
    /** @type {any} */ (err).code = "INVALID_CARD_HOLDER_POSTAL_CODE";
    throw err;
  }

  return digits;
}
