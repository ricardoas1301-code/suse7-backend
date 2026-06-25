// ======================================================================
// Sanitização — nunca logar/persistir dados sensíveis de cartão
// ======================================================================

const SENSITIVE_KEYS = new Set([
  "card_number",
  "cardNumber",
  "number",
  "ccv",
  "cvv",
  "creditCard",
  "credit_card",
]);

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} payload
 */
export function sanitizeBillingCardPayload(payload) {
  const row = asObject(payload);
  if (!row) return {};

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    if (key === "creditCard" || key === "creditCardHolderInfo") {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {string | null | undefined} cardNumber
 */
export function maskCardNumberForLog(cardNumber) {
  const digits = String(cardNumber ?? "").replace(/\D/g, "");
  if (digits.length < 4) return null;
  return `****${digits.slice(-4)}`;
}
