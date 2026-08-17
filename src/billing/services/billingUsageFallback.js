// ======================================================================
// Fallback seguro de usage — subscription/status nunca derruba o app
// ======================================================================

import {
  addUtcMonthsKeepingAnchorDay,
  deriveInclusivePeriodEndBeforeNextBilling,
  startOfUtcDay,
} from "./billingCycleService.js";
import { SUBSCRIPTION_USAGE_AGGREGATION_SCOPE } from "./subscriptionUsageMeter.js";

export { SUBSCRIPTION_USAGE_AGGREGATION_SCOPE as BILLING_USAGE_AGGREGATION_SCOPE };

/**
 * @param {Date} [now]
 */
function getFallbackSubscriptionCycle(now = new Date()) {
  const anchor = startOfUtcDay(now);
  const nextBillingAt = addUtcMonthsKeepingAnchorDay(anchor, 1, anchor.getUTCDate());
  const periodEnd = deriveInclusivePeriodEndBeforeNextBilling(nextBillingAt);
  return {
    billing_cycle_anchor: anchor.toISOString(),
    current_period_start: anchor.toISOString(),
    current_period_end: periodEnd.toISOString(),
    next_billing_at: nextBillingAt.toISOString(),
    period_start: anchor.toISOString().slice(0, 10),
    period_end: periodEnd.toISOString().slice(0, 10),
    window_kind: "subscription_cycle",
  };
}

export function buildDefaultSellerBreakdowns() {
  return {
    marketplaces: {},
    companies: {},
    accounts: {},
    truncated: false,
  };
}

/**
 * @param {string | null | undefined} [reason]
 * @param {ReturnType<typeof getFallbackSubscriptionCycle> | null | undefined} [cycle]
 */
export function buildDefaultMonthlySalesUsageResolution(reason = null, cycle = null) {
  const window = cycle ?? getFallbackSubscriptionCycle();
  return {
    window_kind: window.window_kind,
    period_start: window.period_start,
    period_end: window.period_end,
    aggregation_scope: SUBSCRIPTION_USAGE_AGGREGATION_SCOPE,
    monthly_sales_limit: null,
    current_month_sales: 0,
    warning_threshold_percent: 80,
    grace_period_days: 0,
    hard_block_enabled: false,
    usage_percent: 0,
    near_limit: false,
    warning: false,
    exceeded: false,
    hard_blocked: false,
    grace_active: false,
    soft_block: false,
    freeze_level: "none",
    recommended_upgrade: false,
    ux_state: "unmetered",
    usage: {
      total_sales_month: 0,
      used_sales: 0,
      limit_sales_month: null,
      sales_limit: null,
      usage_percent: 0,
      near_limit: false,
      window_kind: window.window_kind,
      period_start: window.period_start,
      period_end: window.period_end,
      ux_state: "unmetered",
      grace_active: false,
      hard_blocked: false,
      soft_block: false,
      freeze_level: "none",
      aggregation_scope: SUBSCRIPTION_USAGE_AGGREGATION_SCOPE,
      usage_unit: "sale_order",
      usage_status: "unavailable",
    },
    breakdowns: buildDefaultSellerBreakdowns(),
    plan: null,
    fallback: true,
    fallback_reason: reason,
  };
}
