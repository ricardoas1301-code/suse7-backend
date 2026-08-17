// ======================================================================
// Reativação de assinatura — remove cancelamento agendado
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { recordBillingEvent } from "../billingEventService.js";
import { resolveSubscriptionBillingCycle } from "./billingCycleService.js";
import { resolveBillingAccess } from "./resolveBillingAccess.js";
import {
  enrichSubscriptionCancellationFields,
  findReactivatableSubscription,
  readSubscriptionCancellation,
} from "./billingSubscriptionCancelService.js";

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {string} code
 * @param {string} message
 */
function buildReactivateError(code, message) {
  const err = new Error(message);
  /** @type {any} */ (err).code = code;
  return err;
}

/**
 * Cancelamento ao fim do ciclo é registrado apenas no banco local (metadata).
 * O provider Asaas permanece com assinatura ativa — não há chamada remota nesta reativação.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 */
async function assertProviderAllowsLocalReactivation(supabase, subscription) {
  const provider = String(subscription.provider ?? "").toLowerCase();
  if (provider !== "asaas") return;

  const providerSubscriptionId = String(subscription.provider_subscription_id ?? "").trim();
  if (!providerSubscriptionId) return;

  // Cancelamento agendado no Suse7 não chama DELETE /subscriptions no Asaas.
  // A assinatura remota segue ativa; basta limpar a programação local.
  void supabase;
  void providerSubscriptionId;
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   user: { id: string };
 *   subscription: Record<string, unknown>;
 *   kind?: string;
 * }} ctx
 */
async function buildReactivationSnapshot(ctx, kind = "reactivated") {
  const billing = await resolveBillingAccess(ctx.supabase, ctx.user.id, { ensureBaby: false });
  const enriched = enrichSubscriptionCancellationFields(ctx.subscription);
  return {
    kind,
    subscription: enriched,
    access: billing.access,
    can_access: billing.can_access,
    current_period_start: billing.current_period_start ?? enriched.current_period_start ?? null,
    current_period_end: billing.current_period_end ?? enriched.current_period_end ?? null,
    next_billing_at: billing.next_billing_at ?? null,
    cancel_at_period_end: false,
  };
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   user: { id: string };
 *   subscriptionId?: string | null;
 * }} ctx
 */
export async function reactivateSubscriptionCancellation(ctx) {
  const subscriptionId =
    typeof ctx.subscriptionId === "string" && ctx.subscriptionId.trim() !== "" ? ctx.subscriptionId.trim() : null;

  let found;
  try {
    found = await findReactivatableSubscription(ctx.supabase, ctx.user.id, subscriptionId);
  } catch (error) {
    throw error;
  }

  if (!found) {
    throw buildReactivateError("REACTIVATION_NOT_AVAILABLE", "Nenhuma assinatura elegível para reativação.");
  }

  const subscription = found.row;
  const cancellation = readSubscriptionCancellation(subscription.metadata);

  if (found.alreadyReactivated || cancellation.cancel_at_period_end !== true) {
    return buildReactivationSnapshot({ supabase: ctx.supabase, user: ctx.user, subscription }, "already_reactivated");
  }

  await assertProviderAllowsLocalReactivation(ctx.supabase, subscription);

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
      current_period_start: cycle.current_period_start,
      current_period_end: cycle.current_period_end,
      next_due_date: cycle.next_billing_at.slice(0, 10),
      updated_at: now.toISOString(),
    })
    .eq("id", subscription.id)
    .eq("user_id", ctx.user.id)
    .select(
      "id, plan_id, plan_key, provider, provider_subscription_id, status, amount, currency, current_period_start, current_period_end, next_due_date, canceled_at, metadata, created_at, updated_at"
    )
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw buildReactivateError("SUBSCRIPTION_NOT_FOUND", "Não foi possível localizar esta assinatura.");
  }

  const eventResult = await recordBillingEvent(ctx.supabase, {
    provider: "suse7",
    providerEventId: `reactivated:${subscription.id}`,
    eventType: "SUBSCRIPTION_REACTIVATED",
    rawPayload: {
      subscription_id: subscription.id,
      user_id: ctx.user.id,
      reactivated_at: metadata.reactivated_at,
    },
  }).catch((eventError) => {
    logBillingError("billing", "subscription_reactivated_event_failed", eventError, {
      user_id: ctx.user.id,
      subscription_id: subscription.id,
    });
    return { duplicate: false, eventId: null };
  });

  if (eventResult?.duplicate) {
    logBilling("billing", "subscription_reactivate_idempotent", {
      user_id: ctx.user.id,
      subscription_id: subscription.id,
    });
    return buildReactivationSnapshot(
      { supabase: ctx.supabase, user: ctx.user, subscription: data },
      "already_reactivated",
    );
  }

  logBilling("billing", "subscription_reactivated", { user_id: ctx.user.id, subscription_id: subscription.id });

  return buildReactivationSnapshot({ supabase: ctx.supabase, user: ctx.user, subscription: data }, "reactivated");
}
