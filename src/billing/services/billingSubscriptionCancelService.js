// ======================================================================
// Cancelamento de assinatura — fim do ciclo (MVP)
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { recordBillingEvent } from "../billingEventService.js";
import { resolveSubscriptionBillingCycle } from "./billingCycleService.js";
import { resolveBillingAccess } from "./resolveBillingAccess.js";

const CANCELABLE_STATUSES = new Set([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.PENDING]);
const INTERNAL_PROVIDERS = new Set(["internal"]);

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} metadata
 */
export function readSubscriptionCancellation(metadata) {
  const meta = asObject(metadata) ?? {};
  return {
    cancel_at_period_end: meta.cancel_at_period_end === true,
    cancel_requested_at:
      typeof meta.cancel_requested_at === "string" && meta.cancel_requested_at.trim() !== ""
        ? meta.cancel_requested_at.trim()
        : null,
    downgrade_target_plan_key:
      typeof meta.downgrade_target_plan_key === "string" && meta.downgrade_target_plan_key.trim() !== ""
        ? meta.downgrade_target_plan_key.trim()
        : "baby",
  };
}

/**
 * @param {Record<string, unknown>} subscription
 */
export function enrichSubscriptionCancellationFields(subscription) {
  const cancellation = readSubscriptionCancellation(subscription.metadata);
  return {
    ...subscription,
    ...cancellation,
    access_ends_at: subscription.current_period_end ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function loadLatestCancelableSubscription(supabase, userId) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select(
      "id, user_id, plan_id, plan_key, provider, provider_subscription_id, status, amount, currency, current_period_start, current_period_end, next_due_date, canceled_at, metadata, created_at, updated_at"
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  for (const row of rows) {
    const status = String(row.status || "").toLowerCase();
    const provider = String(row.provider || "").toLowerCase();
    if (INTERNAL_PROVIDERS.has(provider) && status === SUBSCRIPTION_STATUS.INTERNAL_FREE) continue;
    if (!CANCELABLE_STATUSES.has(status)) continue;
    const cancellation = readSubscriptionCancellation(row.metadata);
    return { row, cancellation };
  }
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} subscriptionId
 * @param {Record<string, unknown>} rawPayload
 */
async function recordCancellationDecision(supabase, userId, subscriptionId, rawPayload) {
  const providerEventId = `cancel_req:${userId}:${subscriptionId}:${Date.now()}`;
  try {
    await recordBillingEvent(supabase, {
      provider: "suse7",
      providerEventId,
      eventType: "SUBSCRIPTION_CANCEL_REQUESTED",
      rawPayload,
    });
  } catch (error) {
    logBillingError("billing", "cancel_request_event_failed", error, { user_id: userId, subscription_id: subscriptionId });
  }
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   user: { id: string };
 * }} ctx
 */
export async function requestSubscriptionCancellationAtPeriodEnd(ctx) {
  const found = await loadLatestCancelableSubscription(ctx.supabase, ctx.user.id);
  if (!found) {
    const err = new Error("NO_ACTIVE_SUBSCRIPTION");
    /** @type {any} */ (err).code = "NO_ACTIVE_SUBSCRIPTION";
    throw err;
  }

  const { row, cancellation } = found;
  if (cancellation.cancel_at_period_end) {
    const err = new Error("CANCEL_ALREADY_REQUESTED");
    /** @type {any} */ (err).code = "CANCEL_ALREADY_REQUESTED";
    throw err;
  }

  const now = new Date();
  const cycle = resolveSubscriptionBillingCycle(row, now);
  const currentPeriodStart = row.current_period_start ?? cycle.current_period_start;
  const currentPeriodEnd = row.current_period_end ?? cycle.current_period_end;
  const cancelRequestedAt = now.toISOString();
  const metadata = {
    ...(asObject(row.metadata) ?? {}),
    cancel_at_period_end: true,
    cancel_requested_at: cancelRequestedAt,
    downgrade_target_plan_key: "baby",
    downgrade_scheduled: true,
  };

  const patch = {
    metadata,
    current_period_start: currentPeriodStart,
    current_period_end: currentPeriodEnd,
    updated_at: cancelRequestedAt,
  };

  const { data, error } = await ctx.supabase
    .from("billing_subscriptions")
    .update(patch)
    .eq("id", row.id)
    .eq("user_id", ctx.user.id)
    .select(
      "id, plan_id, plan_key, provider, status, amount, currency, current_period_start, current_period_end, next_due_date, canceled_at, metadata, created_at, updated_at"
    )
    .single();
  if (error) throw error;

  await recordCancellationDecision(ctx.supabase, ctx.user.id, String(row.id), {
    subscription_id: row.id,
    user_id: ctx.user.id,
    cancel_at_period_end: true,
    cancel_requested_at: cancelRequestedAt,
    current_period_start: currentPeriodStart,
    current_period_end: currentPeriodEnd,
    downgrade_target_plan_key: "baby",
  });

  logBilling("billing", "subscription_cancel_requested", {
    user_id: ctx.user.id,
    subscription_id: row.id,
    access_ends_at: currentPeriodEnd,
  });

  const billing = await resolveBillingAccess(ctx.supabase, ctx.user.id, { ensureBaby: false });
  const subscription = enrichSubscriptionCancellationFields(data);

  return {
    kind: "cancel_at_period_end",
    subscription,
    access: billing.access,
    can_access: billing.can_access,
    current_period_start: billing.current_period_start ?? currentPeriodStart,
    current_period_end: billing.current_period_end ?? currentPeriodEnd,
    next_billing_at: billing.next_billing_at ?? null,
    cancel_at_period_end: true,
    cancel_requested_at: cancelRequestedAt,
    access_ends_at: currentPeriodEnd,
    downgrade_target_plan_key: "baby",
  };
}
