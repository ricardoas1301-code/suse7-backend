// ======================================================================
// resolveBillingAccess — acesso + limites seller-centric (backend only)
// ======================================================================

import { logBillingError } from "../billingLog.js";
import { canUserAccessPlanFeatures } from "./billingAccessService.js";
import { resolveSellerBillingCycle } from "./billingCycleService.js";
import { ensureInternalBabySubscription } from "./internalBabyPlanService.js";
import { buildDefaultMonthlySalesUsageResolution } from "./billingUsageFallback.js";
import { resolveMonthlySalesUsage } from "./billingUsageService.js";
import { applyUsageGrowthGraceToAccess, readUsageGrowthGrace } from "./billingUsageGrowthGraceService.js";
/**
 * @param {Record<string, unknown>} usageResolution
 */
function buildLimitsFromUsage(usageResolution) {
  return {
    monthly_sales_limit: usageResolution.monthly_sales_limit,
    current_month_sales: usageResolution.current_month_sales,
    warning_threshold_percent: usageResolution.warning_threshold_percent,
    grace_period_days: usageResolution.grace_period_days,
    hard_block_enabled: usageResolution.hard_block_enabled,
    usage_percent: usageResolution.usage_percent,
    near_limit: usageResolution.near_limit,
    warning: usageResolution.warning,
    exceeded: usageResolution.exceeded,
    hard_blocked: usageResolution.hard_blocked,
    grace_active: usageResolution.grace_active,
    soft_block: usageResolution.soft_block,
    freeze_level: usageResolution.freeze_level,
    recommended_upgrade: usageResolution.recommended_upgrade,
    ux_state: usageResolution.ux_state,
    window_kind: usageResolution.window_kind,
    period_start: usageResolution.period_start,
    period_end: usageResolution.period_end,
    aggregation_scope: usageResolution.aggregation_scope,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ module?: string | null; ensureBaby?: boolean }} [options]
 */
export async function resolveBillingAccess(supabase, userId, options = {}) {
  if (options.ensureBaby !== false) {
    try {
      await ensureInternalBabySubscription(supabase, userId);
    } catch (error) {
      logBillingError("billing", "ensure_internal_baby_failed", error, { user_id: userId });
    }
  }

  let access;
  try {
    access = await canUserAccessPlanFeatures(supabase, userId);
  } catch (error) {
    logBillingError("access", "resolve_access_failed", error, { user_id: userId });
    access = {
      can_access: false,
      allowed: false,
      state: "none",
      plan_id: null,
      subscription_id: null,
      subscription_status: null,
      provider: null,
    };
  }

  let cycle;
  try {
    cycle = (await resolveSellerBillingCycle(supabase, userId)).cycle;
  } catch (error) {
    logBillingError("billing", "resolve_billing_cycle_failed", error, { user_id: userId });
    cycle = null;
  }

  let usageResolution;
  try {
    usageResolution = await resolveMonthlySalesUsage(supabase, userId, access.plan_id, cycle ?? undefined);  } catch (error) {
    logBillingError("usage", "resolve_billing_access_usage_failed", error, { user_id: userId });
    usageResolution = buildDefaultMonthlySalesUsageResolution(
      error instanceof Error ? error.message : "usage_unavailable",
      cycle
    );  }

  let growthGrace = readUsageGrowthGrace(null);
  if (access.subscription_id) {
    const { data: subMetaRow } = await supabase
      .from("billing_subscriptions")
      .select("metadata")
      .eq("id", access.subscription_id)
      .maybeSingle();
    growthGrace = readUsageGrowthGrace(subMetaRow?.metadata);
  }

  const subscriptionAccess = Boolean(access.can_access);
  const hardBlockedByUsage = Boolean(usageResolution.hard_blocked);
  const growthPolicy = applyUsageGrowthGraceToAccess(
    hardBlockedByUsage,
    Boolean(usageResolution.exceeded),
    growthGrace
  );
  const premiumAccess = subscriptionAccess && !growthPolicy.hard_blocked;

  let accessDeniedCode = null;
  let accessDeniedMessage = null;
  if (!subscriptionAccess) {
    accessDeniedCode = "BILLING_SUBSCRIPTION_BLOCKED";
    accessDeniedMessage = "Assinatura inativa ou pendente para este seller.";
  } else if (growthPolicy.hard_blocked) {
    accessDeniedCode = "BILLING_SALES_LIMIT_EXCEEDED";
    accessDeniedMessage = "O volume consolidado do ecossistema ultrapassou o limite mensal do plano.";
  }

  const periodStartIso = usageResolution.period_start
    ? `${usageResolution.period_start}T00:00:00.000Z`
    : cycle?.current_period_start ?? null;
  const periodEndIso = usageResolution.period_end
    ? `${usageResolution.period_end}T23:59:59.999Z`
    : cycle?.current_period_end ?? null;

  return {
    access,
    usage: usageResolution.usage,
    breakdowns: usageResolution.breakdowns,
    limits: buildLimitsFromUsage(usageResolution),
    plan: usageResolution.plan,
    billing_cycle_anchor: cycle?.billing_cycle_anchor ?? periodStartIso,
    current_period_start: periodStartIso,
    current_period_end: periodEndIso,
    next_billing_at: cycle?.next_billing_at ?? null,
    module: options.module ?? null,
    premium_access: premiumAccess,    can_access: premiumAccess,
    access_denied_code: accessDeniedCode,
    access_denied_message: accessDeniedMessage,
    usage_fallback: Boolean(usageResolution.fallback),
    usage_growth_grace: growthPolicy.growth_grace,
    show_usage_growth_notice: growthPolicy.show_growth_notice,
  };
}
