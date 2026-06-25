// ======================================================================
// Estratégia de renovação — plano atual da assinatura (nunca catálogo)
// ======================================================================

import { RENEWAL_STRATEGY } from "../billingConstants.js";
import { listSellerPaymentMethods } from "./billingPaymentMethodsService.js";
import { normalizeCheckoutPaymentMethod } from "./billingSubscriptionService.js";

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * @param {Record<string, unknown>} subscription
 */
function readSubscriptionPaymentMethod(subscription) {
  const meta = asObject(subscription.metadata);
  return normalizeCheckoutPaymentMethod(meta.payment_method);
}

/**
 * @param {Record<string, unknown>} subscription
 */
function isAutoRenewEnabled(subscription) {
  const meta = asObject(subscription.metadata);
  if (meta.auto_renew === false) return false;
  return true;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 */
export async function resolveRenewalStrategyForSubscription(supabase, subscription) {
  const userId = String(subscription.user_id);
  const paymentMethod = readSubscriptionPaymentMethod(subscription);
  const methods = await listSellerPaymentMethods(supabase, userId);
  const defaultCard = methods.find((m) => m.is_default && m.supports_auto_renew && m.card_type === "CREDIT");

  if (defaultCard && isAutoRenewEnabled(subscription) && paymentMethod === "CREDIT_CARD") {
    return {
      strategy: RENEWAL_STRATEGY.AUTO_CARD,
      payment_method: "CREDIT_CARD",
      default_payment_method_id: defaultCard.id,
    };
  }

  if (paymentMethod === "PIX") {
    return { strategy: RENEWAL_STRATEGY.MANUAL_PIX, payment_method: "PIX", default_payment_method_id: null };
  }
  if (paymentMethod === "BOLETO") {
    return { strategy: RENEWAL_STRATEGY.MANUAL_BOLETO, payment_method: "BOLETO", default_payment_method_id: null };
  }
  if (paymentMethod === "CREDIT_CARD") {
    return { strategy: RENEWAL_STRATEGY.MANUAL_CARD, payment_method: "CREDIT_CARD", default_payment_method_id: defaultCard?.id ?? null };
  }

  return { strategy: RENEWAL_STRATEGY.HYBRID, payment_method: paymentMethod, default_payment_method_id: defaultCard?.id ?? null };
}
