// ======================================================================
// Guards de checkout — métodos desabilitados no MVP
// ======================================================================

export const DEBIT_CARD_CHECKOUT_NOT_SUPPORTED_MESSAGE =
  "Cartão de débito não está disponível neste checkout. Use Pix, boleto ou cartão de crédito.";

/**
 * @param {unknown} paymentMethod
 * @param {unknown} [cardType]
 */
export function isDebitCardCheckoutRequested(paymentMethod, cardType) {
  const pm = String(paymentMethod || "")
    .trim()
    .toUpperCase();
  if (pm === "DEBIT_CARD" || pm === "DEBIT") return true;
  const ct = String(cardType || "")
    .trim()
    .toLowerCase();
  return ct === "debit";
}

/**
 * @param {unknown} paymentMethod
 * @param {unknown} [cardType]
 */
export function assertCreditCardCheckoutOnly(paymentMethod, cardType) {
  if (!isDebitCardCheckoutRequested(paymentMethod, cardType)) return;
  const err = new Error(DEBIT_CARD_CHECKOUT_NOT_SUPPORTED_MESSAGE);
  /** @type {any} */ (err).code = "DEBIT_CARD_NOT_SUPPORTED";
  throw err;
}
