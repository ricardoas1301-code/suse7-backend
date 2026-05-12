// ======================================================================
// billingConstants.js — contratos estáveis (sem segredos)
// ======================================================================

/** Métodos aceitos no checkout; cartão só quando houver tokenização (BILLING 04). */
export const CHECKOUT_PAYMENT_METHODS = /** @type {const} */ (["BOLETO", "PIX", "CREDIT_CARD"]);

/** Status persistidos em `billing_subscriptions.status`. */
export const SUBSCRIPTION_STATUS = /** @type {const} */ ({
  PENDING: "pending",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  REFUNDED: "refunded",
  INTERNAL_FREE: "internal_free",
});

/** Status que são encerrados ao iniciar novo checkout. */
export const SUBSCRIPTION_STATUS_SUPERSEDED = [
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.PENDING,
  SUBSCRIPTION_STATUS.PAST_DUE,
  SUBSCRIPTION_STATUS.INTERNAL_FREE,
];
