// ======================================================================
// Cancelamento de assinatura — fim do ciclo (MVP)
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { recordBillingEvent } from "../billingEventService.js";
import { resolveSubscriptionBillingCycle } from "./billingCycleService.js";
import { resolveBillingAccess } from "./resolveBillingAccess.js";
import {
  listUserBillingSubscriptions,
  pickPaidManagedSubscription,
} from "./billingSubscriptionQueryService.js";

const CANCELABLE_STATUSES = new Set([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.PENDING]);
const REACTIVATABLE_STATUSES = new Set([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE]);
const TERMINAL_SUBSCRIPTION_STATUSES = new Set([SUBSCRIPTION_STATUS.CANCELED, SUBSCRIPTION_STATUS.REFUNDED]);
const INTERNAL_PROVIDERS = new Set(["internal"]);

/**
 * @param {unknown} value
 */
function parseUtcDateTime(value) {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

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
 * Estado canônico de cancelamento agendado — mesma verdade para status, banner e reativação.
 *
 * @param {Record<string, unknown> | null | undefined} subscription
 * @param {Date} [now]
 */
export function resolveSubscriptionScheduledCancellationState(subscription, now = new Date()) {
  const cancellation = readSubscriptionCancellation(subscription?.metadata);
  const cycle = resolveSubscriptionBillingCycle(subscription, now);
  const status = String(subscription?.status ?? "").toLowerCase();
  const accessEndsAt = cycle.current_period_end ?? subscription?.current_period_end ?? null;
  const accessEnds = parseUtcDateTime(accessEndsAt);
  const accessEnded = accessEnds ? accessEnds.getTime() <= now.getTime() : false;
  const terminallyEnded = TERMINAL_SUBSCRIPTION_STATUSES.has(status);
  const managedStatus = REACTIVATABLE_STATUSES.has(status);
  const isScheduledForCancellation =
    cancellation.cancel_at_period_end === true && managedStatus && !terminallyEnded && !accessEnded;

  return {
    ...cancellation,
    access_ends_at: accessEndsAt,
    is_scheduled_for_cancellation: isScheduledForCancellation,
    is_reactivatable: isScheduledForCancellation,
    is_already_reactivated: managedStatus && cancellation.cancel_at_period_end !== true && !terminallyEnded,
    is_definitively_ended:
      terminallyEnded || (cancellation.cancel_at_period_end === true && managedStatus && accessEnded),
  };
}

/**
 * @param {Record<string, unknown>} subscription
 * @param {Date} [now]
 */
export function enrichSubscriptionCancellationFields(subscription, now = new Date()) {
  const state = resolveSubscriptionScheduledCancellationState(subscription, now);
  return {
    ...subscription,
    cancel_at_period_end: state.cancel_at_period_end,
    cancel_requested_at: state.cancel_requested_at,
    downgrade_target_plan_key: state.downgrade_target_plan_key,
    access_ends_at: state.access_ends_at,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string | null | undefined} [subscriptionId]
 */
export async function findReactivatableSubscription(supabase, userId, subscriptionId = null) {
  const list = await listUserBillingSubscriptions(supabase, userId);
  const now = new Date();
  const normalizedId = subscriptionId != null && String(subscriptionId).trim() !== "" ? String(subscriptionId).trim() : null;

  /** @type {Record<string, unknown>[]} */
  const candidates = [];
  if (normalizedId) {
    const row = list.find((item) => String(item.id) === normalizedId);
    if (!row) {
      const err = new Error("SUBSCRIPTION_NOT_FOUND");
      /** @type {any} */ (err).code = "SUBSCRIPTION_NOT_FOUND";
      throw err;
    }
    if (String(row.user_id ?? "") !== userId) {
      const err = new Error("SUBSCRIPTION_FORBIDDEN");
      /** @type {any} */ (err).code = "SUBSCRIPTION_FORBIDDEN";
      throw err;
    }
    candidates.push(row);
  } else {
    const paidManaged = pickPaidManagedSubscription(list);
    if (paidManaged) candidates.push(paidManaged);
  }

  for (const row of candidates) {
    const state = resolveSubscriptionScheduledCancellationState(row, now);
    if (state.is_reactivatable) {
      return { row, state };
    }
    if (state.is_already_reactivated) {
      return { row, state, alreadyReactivated: true };
    }
    if (state.is_definitively_ended) {
      const err = new Error("SUBSCRIPTION_ALREADY_ENDED");
      /** @type {any} */ (err).code = "SUBSCRIPTION_ALREADY_ENDED";
      throw err;
    }
    if (state.is_scheduled_for_cancellation !== true) {
      const err = new Error("SUBSCRIPTION_NOT_SCHEDULED_FOR_CANCELLATION");
      /** @type {any} */ (err).code = "SUBSCRIPTION_NOT_SCHEDULED_FOR_CANCELLATION";
      throw err;
    }
  }

  for (const row of list) {
    const state = resolveSubscriptionScheduledCancellationState(row, now);
    if (state.is_reactivatable) {
      return { row, state };
    }
  }

  return null;
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
