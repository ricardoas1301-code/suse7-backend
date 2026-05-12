// ======================================================================
// Normalização de payload webhook Asaas → evento interno
// ======================================================================

/** @type {Set<string>} */
export const SUPPORTED_ASAAS_PAYMENT_EVENTS = new Set([
  "PAYMENT_CREATED",
  "PAYMENT_UPDATED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_OVERDUE",
  "PAYMENT_DELETED",
  "PAYMENT_REFUNDED",
  "PAYMENT_BANK_SLIP_VIEWED",
  "PAYMENT_CHECKOUT_VIEWED",
]);

/**
 * @param {Record<string, unknown>} raw
 * @returns {{
 *   supported: boolean;
 *   eventType: string | null;
 *   payment: Record<string, unknown> | null;
 *   paymentId: string | null;
 *   subscriptionId: string | null;
 *   providerEventId: string | null;
 * }}
 */
export function normalizeAsaasWebhook(raw) {
  const eventType = typeof raw.event === "string" ? raw.event.trim() : null;
  const payment =
    raw.payment && typeof raw.payment === "object" && !Array.isArray(raw.payment)
      ? /** @type {Record<string, unknown>} */ (raw.payment)
      : null;
  const paymentId =
    payment && typeof payment.id === "string" && payment.id.trim() !== "" ? payment.id.trim() : null;
  const subscriptionRaw = payment?.subscription;
  const subscriptionId =
    typeof subscriptionRaw === "string" && subscriptionRaw.trim() !== ""
      ? subscriptionRaw.trim()
      : subscriptionRaw && typeof subscriptionRaw === "object" && !Array.isArray(subscriptionRaw)
        ? typeof /** @type {{ id?: unknown }} */ (subscriptionRaw).id === "string"
          ? String(/** @type {{ id?: string }} */ (subscriptionRaw).id).trim()
          : null
        : null;

  const rootId = typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id.trim() : null;
  const providerEventId =
    rootId || (eventType && paymentId ? `${eventType}:${paymentId}` : paymentId || rootId || null);

  const supported = Boolean(eventType && SUPPORTED_ASAAS_PAYMENT_EVENTS.has(eventType));

  return {
    supported,
    eventType,
    payment,
    paymentId,
    subscriptionId,
    providerEventId,
  };
}
