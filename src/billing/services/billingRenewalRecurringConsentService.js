// ======================================================================
// Consentimento de recorrência — renovação manual com cartão (Bloco B)
// ======================================================================

import { logBilling } from "../billingLog.js";
import { recordBillingEvent } from "../billingEventService.js";

export const RECURRING_CONSENT_RULE_VERSION = "block_b_v1";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   subscriptionId: string;
 *   renewalCycleId: string;
 *   paymentMethodId?: string | null;
 *   correlationId?: string | null;
 *   consentedAt?: string;
 * }} ctx
 */
export async function recordRenewalRecurringConsent(supabase, ctx) {
  const consentedAt = ctx.consentedAt ?? new Date().toISOString();
  const providerEventId = `renewal_recurring_consent:${ctx.renewalCycleId}:${ctx.paymentMethodId ?? "new"}`;

  const { duplicate } = await recordBillingEvent(supabase, {
    provider: "suse7",
    providerEventId,
    eventType: "BILLING_RENEWAL_RECURRING_CONSENT",
    rawPayload: {
      user_id: ctx.userId,
      subscription_id: ctx.subscriptionId,
      renewal_cycle_id: ctx.renewalCycleId,
      payment_method_id: ctx.paymentMethodId ?? null,
      rule_version: RECURRING_CONSENT_RULE_VERSION,
      consented_at: consentedAt,
      correlation_id: ctx.correlationId ?? null,
    },
  });

  logBilling("billing", "BILLING_RENEWAL_RECURRING_CONSENT_RECORDED", {
    user_id: ctx.userId,
    subscription_id: ctx.subscriptionId,
    renewal_cycle_id: ctx.renewalCycleId,
    payment_method_id: ctx.paymentMethodId ?? null,
    correlation_id: ctx.correlationId ?? null,
    idempotent: Boolean(duplicate),
  });

  return { recorded: true, idempotent: Boolean(duplicate) };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {{ paymentMethod?: string; paymentMethodId?: string | null; consentedAt?: string; correlationId?: string | null }} ctx
 */
export async function applyRecurringCardPreferenceAfterConfirmedPayment(supabase, subscriptionId, ctx) {
  const { data: row, error: readErr } = await supabase
    .from("billing_subscriptions")
    .select("metadata")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (readErr) throw readErr;

  const meta =
    row?.metadata && typeof row.metadata === "object"
      ? { .../** @type {Record<string, unknown>} */ (row.metadata) }
      : {};

  meta.payment_method = ctx.paymentMethod ?? "CREDIT_CARD";
  meta.auto_renew = true;
  meta.recurring_consent_at = ctx.consentedAt ?? new Date().toISOString();
  meta.recurring_consent_rule_version = RECURRING_CONSENT_RULE_VERSION;
  if (ctx.paymentMethodId) meta.default_payment_method_id = ctx.paymentMethodId;
  if (ctx.correlationId) meta.recurring_consent_correlation_id = ctx.correlationId;

  const { error } = await supabase
    .from("billing_subscriptions")
    .update({ metadata: meta, updated_at: new Date().toISOString() })
    .eq("id", subscriptionId);
  if (error) throw error;
}
