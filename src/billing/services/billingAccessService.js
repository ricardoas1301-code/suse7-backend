// ======================================================================
// billingAccessService — decisão de acesso (backend only)
// ======================================================================

import { logBilling } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";

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
  const { data: rows, error } = await supabase
    .from("billing_subscriptions")
    .select("id, plan_id, status, provider, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    logBilling("access", "load_subscriptions_failed", { user_id: userId, message: error.message });
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

  const list = Array.isArray(rows) ? rows : [];
  /** @type {{ id: string; plan_id: string; status: string; provider: string } | null} */
  let pick = null;
  for (const r of list) {
    const st = String(r.status || "").toLowerCase();
    if (st === SUBSCRIPTION_STATUS.CANCELED || st === SUBSCRIPTION_STATUS.REFUNDED) continue;
    pick = /** @type {any} */ (r);
    break;
  }
  if (!pick && list.length > 0) {
    pick = /** @type {any} */ (list[0]);
  }

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
  logBilling("access", "resolved", { user_id: userId, state, can_access: allowed, subscription_id: pick.id });
  return {
    can_access: allowed,
    allowed,
    state,
    plan_id: pick.plan_id ?? null,
    subscription_id: pick.id ?? null,
    subscription_status: pick.status ?? null,
    provider: pick.provider ?? null,
  };
}
