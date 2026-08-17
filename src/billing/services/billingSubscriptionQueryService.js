// ======================================================================
// Queries de assinatura — múltiplas linhas por user (active + pending + histórico)
// ======================================================================

import { logBilling } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";

const SUBSCRIPTION_LIST_SELECT =
  "id, user_id, plan_id, plan_key, provider, status, amount, currency, current_period_start, current_period_end, next_due_date, canceled_at, metadata, created_at, updated_at, provider_subscription_id";

const ACCESS_GRANTING_STATUSES = new Set([
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.INTERNAL_FREE,
  SUBSCRIPTION_STATUS.PAST_DUE,
]);

const TERMINAL_STATUSES = new Set([SUBSCRIPTION_STATUS.CANCELED, SUBSCRIPTION_STATUS.REFUNDED]);

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {Record<string, unknown>} row
 */
export function summarizeSubscriptionRow(row) {
  return {
    id: row.id != null ? String(row.id) : null,
    plan_id: row.plan_id != null ? String(row.plan_id) : null,
    plan_key: asTrimmedString(row.plan_key),
    provider: asTrimmedString(row.provider),
    status: asTrimmedString(row.status),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {number} [limit]
 */
export async function listUserBillingSubscriptions(supabase, userId, limit = 20) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select(SUBSCRIPTION_LIST_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return Array.isArray(data) ? /** @type {Record<string, unknown>[]} */ (data) : [];
}

/**
 * Assinatura que concede acesso hoje (plano pago active > Baby internal_free > demais).
 *
 * @param {Record<string, unknown>[]} list
 */
export function pickActiveSubscription(list) {
  for (const row of list) {
    const status = String(row.status || "").toLowerCase();
    const provider = String(row.provider || "").toLowerCase();
    if (TERMINAL_STATUSES.has(status)) continue;
    if (status === SUBSCRIPTION_STATUS.PENDING) continue;
    if (provider !== "internal" && ACCESS_GRANTING_STATUSES.has(status)) return row;
  }

  for (const row of list) {
    const status = String(row.status || "").toLowerCase();
    const provider = String(row.provider || "").toLowerCase();
    if (TERMINAL_STATUSES.has(status)) continue;
    if (provider === "internal" && status === SUBSCRIPTION_STATUS.INTERNAL_FREE) return row;
  }

  for (const row of list) {
    const status = String(row.status || "").toLowerCase();
    if (TERMINAL_STATUSES.has(status)) continue;
    if (ACCESS_GRANTING_STATUSES.has(status)) return row;
  }

  for (const row of list) {
    const status = String(row.status || "").toLowerCase();
    if (TERMINAL_STATUSES.has(status)) continue;
    if (status === SUBSCRIPTION_STATUS.PENDING) continue;
    return row;
  }

  return null;
}

/**
 * Checkout pendente (Asaas aguardando pagamento).
 *
 * @param {Record<string, unknown>[]} list
 */
export function pickPendingCheckout(list) {
  for (const row of list) {
    const status = String(row.status || "").toLowerCase();
    if (status !== SUBSCRIPTION_STATUS.PENDING) continue;
    const provider = String(row.provider || "").toLowerCase();
    if (provider === "asaas" || provider === "stripe") return row;
    if (provider !== "internal") return row;
  }
  return null;
}

/**
 * @param {Record<string, unknown>[]} list
 */
export function pickLatestSubscription(list) {
  return list[0] ?? null;
}

/**
 * Assinatura paga gerenciada (upgrade/downgrade agendado) — ignora internal_free e pending.
 *
 * @param {Record<string, unknown>[]} list
 */
export function pickPaidManagedSubscription(list) {
  const accessGranting = new Set([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE]);
  for (const row of list) {
    const status = String(row.status || "").toLowerCase();
    const provider = String(row.provider || "").toLowerCase();
    if (TERMINAL_STATUSES.has(status)) continue;
    if (provider === "internal" && status === SUBSCRIPTION_STATUS.INTERNAL_FREE) continue;
    if (status === SUBSCRIPTION_STATUS.PENDING) continue;
    if (accessGranting.has(status)) return row;
  }
  return null;
}

/**
 * @param {Record<string, unknown>[]} list
 * @param {string} planKeyOrSlug
 */
export function findPendingCheckoutForPlan(list, planKeyOrSlug) {
  const target = String(planKeyOrSlug || "").trim().toLowerCase();
  if (!target) return null;
  for (const row of list) {
    const status = String(row.status || "").toLowerCase();
    if (status !== SUBSCRIPTION_STATUS.PENDING) continue;
    const planKey = asTrimmedString(row.plan_key);
    if (planKey && planKey.toLowerCase() === target) return row;
  }
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ logContext?: string }} [options]
 */
export async function getActiveSubscription(supabase, userId, options = {}) {
  const list = await listUserBillingSubscriptions(supabase, userId);
  const active = pickActiveSubscription(list);
  logBilling("billing", "[S7_BILLING_SUBSCRIPTIONS_FOUND]", {
    user_id: userId,
    context: options.logContext ?? "active_sub",
    count: list.length,
    subscription_ids: list.map((row) => row.id),
    statuses: list.map((row) => row.status),
    providers: list.map((row) => row.provider),
  });
  logBilling("billing", "[S7_BILLING_ACTIVE_SUB]", {
    user_id: userId,
    context: options.logContext ?? "active_sub",
    ...(active ? summarizeSubscriptionRow(active) : { id: null }),
  });
  return active;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ logContext?: string }} [options]
 */
export async function getPendingCheckout(supabase, userId, options = {}) {
  const list = await listUserBillingSubscriptions(supabase, userId);
  const pending = pickPendingCheckout(list);
  logBilling("billing", "[S7_BILLING_PENDING_CHECKOUT]", {
    user_id: userId,
    context: options.logContext ?? "pending_checkout",
    ...(pending ? summarizeSubscriptionRow(pending) : { id: null }),
  });
  return pending;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function getLatestSubscription(supabase, userId) {
  const list = await listUserBillingSubscriptions(supabase, userId, 1);
  return pickLatestSubscription(list);
}

/**
 * Snapshot para change-plan e APIs de status.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function loadBillingSubscriptionSnapshot(supabase, userId) {
  const list = await listUserBillingSubscriptions(supabase, userId);
  const activeSubscription = pickActiveSubscription(list);
  const pendingCheckout = pickPendingCheckout(list);
  const paidManagedSubscription = pickPaidManagedSubscription(list);
  const latestSubscription = pickLatestSubscription(list);

  logBilling("billing", "[S7_BILLING_SUBSCRIPTIONS_FOUND]", {
    user_id: userId,
    context: "snapshot",
    count: list.length,
    rows: list.map(summarizeSubscriptionRow),
    active_subscription_id: activeSubscription?.id ?? null,
    pending_checkout_id: pendingCheckout?.id ?? null,
    paid_managed_subscription_id: paidManagedSubscription?.id ?? null,
  });
  logBilling("billing", "[S7_BILLING_ACTIVE_SUB]", {
    user_id: userId,
    ...(activeSubscription ? summarizeSubscriptionRow(activeSubscription) : { id: null }),
  });
  logBilling("billing", "[S7_BILLING_PENDING_CHECKOUT]", {
    user_id: userId,
    ...(pendingCheckout ? summarizeSubscriptionRow(pendingCheckout) : { id: null }),
  });

  return {
    list,
    activeSubscription,
    pendingCheckout,
    paidManagedSubscription,
    latestSubscription,
  };
}
