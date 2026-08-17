// ======================================================================
// Identidade estável de forma de pagamento — abstração por provedor
// ======================================================================

/**
 * @param {unknown} providerKey
 * @param {unknown} providerResponse
 * @returns {{ provider: string; gatewayPaymentMethodId: string } | null}
 */
export function resolveStablePaymentMethodIdentity(providerKey, providerResponse) {
  const provider = String(providerKey || "unknown").trim().toLowerCase();
  const row =
    providerResponse && typeof providerResponse === "object"
      ? /** @type {Record<string, unknown>} */ (providerResponse)
      : null;
  if (!row) return null;

  if (provider === "asaas") {
    const token =
      typeof row.creditCardToken === "string"
        ? row.creditCardToken.trim()
        : typeof row.credit_card_token === "string"
          ? row.credit_card_token.trim()
          : null;
    if (token) {
      return { provider: "asaas", gatewayPaymentMethodId: token };
    }
  }

  return null;
}

/**
 * @param {unknown} error
 */
export function isPaymentMethodUniqueViolation(error) {
  const code = String(/** @type {{ code?: string }} */ (error)?.code ?? "");
  if (code !== "23505") return false;
  const message = String(/** @type {{ message?: string }} */ (error)?.message ?? "").toLowerCase();
  return (
    message.includes("billing_payment_methods_gateway_token_uidx") ||
    message.includes("gateway_payment_method_id")
  );
}

/**
 * @param {string} [message]
 */
export function buildPaymentMethodAlreadyExistsError(message) {
  const err = new Error(message || "Este cartão já está cadastrado.");
  /** @type {any} */ (err).code = "PAYMENT_METHOD_ALREADY_EXISTS";
  return err;
}
