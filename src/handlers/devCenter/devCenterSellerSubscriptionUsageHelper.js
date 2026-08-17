import { resolveSellerBillingCycle } from "../../billing/services/billingCycleService.js";
import { resolveMonthlySalesUsage } from "../../billing/services/billingUsageService.js";
import { DEV_CENTER_TOOLBOX_METADATA_KEYS } from "./devCenterToolboxOperationalConstants.js";

/**
 * @param {Record<string, unknown> | null | undefined} sub
 */
function readSubscriptionMeta(sub) {
  return sub?.metadata && typeof sub.metadata === "object"
    ? /** @type {Record<string, unknown>} */ (sub.metadata)
    : {};
}

/**
 * @param {number | null | undefined} current
 * @param {number | null | undefined} limit
 */
function computeUsagePercent(current, limit) {
  const used = Number(current);
  const cap = Number(limit);
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
  return Math.round((used / cap) * 1000) / 10;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {Record<string, unknown> | null | undefined} subscription
 */
export async function buildDevCenterSellerSubscriptionUsageBlock(supabase, sellerId, subscription) {
  if (!subscription) return null;

  const meta = readSubscriptionMeta(subscription);
  const extraBonus = Number(meta[DEV_CENTER_TOOLBOX_METADATA_KEYS.EXTRA_SALES_BONUS]) || 0;

  try {
    const cycle = await resolveSellerBillingCycle(supabase, sellerId);
    const usage = await resolveMonthlySalesUsage(
      supabase,
      sellerId,
      subscription.plan_id != null ? String(subscription.plan_id) : null,
      cycle.cycle,
    );

    const baseLimit = usage.monthly_sales_limit ?? null;
    const effectiveLimit =
      baseLimit != null && Number.isFinite(baseLimit) ? baseLimit + extraBonus : baseLimit;
    const current = usage.current_month_sales ?? 0;

    return {
      current,
      limit: effectiveLimit,
      base_limit: baseLimit,
      extra_sales_bonus: extraBonus,
      percent: computeUsagePercent(current, effectiveLimit),
      near_limit: Boolean(usage.near_limit),
      exceeded: Boolean(usage.exceeded),
      period_start: usage.period_start ?? cycle.cycle.period_start ?? null,
      period_end: usage.period_end ?? cycle.cycle.period_end ?? null,
      recalculated_at: meta[DEV_CENTER_TOOLBOX_METADATA_KEYS.USAGE_RECALCULATED_AT] ?? null,
      reset_at: meta[DEV_CENTER_TOOLBOX_METADATA_KEYS.USAGE_RESET_AT] ?? null,
      previous_consumed: null,
    };
  } catch (error) {
    console.warn("[dev-center-sellers] subscription_usage_failed", {
      sellerId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * @param {Record<string, unknown> | null | undefined} subscription
 * @param {Awaited<ReturnType<typeof buildDevCenterSellerSubscriptionUsageBlock>>} usageBlock
 */
export function enrichDevCenterSellerSubscriptionBlock(subscription, usageBlock) {
  if (!subscription) return null;

  const meta = readSubscriptionMeta(subscription);

  return {
    id: String(subscription.id),
    plan_key: subscription.plan_key ?? null,
    plan_label: subscription.plan_key ?? subscription.plan_id ?? null,
    status: subscription.status ?? null,
    current_period_end: subscription.current_period_end ?? null,
    trial_ends_at: meta[DEV_CENTER_TOOLBOX_METADATA_KEYS.TRIAL_ENDS_AT] ?? null,
    extra_days_total: Number(meta[DEV_CENTER_TOOLBOX_METADATA_KEYS.EXTRA_DAYS_TOTAL]) || 0,
    extra_sales_bonus: Number(meta[DEV_CENTER_TOOLBOX_METADATA_KEYS.EXTRA_SALES_BONUS]) || 0,
    usage: usageBlock,
    usage_current: usageBlock?.current ?? null,
    usage_limit: usageBlock?.limit ?? null,
    usage_percent: usageBlock?.percent ?? null,
  };
}
