// ======================================================================
// Asaas — normalização de payload webhook → evento interno
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

/** @type {Set<string>} */
export const SUPPORTED_ASAAS_SUBSCRIPTION_EVENTS = new Set([
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_DELETED",
  "SUBSCRIPTION_INACTIVATED",
]);

/** @type {Set<string>} */
export const SUPPORTED_ASAAS_EVENTS = new Set([...SUPPORTED_ASAAS_PAYMENT_EVENTS, ...SUPPORTED_ASAAS_SUBSCRIPTION_EVENTS]);

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function extractNestedId(value) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  const obj = asObject(value);
  return obj ? asTrimmedString(obj.id) : null;
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {string | null}
 */
function deriveProviderEventId(raw) {
  const rootId = asTrimmedString(raw.id);
  const eventType = asTrimmedString(raw.event);
  const payment = asObject(raw.payment);
  const subscription = asObject(raw.subscription);
  const paymentId = payment ? asTrimmedString(payment.id) : null;
  const subscriptionId = subscription ? asTrimmedString(subscription.id) : null;

  if (rootId) return rootId;
  if (eventType && paymentId) return `${eventType}:${paymentId}`;
  if (eventType && subscriptionId) return `${eventType}:${subscriptionId}`;
  return paymentId || subscriptionId;
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {{
 *   supported: boolean;
 *   kind: "payment" | "subscription" | "unknown";
 *   eventType: string | null;
 *   payment: Record<string, unknown> | null;
 *   paymentId: string | null;
 *   subscription: Record<string, unknown> | null;
 *   subscriptionId: string | null;
 *   providerEventId: string | null;
 * }}
 */
export function normalizeAsaasWebhook(raw) {
  const eventType = asTrimmedString(raw.event);
  const payment = asObject(raw.payment);
  const subscription = asObject(raw.subscription);
  const paymentId = payment ? asTrimmedString(payment.id) : null;
  const subscriptionId =
    (payment ? extractNestedId(payment.subscription) : null) || (subscription ? asTrimmedString(subscription.id) : null);
  const providerEventId = deriveProviderEventId(raw);

  let kind = /** @type {"payment" | "subscription" | "unknown"} */ ("unknown");
  if (eventType && SUPPORTED_ASAAS_PAYMENT_EVENTS.has(eventType)) kind = "payment";
  else if (eventType && SUPPORTED_ASAAS_SUBSCRIPTION_EVENTS.has(eventType)) kind = "subscription";

  const supported = Boolean(eventType && SUPPORTED_ASAAS_EVENTS.has(eventType));

  return {
    supported,
    kind,
    eventType,
    payment,
    paymentId,
    subscription,
    subscriptionId,
    providerEventId,
  };
}
