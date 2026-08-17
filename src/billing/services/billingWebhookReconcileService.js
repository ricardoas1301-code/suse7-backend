// ======================================================================
// Webhook — reconciliação defensiva (reorder / atraso)
// ======================================================================

import { BILLING_TIMELINE_EVENT } from "../billingPhase30Constants.js";
import { logBilling } from "../billingLog.js";
import { buildBillingObservabilityContext } from "../utils/billingObservability.js";
import { recordBillingTimelineEvent } from "./billingTimelineEventService.js";

/**
 * Se PAYMENT_CONFIRMED chegar antes de PAYMENT_CREATED na timeline, registra cobrança gerada (idempotente).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   subscriptionId: string | null;
 *   paymentId?: string | null;
 *   providerPaymentId: string;
 *   providerEventId: string;
 * }} input
 */
export async function ensurePaymentGeneratedTimelineBeforeConfirm(supabase, input) {
  if (!input.userId || !input.providerPaymentId) return { ensured: false };

  const idempotencyKey = `asaas:reconcile:generated:${input.providerPaymentId}`;

  const { data: existing, error: readErr } = await supabase
    .from("billing_timeline_events")
    .select("id, event_type")
    .eq("user_id", input.userId)
    .in("event_type", [BILLING_TIMELINE_EVENT.PAYMENT_GENERATED, BILLING_TIMELINE_EVENT.PAYMENT_CONFIRMED])
    .filter("payload->>provider_payment_id", "eq", input.providerPaymentId)
    .limit(1);

  if (readErr) throw readErr;
  if (Array.isArray(existing) && existing.length > 0) {
    return { ensured: false, reason: "already_has_payment_timeline" };
  }

  await recordBillingTimelineEvent(supabase, {
    userId: input.userId,
    subscriptionId: input.subscriptionId,
    paymentId: input.paymentId ?? null,
    eventType: BILLING_TIMELINE_EVENT.PAYMENT_GENERATED,
    title: "Cobrança registrada",
    summary: "Cobrança reconciliada antes da confirmação do pagamento.",
    eventSource: "webhook",
    payload: {
      provider_payment_id: input.providerPaymentId,
      reconciled: true,
    },
    idempotencyKey,
    correlationId: input.providerEventId,
  });

  logBilling("billing", "S7_BILLING_WEBHOOK_RECONCILE_GENERATED", {
    ...buildBillingObservabilityContext({
      user_id: input.userId,
      subscription_id: input.subscriptionId,
      payment_id: input.paymentId,
      provider_event_id: input.providerEventId,
      source: "webhook_reconcile",
    }),
  });

  return { ensured: true };
}
