// ======================================================================
// Motor de limites — consolidação seller-centric (ecossistema operacional)
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import Decimal from "decimal.js";
import { resolveSellerBillingCycle } from "./billingCycleService.js";
import { getActivePlanById } from "./billingPlanRepository.js";
import { buildDefaultMonthlySalesUsageResolution } from "./billingUsageFallback.js";
import {
  buildSellerSalesUsageBreakdowns,
  countSellerEcosystemSalesUsage,
  SUBSCRIPTION_USAGE_AGGREGATION_SCOPE,
  SUBSCRIPTION_USAGE_UNIT,
} from "./subscriptionUsageMeter.js";

export {
  SUBSCRIPTION_USAGE_AGGREGATION_SCOPE,
  SUBSCRIPTION_USAGE_AGGREGATION_SCOPE as BILLING_USAGE_AGGREGATION_SCOPE,
} from "./subscriptionUsageMeter.js";
export const BILLING_USAGE_UNIT = SUBSCRIPTION_USAGE_UNIT;

/** @typedef {"subscription_cycle"} BillingUsageWindowKind */
/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} planId
 */
async function loadPlanLimitConfig(supabase, planId) {
  const plan = await getActivePlanById(supabase, planId);
  if (!plan) return null;

  const { data: limitRow, error } = await supabase
    .from("billing_plan_limits")
    .select("monthly_sales_limit, warning_threshold_percent, grace_period_days, hard_block_enabled, metadata")
    .eq("plan_id", planId)
    .maybeSingle();
  if (error && !isMissingRelationError(error)) throw error;

  const monthlySalesLimit =
    limitRow?.monthly_sales_limit != null
      ? Number(limitRow.monthly_sales_limit)
      : plan.sales_limit_monthly != null
        ? Number(plan.sales_limit_monthly)
        : null;

  return {
    plan_id: plan.id,
    plan_key: plan.plan_key,
    plan_name: plan.name,
    display_name: plan.display_name ?? plan.name,
    marketing_name: plan.marketing_name ?? plan.display_name ?? plan.name,
    slug: plan.slug ?? plan.plan_key,
    monthly_sales_limit: Number.isFinite(monthlySalesLimit) ? monthlySalesLimit : null,
    warning_threshold_percent:
      limitRow?.warning_threshold_percent != null ? Number(limitRow.warning_threshold_percent) : 80,
    grace_period_days: limitRow?.grace_period_days != null ? Number(limitRow.grace_period_days) : 0,
    hard_block_enabled: Boolean(limitRow?.hard_block_enabled),
    metadata: limitRow?.metadata ?? {},
  };
}

function isMissingRelationError(error) {
  const msg = String(error?.message ?? "").toLowerCase();
  return (
    String(error?.code ?? "") === "42P01" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache") ||
    msg.includes("could not find the table")
  );
}

/**
 * Total mensal do ecossistema operacional do seller (todas as empresas, contas e marketplaces).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ period_start: string; period_end: string }} window
 */
async function countSellerEcosystemSales(supabase, userId, window) {
  return countSellerEcosystemSalesUsage(supabase, userId, window);
}

/**
 * Breakdowns analíticos — não definem plano nem cobrança.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ period_start: string; period_end: string }} window
 */
async function buildSellerSalesBreakdowns(supabase, userId, window) {
  return buildSellerSalesUsageBreakdowns(supabase, userId, window);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   period_start: string;
 *   period_end: string;
 *   window_kind: BillingUsageWindowKind;
 *   sales_count: number;
 *   breakdowns: Record<string, unknown>;
 * }} snapshot
 */
async function upsertMonthlyUsageRow(supabase, userId, snapshot) {
  const row = {
    user_id: userId,
    period_start: snapshot.period_start,
    period_end: snapshot.period_end,
    window_kind: snapshot.window_kind,
    sales_count: snapshot.sales_count,
    metadata: {
      breakdowns: snapshot.breakdowns,
      aggregation_scope: SUBSCRIPTION_USAGE_AGGREGATION_SCOPE,
    },
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("billing_monthly_usage").upsert(row, {
    onConflict: "user_id,period_start,period_end,window_kind",
  });
  if (!error) return;
  if (isMissingRelationError(error)) {
    logBilling("usage", "monthly_usage_upsert_skipped", { user_id: userId, reason: "table_missing" });
    return;
  }
  logBillingError("usage", "monthly_usage_upsert_failed", error, { user_id: userId });
}

/**
 * @param {{
 *   monthly_sales_limit: number | null;
 *   current_month_sales: number;
 *   warning_threshold_percent: number;
 *   grace_period_days: number;
 *   hard_block_enabled: boolean;
 * }} input
 */
export function evaluateSalesLimitState(input) {
  const limit = input.monthly_sales_limit;
  const used = Math.max(0, Number(input.current_month_sales ?? 0));
  if (limit == null || !Number.isFinite(limit) || limit <= 0) {
    return {
      usage_percent: null,
      near_limit: false,
      warning: false,
      exceeded: false,
      hard_blocked: false,
      grace_active: false,
      soft_block: false,
      freeze_level: "none",
      recommended_upgrade: false,
      ux_state: "unmetered",
    };
  }

  const usagePercent = new Decimal(used).div(limit).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
  const warningThreshold = Number.isFinite(input.warning_threshold_percent)
    ? Number(input.warning_threshold_percent)
    : 80;
  const warning = usagePercent >= warningThreshold && used <= limit;
  const exceeded = used > limit;
  const hardBlocked = exceeded && input.hard_block_enabled;
  const graceActive = exceeded && !input.hard_block_enabled && input.grace_period_days > 0;
  const softBlock = exceeded && !hardBlocked && !graceActive;

  let uxState = "within_limit";
  let freezeLevel = "none";
  if (hardBlocked) {
    uxState = "hard_blocked";
    freezeLevel = "total";
  } else if (exceeded) {
    uxState = graceActive ? "grace" : "over_limit";
    freezeLevel = graceActive ? "partial" : softBlock ? "partial" : "none";
  } else if (warning) {
    uxState = "near_limit";
  }

  return {
    usage_percent: usagePercent,
    near_limit: warning,
    warning,
    exceeded,
    hard_blocked: hardBlocked,
    grace_active: graceActive,
    soft_block: softBlock,
    freeze_level: freezeLevel,
    recommended_upgrade: warning || exceeded,
    ux_state: uxState,
  };
}

/**
 * @param {Record<string, unknown>} evaluation
 * @param {number | null} monthlySalesLimit
 * @param {number} totalSalesMonth
 * @param {BillingUsageWindowKind} windowKind
 * @param {string} periodStart
 * @param {string} periodEnd
 * @param {{ usage_status?: "available" | "unavailable" }} [meta]
 */
export function buildSellerUsagePayload(
  evaluation,
  monthlySalesLimit,
  totalSalesMonth,
  windowKind,
  periodStart,
  periodEnd,
  meta = {},
) {
  const usageStatus = meta.usage_status ?? "available";
  return {
    total_sales_month: totalSalesMonth,
    used_sales: totalSalesMonth,
    limit_sales_month: monthlySalesLimit,
    sales_limit: monthlySalesLimit,
    usage_percent: evaluation.usage_percent,
    near_limit: Boolean(evaluation.near_limit),
    window_kind: windowKind,
    period_start: periodStart,
    period_end: periodEnd,
    ux_state: evaluation.ux_state,
    grace_active: evaluation.grace_active,
    hard_blocked: evaluation.hard_blocked,
    soft_block: evaluation.soft_block,
    freeze_level: evaluation.freeze_level,
    aggregation_scope: SUBSCRIPTION_USAGE_AGGREGATION_SCOPE,
    usage_unit: SUBSCRIPTION_USAGE_UNIT,
    usage_status: usageStatus,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string | null | undefined} planId
 * @param {ReturnType<import("./billingCycleService.js").resolveSubscriptionBillingCycle> | null | undefined} [cycle]
 */
export async function resolveMonthlySalesUsage(supabase, userId, planId, cycle = null) {
  try {
    const resolvedCycle = cycle ?? (await resolveSellerBillingCycle(supabase, userId)).cycle;
    const window = {
      window_kind: resolvedCycle.window_kind,
      period_start: resolvedCycle.period_start,
      period_end: resolvedCycle.period_end,
    };
    const limitConfig = planId ? await loadPlanLimitConfig(supabase, planId) : null;
    const totalSalesMonth = await countSellerEcosystemSales(supabase, userId, window);
    const breakdowns = await buildSellerSalesBreakdowns(supabase, userId, window);

    await upsertMonthlyUsageRow(supabase, userId, {
      ...window,
      sales_count: totalSalesMonth,
      breakdowns,
    });

    const evaluation = evaluateSalesLimitState({
      monthly_sales_limit: limitConfig?.monthly_sales_limit ?? null,
      current_month_sales: totalSalesMonth,
      warning_threshold_percent: limitConfig?.warning_threshold_percent ?? 80,
      grace_period_days: limitConfig?.grace_period_days ?? 0,
      hard_block_enabled: limitConfig?.hard_block_enabled ?? false,
    });

    const usage = buildSellerUsagePayload(
      evaluation,
      limitConfig?.monthly_sales_limit ?? null,
      totalSalesMonth,
      window.window_kind,
      window.period_start,
      window.period_end,
      { usage_status: "available" },
    );

    return {
      window_kind: window.window_kind,
      period_start: window.period_start,
      period_end: window.period_end,
      aggregation_scope: SUBSCRIPTION_USAGE_AGGREGATION_SCOPE,
      monthly_sales_limit: limitConfig?.monthly_sales_limit ?? null,
      current_month_sales: totalSalesMonth,
      warning_threshold_percent: limitConfig?.warning_threshold_percent ?? 80,
      grace_period_days: limitConfig?.grace_period_days ?? 0,
      hard_block_enabled: limitConfig?.hard_block_enabled ?? false,
      usage,
      breakdowns: {
        marketplaces: breakdowns.marketplaces,
        companies: breakdowns.companies,
        accounts: breakdowns.accounts,
        truncated: breakdowns.truncated,
      },
      ...evaluation,
      plan: limitConfig
        ? {
            plan_id: limitConfig.plan_id,
            plan_key: limitConfig.plan_key,
            plan_name: limitConfig.plan_name,
            display_name: limitConfig.display_name,
            marketing_name: limitConfig.marketing_name,
            slug: limitConfig.slug,
          }
        : null,
    };
  } catch (error) {
    logBillingError("usage", "resolve_monthly_sales_usage_failed", error, { user_id: userId, plan_id: planId ?? null });
    return buildDefaultMonthlySalesUsageResolution(error instanceof Error ? error.message : "usage_unavailable");
  }
}
