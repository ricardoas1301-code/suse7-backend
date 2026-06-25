// ======================================================================
// Downgrade agendado — ativação do plano alvo no fim do ciclo
// ======================================================================

import { logBilling } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { decimalToScale2String, toDecimal } from "../utils/moneyDecimal.js";
import { resolveSubscriptionBillingCycle } from "./billingCycleService.js";
import { getActivePlanById, getActivePlanByKey, getActivePlanBySlug } from "./billingPlanRepository.js";
import { activateOrCreateInternalBabySubscription } from "./internalBabyPlanService.js";

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {import("./billingPlanRepository.js").Suse7PlanRow | null | undefined} plan
 */
function resolvePlanSlug(plan) {
  if (!plan) return null;
  return asTrimmedString(plan.slug) ?? asTrimmedString(plan.plan_key);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} fromSubscriptionId
 */
async function findExistingDowngradeTargetSubscription(supabase, userId, fromSubscriptionId) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("id, status, plan_id, plan_key, provider, metadata, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;

  for (const row of data ?? []) {
    const status = String(row.status || "").toLowerCase();
    if (status === SUBSCRIPTION_STATUS.CANCELED || status === SUBSCRIPTION_STATUS.REFUNDED) continue;
    const meta = asObject(row.metadata) ?? {};
    if (
      meta.downgrade_from_subscription_id === fromSubscriptionId ||
      meta.plan_change_from_subscription_id === fromSubscriptionId
    ) {
      return row;
    }
  }
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ plan_change_target_plan_id?: string | null; plan_change_target_plan_slug?: string | null }} planChange
 */
export async function resolveScheduledDowngradeTargetPlan(supabase, planChange) {
  const targetPlanId = asTrimmedString(planChange.plan_change_target_plan_id);
  if (targetPlanId) {
    const byId = await getActivePlanById(supabase, targetPlanId);
    if (byId) return byId;
  }

  const targetSlug = asTrimmedString(planChange.plan_change_target_plan_slug);
  if (!targetSlug) return null;

  const bySlug = await getActivePlanBySlug(supabase, targetSlug);
  if (bySlug) return bySlug;
  return getActivePlanByKey(supabase, targetSlug);
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   userId: string;
 *   fromSubscription: Record<string, unknown>;
 *   targetPlan: import("./billingPlanRepository.js").Suse7PlanRow;
 *   now: Date;
 * }} ctx
 */
export async function activateOrCreateScheduledDowngradeTargetSubscription(ctx) {
  const fromSubscriptionId = String(ctx.fromSubscription.id);
  const existing = await findExistingDowngradeTargetSubscription(ctx.supabase, ctx.userId, fromSubscriptionId);
  if (existing?.id) {
    return {
      created: false,
      subscription_id: String(existing.id),
      plan_id: existing.plan_id != null ? String(existing.plan_id) : null,
      plan_key: existing.plan_key != null ? String(existing.plan_key) : null,
      provider: existing.provider != null ? String(existing.provider) : null,
      idempotent: true,
    };
  }

  if (ctx.targetPlan.billing_required === false) {
    const baby = await activateOrCreateInternalBabySubscription(ctx.supabase, ctx.userId, {
      downgrade_from_subscription_id: fromSubscriptionId,
      source: "scheduled_downgrade_applied",
    });
    return {
      created: Boolean(baby.created),
      subscription_id: baby.subscription_id ?? null,
      plan_id: ctx.targetPlan.id,
      plan_key: baby.plan_key ?? ctx.targetPlan.plan_key,
      provider: "internal",
      idempotent: Boolean(baby.idempotent),
    };
  }

  const now = ctx.now;
  const cycle = resolveSubscriptionBillingCycle(
    {
      created_at: now.toISOString(),
      current_period_end: ctx.fromSubscription.current_period_end ?? null,
    },
    now
  );
  const amount = decimalToScale2String(toDecimal(ctx.targetPlan.price_monthly));
  const provider = asTrimmedString(ctx.fromSubscription.provider) ?? "asaas";
  const providerCustomerId = asTrimmedString(ctx.fromSubscription.provider_customer_id) ?? null;
  const targetSlug = resolvePlanSlug(ctx.targetPlan);

  const row = {
    user_id: ctx.userId,
    plan_id: ctx.targetPlan.id,
    plan_key: ctx.targetPlan.plan_key,
    provider,
    provider_customer_id: providerCustomerId,
    provider_subscription_id: null,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    amount,
    currency: "BRL",
    current_period_start: cycle.current_period_start,
    current_period_end: cycle.current_period_end,
    next_due_date: cycle.next_billing_at.slice(0, 10),
    metadata: {
      source: "scheduled_downgrade_applied",
      downgrade_from_subscription_id: fromSubscriptionId,
      plan_change_from_subscription_id: fromSubscriptionId,
      plan_change_target_plan_slug: targetSlug,
      plan_change_target_plan_id: ctx.targetPlan.id,
      plan_change_target_plan_key: ctx.targetPlan.plan_key,
      scheduled_downgrade_without_immediate_charge: true,
      billing_cycle_anchor: cycle.billing_cycle_anchor,
    },
    updated_at: now.toISOString(),
  };

  const { data, error } = await ctx.supabase.from("billing_subscriptions").insert(row).select("id, plan_id, plan_key, provider").single();
  if (error) throw error;

  logBilling("billing", "scheduled_downgrade_target_activated", {
    user_id: ctx.userId,
    from_subscription_id: fromSubscriptionId,
    target_subscription_id: data.id,
    target_plan_key: ctx.targetPlan.plan_key,
  });

  return {
    created: true,
    subscription_id: String(data.id),
    plan_id: data.plan_id != null ? String(data.plan_id) : null,
    plan_key: data.plan_key != null ? String(data.plan_key) : null,
    provider: data.provider != null ? String(data.provider) : null,
    idempotent: false,
  };
}
