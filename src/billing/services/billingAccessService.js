// ======================================================================
// billingAccessService — decisão de acesso (backend only)
// ======================================================================

import { logBilling } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { resolveDelinquencyAccess, readSubscriptionDelinquency } from "./billingDunningService.js";
import { listUserBillingSubscriptions, pickActiveSubscription } from "./billingSubscriptionQueryService.js";

/**
 * Estados expostos ao restante do backend / APIs.
 * @typedef {"none" | "pending" | "active" | "past_due" | "canceled" | "refunded" | "internal_free"} BillingAccessState
 */

/**
 * @param {string | null | undefined} status
 * @param {string | null | undefined} provider
 * @returns {{ allowed: boolean; state: BillingAccessState }}
 */
export function resolveAccessFromSubscriptionRow(status, provider) {
  const s = String(status || "").toLowerCase();
  const p = String(provider || "").toLowerCase();

  if (p === "internal" && s === SUBSCRIPTION_STATUS.INTERNAL_FREE) {
    return { allowed: true, state: "internal_free" };
  }
  /** Compat: assinaturas internas antigas com status `active`. */
  if (p === "internal" && s === SUBSCRIPTION_STATUS.ACTIVE) {
    return { allowed: true, state: "internal_free" };
  }
  if (s === SUBSCRIPTION_STATUS.ACTIVE) return { allowed: true, state: "active" };
  if (s === SUBSCRIPTION_STATUS.PENDING) return { allowed: false, state: "pending" };
  if (s === SUBSCRIPTION_STATUS.PAST_DUE) return { allowed: false, state: "past_due" };
  if (s === SUBSCRIPTION_STATUS.REFUNDED) return { allowed: false, state: "refunded" };
  if (s === SUBSCRIPTION_STATUS.CANCELED) return { allowed: false, state: "canceled" };
  /** Compat legado BILLING 03. */
  if (s === "pending_payment") return { allowed: false, state: "pending" };
  if (s === "trialing") return { allowed: true, state: "active" };
  return { allowed: false, state: "none" };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{
 *   can_access: boolean;
 *   allowed: boolean;
 *   state: BillingAccessState;
 *   plan_id: string | null;
 *   subscription_id: string | null;
 *   subscription_status: string | null;
 *   provider: string | null;
 * }>}
 */
export async function canUserAccessPlanFeatures(supabase, userId) {
  let list;
  try {
    list = await listUserBillingSubscriptions(supabase, userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logBilling("access", "load_subscriptions_failed", { user_id: userId, message });
    const empty = {
      can_access: false,
      allowed: false,
      state: /** @type {BillingAccessState} */ ("none"),
      plan_id: null,
      subscription_id: null,
      subscription_status: null,
      provider: null,
    };
    return empty;
  }

  /** @type {{ id: string; plan_id: string; status: string; provider: string; metadata?: Record<string, unknown> | null; current_period_end?: string | null } | null} */
  const pick = pickActiveSubscription(list);

  if (!pick) {
    return {
      can_access: false,
      allowed: false,
      state: "none",
      plan_id: null,
      subscription_id: null,
      subscription_status: null,
      provider: null,
    };
  }

  const { allowed, state } = resolveAccessFromSubscriptionRow(pick.status, pick.provider);
  let canAccess = allowed;
  let resolvedState = state;
  if (!canAccess && state === "canceled" && pick.current_period_end) {
    const end = new Date(String(pick.current_period_end));
    if (!Number.isNaN(end.getTime()) && end.getTime() > Date.now()) {
      canAccess = true;
      resolvedState = "active";
    }
  }
  const delinquencyAccess = resolveDelinquencyAccess(pick.metadata);
  const delinquency = readSubscriptionDelinquency(pick.metadata);
  if (delinquencyAccess) {
    canAccess = delinquencyAccess.can_access;
    resolvedState = /** @type {BillingAccessState} */ (delinquencyAccess.state);
  }
  logBilling("access", "resolved", { user_id: userId, state: resolvedState, can_access: canAccess, subscription_id: pick.id });
  return {
    can_access: canAccess,
    allowed: canAccess,
    state: resolvedState,
    plan_id: pick.plan_id ?? null,
    subscription_id: pick.id ?? null,
    subscription_status: pick.status ?? null,
    provider: pick.provider ?? null,
    delinquency_warning: Boolean(delinquencyAccess?.delinquency_warning),
    delinquency_status: delinquency.delinquency_status,
    overdue_since: delinquency.overdue_since,
    grace_period_ends_at: delinquency.grace_period_ends_at,
    access_suspended_at: delinquency.access_suspended_at,
  };
}
