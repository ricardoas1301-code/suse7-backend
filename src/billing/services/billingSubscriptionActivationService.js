// ======================================================================
// Ativação paga — promove pending → active após pagamento confirmado
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { SUBSCRIPTION_STATUS, SUBSCRIPTION_STATUS_SUPERSEDED } from "../billingConstants.js";
import {
  derivePeriodEndFromNextBilling,
  loadInheritedBillingCycleForActivation,
  resolveSubscriptionBillingCycle,
  startOfUtcDay,
} from "./billingCycleService.js";
import { summarizeSubscriptionRow } from "./billingSubscriptionQueryService.js";

const SUBSCRIPTION_SELECT =
  "id, user_id, plan_id, plan_key, provider, provider_subscription_id, status, current_period_start, current_period_end, next_due_date, metadata, created_at";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 */
function extractNestedId(value) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  const obj = asObject(value);
  return obj ? asTrimmedString(obj.id) : null;
}

/**
 * @param {unknown} status
 */
export function isAsaasPaymentConfirmedStatus(status) {
  const s = String(status || "").toUpperCase();
  return s === "RECEIVED" || s === "CONFIRMED" || s === "RECEIVED_IN_CASH";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} keepSubscriptionId
 */
export async function deactivateSupersededSubscriptionsExcept(supabase, userId, keepSubscriptionId) {
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

  logBilling("billing", "[S7_BILLING_DEACTIVATE_PREVIOUS_DONE]", {
    user_id: userId,
    keep_subscription_id: keepSubscriptionId,
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} keepSubscriptionId
 */
async function cancelStalePendingCheckoutsExcept(supabase, userId, keepSubscriptionId) {
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({
      status: SUBSCRIPTION_STATUS.CANCELED,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .neq("id", keepSubscriptionId)
    .eq("status", SUBSCRIPTION_STATUS.PENDING);
  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 */
async function loadSubscriptionById(supabase, subscriptionId) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select(SUBSCRIPTION_SELECT)
    .eq("id", subscriptionId)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) ? data[0] ?? null : null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} providerSubscriptionId
 */
async function loadSubscriptionByProviderSubscriptionId(supabase, providerSubscriptionId) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select(SUBSCRIPTION_SELECT)
    .eq("provider", "asaas")
    .eq("provider_subscription_id", providerSubscriptionId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) ? data[0] ?? null : null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   paymentId?: string | null;
 *   providerPaymentId?: string | null;
 *   userId?: string | null;
 * }} ctx
 */
async function loadBillingPaymentRow(supabase, ctx) {
  if (ctx.paymentId) {
    const { data, error } = await supabase
      .from("billing_payments")
      .select("id, user_id, subscription_id, provider, provider_payment_id, status, raw_payload, paid_at")
      .eq("id", ctx.paymentId)
      .limit(1);
    if (error) throw error;
    return Array.isArray(data) ? data[0] ?? null : null;
  }

  const providerPaymentId = asTrimmedString(ctx.providerPaymentId);
  if (!providerPaymentId) return null;

  const { data, error } = await supabase
    .from("billing_payments")
    .select("id, user_id, subscription_id, provider, provider_payment_id, status, raw_payload, paid_at")
    .eq("provider", "asaas")
    .eq("provider_payment_id", providerPaymentId)
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) ? data[0] ?? null : null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown> | null | undefined} paymentRow
 * @param {{
 *   userId?: string | null;
 *   subscriptionId?: string | null;
 *   providerSubscriptionId?: string | null;
 * }} ctx
 */
async function resolveSubscriptionForActivation(supabase, paymentRow, ctx) {
  const subscriptionId = asTrimmedString(ctx.subscriptionId) ?? asTrimmedString(paymentRow?.subscription_id);
  if (subscriptionId) {
    const byId = await loadSubscriptionById(supabase, subscriptionId);
    if (byId) return byId;
  }

  const providerSubId =
    asTrimmedString(ctx.providerSubscriptionId) ??
    extractNestedId(paymentRow?.raw_payload && typeof paymentRow.raw_payload === "object"
      ? /** @type {Record<string, unknown>} */ (paymentRow.raw_payload).subscription
      : null);

  if (providerSubId) {
    const byProvider = await loadSubscriptionByProviderSubscriptionId(supabase, providerSubId);
    if (byProvider) return byProvider;
  }

  const userId = asTrimmedString(ctx.userId) ?? asTrimmedString(paymentRow?.user_id);
  if (userId) {
    const { data, error } = await supabase
      .from("billing_subscriptions")
      .select(SUBSCRIPTION_SELECT)
      .eq("user_id", userId)
      .eq("provider", "asaas")
      .eq("status", SUBSCRIPTION_STATUS.PENDING)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (Array.isArray(data) && data[0]) return data[0];
  }

  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} paymentRowId
 * @param {string} subscriptionId
 */
async function backfillPaymentSubscriptionLink(supabase, paymentRowId, subscriptionId) {
  const { error } = await supabase
    .from("billing_payments")
    .update({ subscription_id: subscriptionId, updated_at: new Date().toISOString() })
    .eq("id", paymentRowId)
    .is("subscription_id", null);
  if (error) {
    logBillingError("billing", "payment_subscription_link_backfill_failed", error, {
      payment_id: paymentRowId,
      subscription_id: subscriptionId,
    });
  }
}

/**
 * Promove assinatura pendente para active após pagamento confirmado (idempotente).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   paymentId?: string | null;
 *   providerPaymentId?: string | null;
 *   userId?: string | null;
 *   subscriptionId?: string | null;
 *   providerSubscriptionId?: string | null;
 *   nextDueDate?: string | null;
 *   paidAt?: string | null;
 *   source?: string;
 * }} ctx
 */
export async function activateSubscriptionFromPaidPayment(supabase, ctx) {
  const source = ctx.source ?? "unknown";
  logBilling("billing", "[S7_BILLING_ACTIVATE_SUBSCRIPTION_START]", {
    source,
    payment_id: ctx.paymentId ?? null,
    provider_payment_id: ctx.providerPaymentId ?? null,
    subscription_id: ctx.subscriptionId ?? null,
    provider_subscription_id: ctx.providerSubscriptionId ?? null,
    user_id: ctx.userId ?? null,
  });

  const paymentRow = await loadBillingPaymentRow(supabase, ctx);
  const userId = asTrimmedString(ctx.userId) ?? asTrimmedString(paymentRow?.user_id);
  if (paymentRow && userId && String(paymentRow.user_id) !== userId) {
    logBillingError("billing", "activate_subscription_user_mismatch", null, {
      expected_user_id: userId,
      payment_user_id: paymentRow.user_id,
    });
    return { activated: false, reason: "user_mismatch" };
  }

  const subscription = await resolveSubscriptionForActivation(supabase, paymentRow, ctx);
  if (!subscription?.id) {
    logBillingError("billing", "[S7_BILLING_ACTIVATE_SUBSCRIPTION_FOUND]", null, {
      found: false,
      source,
      provider_payment_id: ctx.providerPaymentId ?? paymentRow?.provider_payment_id ?? null,
    });
    return { activated: false, reason: "subscription_not_found" };
  }

  logBilling("billing", "[S7_BILLING_ACTIVATE_SUBSCRIPTION_FOUND]", {
    found: true,
    ...summarizeSubscriptionRow(subscription),
    source,
  });

  const subscriptionId = String(subscription.id);
  const subscriptionUserId = String(subscription.user_id);
  const currentStatus = String(subscription.status || "").toLowerCase();
  const alreadyActive = currentStatus === SUBSCRIPTION_STATUS.ACTIVE;

  if (paymentRow?.id && !paymentRow.subscription_id) {
    await backfillPaymentSubscriptionLink(supabase, String(paymentRow.id), subscriptionId);
  }

  const paidAtIso = ctx.paidAt ?? paymentRow?.paid_at ?? new Date().toISOString();
  if (paymentRow?.id) {
    await supabase
      .from("billing_payments")
      .update({
        status: "CONFIRMED",
        paid_at: paidAtIso,
        subscription_id: subscriptionId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", paymentRow.id);
  } else if (ctx.providerPaymentId) {
    await supabase
      .from("billing_payments")
      .update({
        status: "CONFIRMED",
        paid_at: paidAtIso,
        subscription_id: subscriptionId,
        updated_at: new Date().toISOString(),
      })
      .eq("provider", "asaas")
      .eq("provider_payment_id", String(ctx.providerPaymentId));
  }

  logBilling("billing", "[S7_BILLING_PAYMENT_CONFIRMED]", {
    user_id: subscriptionUserId,
    subscription_id: subscriptionId,
    provider_payment_id: ctx.providerPaymentId ?? paymentRow?.provider_payment_id ?? null,
    source,
  });

  if (!alreadyActive) {
    const activationNow = new Date(paidAtIso);
    const inheritedCycle = await loadInheritedBillingCycleForActivation(
      supabase,
      subscriptionUserId,
      subscriptionId,
      activationNow,
    );

    const nextDue = asTrimmedString(ctx.nextDueDate);
    const cycle = inheritedCycle
      ? {
          billing_cycle_anchor: inheritedCycle.billing_cycle_anchor,
          current_period_start: inheritedCycle.current_period_start,
          current_period_end: inheritedCycle.current_period_end,
          next_billing_at: inheritedCycle.next_billing_at,
        }
      : resolveSubscriptionBillingCycle(
          {
            created_at: subscription.created_at ?? paidAtIso,
            current_period_start: subscription.current_period_start,
            current_period_end: subscription.current_period_end,
            next_due_date: subscription.next_due_date,
          },
          activationNow,
        );

    const periodStartIso = inheritedCycle
      ? inheritedCycle.current_period_start
      : startOfUtcDay(paidAtIso)?.toISOString() ?? cycle.current_period_start;
    const periodEndIso = inheritedCycle
      ? inheritedCycle.current_period_end
      : nextDue
        ? derivePeriodEndFromNextBilling(nextDue)?.toISOString()
        : cycle.current_period_end;

    const metadata = {
      ...(asObject(subscription.metadata) ?? {}),
      activated_at: paidAtIso,
      delinquency_status: "none",
      billing_cycle_anchor: inheritedCycle?.billing_cycle_anchor ?? cycle.billing_cycle_anchor,
    };
    if (inheritedCycle?.source_subscription_id) {
      metadata.billing_cycle_inherited_from = inheritedCycle.source_subscription_id;
    }
    delete metadata.overdue_since;
    delete metadata.grace_period_ends_at;
    delete metadata.access_suspended_at;

    const { error: activateError } = await supabase
      .from("billing_subscriptions")
      .update({
        status: SUBSCRIPTION_STATUS.ACTIVE,
        metadata,
        next_due_date: inheritedCycle?.next_due_date ?? (nextDue ? nextDue : cycle.next_billing_at.slice(0, 10)),
        current_period_start: periodStartIso,
        current_period_end: periodEndIso,
        updated_at: new Date().toISOString(),
      })
      .eq("id", subscriptionId);

    if (activateError) throw activateError;
  }

  await cancelStalePendingCheckoutsExcept(supabase, subscriptionUserId, subscriptionId);
  await deactivateSupersededSubscriptionsExcept(supabase, subscriptionUserId, subscriptionId);

  logBilling("billing", "[S7_BILLING_ACTIVATE_SUBSCRIPTION_DONE]", {
    user_id: subscriptionUserId,
    subscription_id: subscriptionId,
    plan_key: subscription.plan_key ?? null,
    was_already_active: alreadyActive,
    source,
  });

  return {
    activated: !alreadyActive,
    idempotent: alreadyActive,
    subscription_id: subscriptionId,
    user_id: subscriptionUserId,
  };
}
