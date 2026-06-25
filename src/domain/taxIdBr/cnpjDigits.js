// ======================================================================
// CNPJ (BR) — apenas dígitos + validação de dígitos verificadores.
// ======================================================================

/**
 * @param {string | null | undefined} raw
 * @returns {string} até 14 dígitos
 */
export function normalizeCnpjDigits(raw) {
  return String(raw ?? "").replace(/\D/g, "").slice(0, 14);
}

/**
 * @param {string} digits14 — exatamente 14 dígitos
 * @returns {boolean}
 */
export function isValidCnpjCheckDigits(cnpj14) {
  if (!/^\d{14}$/.test(cnpj14) || /^(\d)\1+$/.test(cnpj14)) return false;
  let length = 12;
  let numbers = cnpj14.substring(0, length);
  const digits = cnpj14.substring(length);
  let sum = 0;
  let pos = length - 7;
  for (let i = length; i >= 1; i--) {
    sum += parseInt(numbers.charAt(length - i), 10) * pos;
    pos -= 1;
    if (pos < 2) pos = 9;
  }
  let result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  if (result !== parseInt(digits.charAt(0), 10)) return false;
  length = 13;
  numbers = cnpj14.substring(0, length);
  sum = 0;
  pos = length - 7;
  for (let i = length; i >= 1; i--) {
    sum += parseInt(numbers.charAt(length - i), 10) * pos;
    pos -= 1;
    if (pos < 2) pos = 9;
  }
  result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
  return result === parseInt(digits.charAt(1), 10);
}

/**
 * @param {string | null | undefined} raw
 * @returns {boolean}
 */
export function isValidCnpjInput(raw) {
  const d = normalizeCnpjDigits(raw);
  return d.length === 14 && isValidCnpjCheckDigits(d);
}
