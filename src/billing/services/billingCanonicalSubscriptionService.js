// ======================================================================
// Assinatura faturável canônica — uma por tenant/seller
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  RENEWAL_CYCLE_OPEN_STATUSES,
  RENEWAL_STATUS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUS_SUPERSEDED,
} from "../billingConstants.js";
import {
  listUserBillingSubscriptions,
  pickActiveSubscription,
  pickPaidManagedSubscription,
} from "./billingSubscriptionQueryService.js";

const TERMINAL_SUBSCRIPTION_STATUSES = new Set([
  SUBSCRIPTION_STATUS.CANCELED,
  SUBSCRIPTION_STATUS.REFUNDED,
]);

/**
 * @param {Record<string, unknown>[]} list
 */
function pickNewestBillableAsaasSubscription(list) {
  /** @type {Record<string, unknown>[]} */
  const candidates = [];
  for (const row of list) {
    const status = String(row.status || "").toLowerCase();
    const provider = String(row.provider || "").toLowerCase();
    if (TERMINAL_SUBSCRIPTION_STATUSES.has(status)) continue;
    if (provider !== "asaas") continue;
    if (![SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE].includes(status)) {
      continue;
    }
    candidates.push(row);
  }

  if (candidates.length === 0) return null;

  candidates.sort((left, right) => {
    const leftTs = new Date(String(left.created_at || 0)).getTime();
    const rightTs = new Date(String(right.created_at || 0)).getTime();
    return rightTs - leftTs;
  });

  return candidates[0];
}

/**
 * Preferência canônica (S1.HF.6.9A.12):
 * 1) metadata.canonical_billable === true / is_canonical_subscription
 * 2) supersession explícita excluída
 * 3) Asaas ACTIVE/PAST_DUE mais recente (legado)
 * 4) paid managed / active
 *
 * Não usar: maior ID isolado, payment mais recente, só customer_id.
 *
 * @param {Record<string, unknown>[]} list
 */
export function resolveCanonicalBillableSubscription(list) {
  const rows = Array.isArray(list) ? list : [];
  /** @type {Record<string, unknown>[]} */
  const explicit = [];
  for (const row of rows) {
    const meta =
      row.metadata && typeof row.metadata === "object"
        ? /** @type {Record<string, unknown>} */ (row.metadata)
        : {};
    if (meta.superseded_by_subscription_id || meta.historical_only === true) continue;
    if (meta.canonical_billable === true || meta.is_canonical_subscription === true) {
      explicit.push(row);
    }
  }
  if (explicit.length === 1) return explicit[0];
  if (explicit.length > 1) {
    explicit.sort((a, b) => {
      const at = new Date(String(a.updated_at || a.created_at || 0)).getTime();
      const bt = new Date(String(b.updated_at || b.created_at || 0)).getTime();
      return bt - at;
    });
    return explicit[0];
  }

  return (
    pickNewestBillableAsaasSubscription(rows) ??
    pickPaidManagedSubscription(rows) ??
    pickActiveSubscription(rows)
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function loadCanonicalBillableSubscriptionContext(supabase, userId) {
  const list = await listUserBillingSubscriptions(supabase, userId, 50);
  const canonicalSubscription = resolveCanonicalBillableSubscription(list);
  const canonicalSubscriptionId =
    canonicalSubscription?.id != null ? String(canonicalSubscription.id) : null;

  logBilling("billing", "BILLING_CANONICAL_SUBSCRIPTION_RESOLVED", {
    user_id: userId,
    canonical_subscription_id: canonicalSubscriptionId,
    canonical_plan_key: canonicalSubscription?.plan_key ?? null,
    subscriptions_count: list.length,
  });

  return {
    list,
    canonicalSubscription,
    canonicalSubscriptionId,
  };
}

/**
 * S1.HF.6.9A.12A — payment vinculado a assinatura antiga não comanda entitlement.
 *
 * @param {Record<string, unknown>[]} list
 * @param {string | null | undefined} linkedSubscriptionId
 * @param {string | null | undefined} canonicalSubscriptionId
 */
export function classifyPaymentSubscriptionLink(list, linkedSubscriptionId, canonicalSubscriptionId) {
  const linked = linkedSubscriptionId != null ? String(linkedSubscriptionId) : null;
  const canonical = canonicalSubscriptionId != null ? String(canonicalSubscriptionId) : null;
  if (!linked) {
    return { apply_entitlement: Boolean(canonical), reason: "no_linked_use_canonical", reconcile_only: false };
  }
  if (canonical && linked === canonical) {
    return { apply_entitlement: true, reason: "linked_is_canonical", reconcile_only: false };
  }
  const row = (Array.isArray(list) ? list : []).find((r) => String(r.id) === linked);
  const status = String(row?.status ?? "").toLowerCase();
  if (status === SUBSCRIPTION_STATUS.PENDING && !canonical) {
    return { apply_entitlement: true, reason: "first_paid_checkout_pending", reconcile_only: false };
  }
  return {
    apply_entitlement: false,
    reason: "linked_non_canonical",
    reconcile_only: true,
    linked_status: status || null,
  };
}

/**
 * @param {unknown} status
 */
function normalizePaymentStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase();
}

const SETTLED_PAYMENT_STATUSES = new Set([
  "paid",
  "pago",
  "received",
  "confirmed",
  "received_in_cash",
  "refunded",
  "estornado",
  "refund",
]);

/**
 * Histórico pago permanece; cobranças abertas só da assinatura canônica.
 *
 * @param {Record<string, unknown>} row
 * @param {string | null} canonicalSubscriptionId
 */
export function shouldIncludePaymentInSellerHistory(row, canonicalSubscriptionId) {
  const status = normalizePaymentStatus(row.status);
  if (SETTLED_PAYMENT_STATUSES.has(status)) return true;

  if (status === "canceled" || status === "cancelled" || status === "cancelado") {
    return true;
  }

  if (!canonicalSubscriptionId) return false;

  const subscriptionId = row.subscription_id != null ? String(row.subscription_id) : null;
  if (!subscriptionId) return false;

  return subscriptionId === canonicalSubscriptionId;
}

/**
 * Encerra ciclos abertos de assinaturas que deixaram de ser a fonte faturável.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} keepSubscriptionId
 */
export async function supersedeOpenRenewalCyclesExcept(supabase, userId, keepSubscriptionId) {
  const { data: subs, error: subsError } = await supabase
    .from("billing_subscriptions")
    .select("id")
    .eq("user_id", userId)
    .neq("id", keepSubscriptionId);
  if (subsError) throw subsError;

  const subscriptionIds = (subs ?? []).map((row) => String(row.id)).filter(Boolean);
  if (subscriptionIds.length === 0) return { updated: 0 };

  const { data, error } = await supabase
    .from("billing_renewal_cycles")
    .update({
      renewal_status: RENEWAL_STATUS.SUPERSEDED,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .in("subscription_id", subscriptionIds)
    .in("renewal_status", [...RENEWAL_CYCLE_OPEN_STATUSES])
    .select("id");

  if (error) throw error;

  const updated = Array.isArray(data) ? data.length : 0;
  if (updated > 0) {
    logBilling("billing", "BILLING_RENEWAL_CYCLES_SUPERSEDED", {
      user_id: userId,
      keep_subscription_id: keepSubscriptionId,
      updated_count: updated,
    });
  }

  return { updated };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} keepSubscriptionId
 */
export async function enforceSingleBillableSubscription(supabase, userId, keepSubscriptionId) {
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({
      status: SUBSCRIPTION_STATUS.CANCELED,
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .neq("id", keepSubscriptionId)
    .in("status", SUBSCRIPTION_STATUS_SUPERSEDED);

  if (error) throw error;

  await supersedeOpenRenewalCyclesExcept(supabase, userId, keepSubscriptionId);

  logBilling("billing", "BILLING_SINGLE_BILLABLE_SUBSCRIPTION_ENFORCED", {
    user_id: userId,
    keep_subscription_id: keepSubscriptionId,
  });
}
