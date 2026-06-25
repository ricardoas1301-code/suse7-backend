// ======================================================================
// Apresentação de assinatura ativa vs checkout pendente (status API)
// ======================================================================

import { SUBSCRIPTION_STATUS } from "../billingConstants.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const ACCESS_GRANTING = new Set([
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.INTERNAL_FREE,
  SUBSCRIPTION_STATUS.PAST_DUE,
]);

/**
 * @param {Array<Record<string, unknown>>} subscriptions
 * @param {string | null | undefined} accessSubscriptionId
 */
export function resolveSubscriptionPresentation(subscriptions, accessSubscriptionId) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];

  let activeSubscription =
    (accessSubscriptionId
      ? list.find((sub) => String(sub.id) === String(accessSubscriptionId))
      : null) ?? null;

  if (!activeSubscription) {
    activeSubscription =
      list.find((sub) => ACCESS_GRANTING.has(String(sub.status || "").toLowerCase())) ?? null;
  }

  let pendingCheckout = null;
  for (const sub of list) {
    const st = String(sub.status || "").toLowerCase();
    if (st !== SUBSCRIPTION_STATUS.PENDING) continue;
    pendingCheckout = {
      subscription_id: sub.id != null ? String(sub.id) : null,
      plan_key: asTrimmedString(sub.plan_key),
      plan_id: sub.plan_id != null ? String(sub.plan_id) : null,
      status: st,
      amount: sub.amount ?? null,
      next_due_date: asTrimmedString(sub.next_due_date),
      provider_subscription_id: asTrimmedString(sub.provider_subscription_id),
      payment_method:
        sub.metadata && typeof sub.metadata === "object"
          ? asTrimmedString(/** @type {{ payment_method?: unknown }} */ (sub.metadata).payment_method)
          : null,
    };
    break;
  }

  return {
    active_subscription: activeSubscription,
    pending_checkout: pendingCheckout,
    display_subscription: activeSubscription ?? pendingCheckout ?? list[0] ?? null,
  };
}
