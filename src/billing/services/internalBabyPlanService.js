// ======================================================================
// Plano Baby interno — sem Asaas, provisionado pelo backend Suse7
// ======================================================================

import { logBilling } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { resolveSubscriptionBillingCycle } from "./billingCycleService.js";
import { getActivePlanByKey } from "./billingPlanRepository.js";
const BABY_PLAN_KEYS = ["baby", "free", "interno", "internal_free"];

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
async function resolveInternalFreePlan(supabase) {
  for (const key of BABY_PLAN_KEYS) {
    const plan = await getActivePlanByKey(supabase, key);
    if (plan?.billing_required === false) return plan;
  }

  const { data, error } = await supabase
    .from("plans")
    .select("id, plan_key, name, price_monthly, sales_limit_monthly, billing_required, is_active, sort_order")
    .eq("is_active", true)
    .eq("billing_required", false)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ downgrade_from_subscription_id?: string | null; source?: string }} [options]
 */
export async function activateOrCreateInternalBabySubscription(supabase, userId, options = {}) {
  const plan = await resolveInternalFreePlan(supabase);
  if (!plan?.id) {
    logBilling("billing", "internal_baby_plan_missing", { user_id: userId });
    return { created: false, subscription_id: null, reason: "plan_not_found" };
  }

  const downgradeFrom = options.downgrade_from_subscription_id != null ? String(options.downgrade_from_subscription_id) : null;
  const source = options.source ?? "period_expiration_downgrade";

  const { data: existingRows, error: existingError } = await supabase
    .from("billing_subscriptions")
    .select("id, status, provider, metadata, created_at")
    .eq("user_id", userId)
    .eq("provider", "internal")
    .order("created_at", { ascending: false })
    .limit(20);
  if (existingError) throw existingError;

  for (const row of existingRows ?? []) {
    const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    if (downgradeFrom && meta.downgrade_from_subscription_id === downgradeFrom) {
      return {
        created: false,
        subscription_id: String(row.id),
        plan_key: plan.plan_key,
        idempotent: true,
      };
    }
  }

  const now = new Date();
  const cycle = resolveSubscriptionBillingCycle({ created_at: now.toISOString() }, now);
  const row = {
    user_id: userId,
    plan_id: plan.id,
    plan_key: plan.plan_key,
    provider: "internal",
    provider_customer_id: "internal",
    provider_subscription_id: null,
    status: SUBSCRIPTION_STATUS.INTERNAL_FREE,
    amount: "0.00",
    currency: "BRL",
    current_period_start: cycle.current_period_start,
    current_period_end: cycle.current_period_end,
    next_due_date: cycle.next_billing_at.slice(0, 10),
    metadata: {
      plan_key: plan.plan_key,
      sales_limit_monthly: plan.sales_limit_monthly ?? null,
      source,
      internal: true,
      billing_cycle_anchor: cycle.billing_cycle_anchor,
      ...(downgradeFrom ? { downgrade_from_subscription_id: downgradeFrom } : {}),
    },
    updated_at: now.toISOString(),
  };
  const { data, error } = await supabase.from("billing_subscriptions").insert(row).select("id").single();
  if (error) throw error;
  logBilling("billing", "internal_baby_assigned", {
    user_id: userId,
    plan_key: plan.plan_key,
    subscription_id: data.id,
    source,
  });
  return { created: true, subscription_id: String(data.id), plan_key: plan.plan_key };
}

/**
 * Garante assinatura interna Baby/free para novos usuários sem checkout.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function ensureInternalBabySubscription(supabase, userId) {
  const { data: existingRows, error: existingError } = await supabase
    .from("billing_subscriptions")
    .select("id, status, provider")
    .eq("user_id", userId)
    .eq("provider", "internal")
    .in("status", [SUBSCRIPTION_STATUS.INTERNAL_FREE, SUBSCRIPTION_STATUS.ACTIVE])
    .order("created_at", { ascending: false })
    .limit(1);
  if (existingError) throw existingError;
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (existing?.id) return { created: false, subscription_id: String(existing.id) };

  const plan = await resolveInternalFreePlan(supabase);
  if (!plan?.id) {
    logBilling("billing", "internal_baby_plan_missing", { user_id: userId });
    return { created: false, subscription_id: null, reason: "plan_not_found" };
  }

  const now = new Date();
  const cycle = resolveSubscriptionBillingCycle({ created_at: now.toISOString() }, now);
  const row = {
    user_id: userId,
    plan_id: plan.id,
    plan_key: plan.plan_key,
    provider: "internal",
    provider_customer_id: "internal",
    provider_subscription_id: null,
    status: SUBSCRIPTION_STATUS.INTERNAL_FREE,
    amount: "0.00",
    currency: "BRL",
    current_period_start: cycle.current_period_start,
    current_period_end: cycle.current_period_end,
    next_due_date: cycle.next_billing_at.slice(0, 10),
    metadata: {
      plan_key: plan.plan_key,
      sales_limit_monthly: plan.sales_limit_monthly ?? null,
      source: "auto_internal_baby",
      internal: true,
      billing_cycle_anchor: cycle.billing_cycle_anchor,
    },
    updated_at: now.toISOString(),
  };
  const { data, error } = await supabase.from("billing_subscriptions").insert(row).select("id").single();
  if (error) throw error;
  logBilling("billing", "internal_baby_assigned", { user_id: userId, plan_key: plan.plan_key, subscription_id: data.id });
  return { created: true, subscription_id: data.id, plan_key: plan.plan_key };
}
