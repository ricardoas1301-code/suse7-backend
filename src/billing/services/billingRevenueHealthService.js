// ======================================================================
// Revenue Health Engine — classificação de risco financeiro (Fase 3.0)
// ======================================================================

import { DELINQUENCY_STATUS, RENEWAL_STATUS, SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { logBilling } from "../billingLog.js";
import { REVENUE_HEALTH_LEVEL, BILLING_PHASE30_LOG } from "../billingPhase30Constants.js";
import { listOpenRenewalCyclesForSubscription } from "./billingRenewalCycleConsistencyService.js";
import { pickActiveSubscription, listUserBillingSubscriptions } from "./billingSubscriptionQueryService.js";

/**
 * @param {Record<string, unknown> | null | undefined} subscription
 */
function readDelinquency(subscription) {
  const meta =
    subscription?.metadata && typeof subscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (subscription.metadata)
      : {};
  return String(meta.delinquency_status ?? DELINQUENCY_STATUS.NONE).toLowerCase();
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ subscription?: Record<string, unknown> | null; persist?: boolean }} [options]
 */
export async function computeRevenueHealthForUser(supabase, userId, options = {}) {
  const subscriptions =
    options.subscription != null
      ? [options.subscription]
      : await listUserBillingSubscriptions(supabase, userId);

  const active = pickActiveSubscription(subscriptions) ?? subscriptions[0] ?? null;
  const subscriptionId = active?.id != null ? String(active.id) : null;
  const status = String(active?.status ?? "").toLowerCase();
  const delinquency = readDelinquency(active);

  let openCycle = null;
  if (subscriptionId) {
    const open = await listOpenRenewalCyclesForSubscription(supabase, subscriptionId);
    openCycle = open[0] ?? null;
  }

  const renewalStatus = openCycle ? String(openCycle.renewal_status) : null;

  /** @type {string[]} */
  const factors = [];
  let score = 100;
  let healthLevel = REVENUE_HEALTH_LEVEL.HEALTHY;

  if (delinquency === DELINQUENCY_STATUS.SUSPENDED || status === SUBSCRIPTION_STATUS.PAST_DUE) {
    healthLevel = REVENUE_HEALTH_LEVEL.CRITICAL;
    score = 10;
    factors.push("subscription_past_due_or_suspended");
  } else if (delinquency === DELINQUENCY_STATUS.GRACE || renewalStatus === RENEWAL_STATUS.GRACE_PERIOD) {
    healthLevel = REVENUE_HEALTH_LEVEL.RISK;
    score = 35;
    factors.push("grace_period_active");
  } else if (
    renewalStatus === RENEWAL_STATUS.PAYMENT_FAILED ||
    renewalStatus === RENEWAL_STATUS.PENDING_PAYMENT
  ) {
    healthLevel = REVENUE_HEALTH_LEVEL.WARNING;
    score = 55;
    factors.push("renewal_payment_pending_or_failed");
  } else if (renewalStatus === RENEWAL_STATUS.PRE_RENEWAL || renewalStatus === RENEWAL_STATUS.SCHEDULED) {
    healthLevel = REVENUE_HEALTH_LEVEL.HEALTHY;
    score = 85;
    factors.push("renewal_window_open");
  }

  const { count: failedPayments } = await supabase
    .from("billing_payments")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["failed", "overdue", "REFUNDED"])
    .gte("created_at", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString());

  if ((failedPayments ?? 0) >= 3 && healthLevel === REVENUE_HEALTH_LEVEL.HEALTHY) {
    healthLevel = REVENUE_HEALTH_LEVEL.WARNING;
    score = Math.min(score, 60);
    factors.push("recurring_payment_failures_90d");
  }

  const result = {
    health_level: healthLevel,
    health_score: score,
    factors,
    subscription_id: subscriptionId,
    subscription_status: status || null,
    delinquency_status: delinquency,
    renewal_status: renewalStatus,
    open_renewal_cycle_id: openCycle?.id ?? null,
    computed_at: new Date().toISOString(),
  };

  if (options.persist !== false) {
    await supabase.from("billing_revenue_health_snapshots").insert({
      user_id: userId,
      health_level: healthLevel,
      health_score: score,
      factors,
      subscription_id: subscriptionId,
      computed_at: result.computed_at,
    });
  }

  logBilling("billing", BILLING_PHASE30_LOG.REVENUE_HEALTH_COMPUTED, {
    user_id: userId,
    health_level: healthLevel,
    health_score: score,
    factors,
  });

  return result;
}
