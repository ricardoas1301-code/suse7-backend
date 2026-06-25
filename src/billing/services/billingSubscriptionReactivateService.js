// ======================================================================
// Reativação de assinatura — remove cancelamento agendado
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { recordBillingEvent } from "../billingEventService.js";
import { resolveSubscriptionBillingCycle } from "./billingCycleService.js";
import { resolveBillingAccess } from "./resolveBillingAccess.js";
import {
  enrichSubscriptionCancellationFields,
  readSubscriptionCancellation,
} from "./billingSubscriptionCancelService.js";

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 */
function parseDate(value) {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function loadReactivatableSubscription(supabase, userId) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select(
      "id, user_id, plan_id, plan_key, provider, status, current_period_start, current_period_end, next_due_date, metadata, canceled_at"
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;

  const now = Date.now();
  for (const row of data ?? []) {
    const cancellation = readSubscriptionCancellation(row.metadata);
    if (!cancellation.cancel_at_period_end) continue;
    const periodEnd = parseDate(row.current_period_end);
    if (periodEnd && periodEnd.getTime() <= now) continue;
    return row;
  }
  return null;
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   user: { id: string };
 * }} ctx
 */
export async function reactivateSubscriptionCancellation(ctx) {
  const subscription = await loadReactivatableSubscription(ctx.supabase, ctx.user.id);
  if (!subscription) {
    const err = new Error("REACTIVATION_NOT_AVAILABLE");
    /** @type {any} */ (err).code = "REACTIVATION_NOT_AVAILABLE";
    throw err;
  }

  const now = new Date();
  const cycle = resolveSubscriptionBillingCycle(subscription, now);
  const metadata = { ...(asObject(subscription.metadata) ?? {}) };
  delete metadata.cancel_at_period_end;
  delete metadata.cancel_requested_at;
  delete metadata.downgrade_scheduled;
  delete metadata.downgrade_target_plan_key;
  metadata.reactivated_at = now.toISOString();

  const { data, error } = await ctx.supabase
    .from("billing_subscriptions")
    .update({
      metadata,
      current_period_start: subscription.current_period_start ?? cycle.current_period_start,
      current_period_end: subscription.current_period_end ?? cycle.current_period_end,
      updated_at: now.toISOString(),
    })
    .eq("id", subscription.id)
    .eq("user_id", ctx.user.id)
    .select(
      "id, plan_id, plan_key, provider, status, amount, currency, current_period_start, current_period_end, next_due_date, canceled_at, metadata, created_at, updated_at"
    )
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error("SUBSCRIPTION_NOT_FOUND");
    /** @type {any} */ (err).code = "SUBSCRIPTION_NOT_FOUND";
    throw err;
  }

  try {
    await recordBillingEvent(ctx.supabase, {
      provider: "suse7",
      providerEventId: `reactivated:${subscription.id}`,
      eventType: "SUBSCRIPTION_REACTIVATED",
      rawPayload: {
        subscription_id: subscription.id,
        user_id: ctx.user.id,
        reactivated_at: metadata.reactivated_at,
      },
    });
  } catch (eventError) {
    logBillingError("billing", "subscription_reactivated_event_failed", eventError, {
      user_id: ctx.user.id,
      subscription_id: subscription.id,
    });
  }

  logBilling("billing", "subscription_reactivated", { user_id: ctx.user.id, subscription_id: subscription.id });

  const billing = await resolveBillingAccess(ctx.supabase, ctx.user.id, { ensureBaby: false });
  return {
    kind: "reactivated",
    subscription: enrichSubscriptionCancellationFields(data),
    access: billing.access,
    can_access: billing.can_access,
    current_period_start: billing.current_period_start ?? data.current_period_start ?? null,
    current_period_end: billing.current_period_end ?? data.current_period_end ?? null,
    next_billing_at: billing.next_billing_at ?? null,
    cancel_at_period_end: false,
  };
}
