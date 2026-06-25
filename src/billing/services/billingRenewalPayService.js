// ======================================================================
// POST /api/billing/renewals/:renewal_cycle_id/pay
// ======================================================================

import { RENEWAL_STATUS } from "../billingConstants.js";
import { getRenewalCycleForUser } from "./billingRenewalCycleRepository.js";
import { getActivePlanById } from "./billingPlanRepository.js";
import { createRenewalCyclePayment } from "./billingRenewalPaymentService.js";
import { fetchPixCheckoutPayload } from "./billingPixCheckoutService.js";
import { fetchBoletoCheckoutPayload } from "./billingBoletoCheckoutService.js";
import { mapCheckoutStartResponse } from "./billingCheckoutResponse.js";
import { normalizeCheckoutPaymentMethod } from "./billingSubscriptionService.js";
const PAYABLE_CYCLE_STATUSES = new Set([
  RENEWAL_STATUS.PRE_RENEWAL,
  RENEWAL_STATUS.PENDING_PAYMENT,
  RENEWAL_STATUS.PAYMENT_FAILED,
  RENEWAL_STATUS.GRACE_PERIOD,
]);

const OPEN_PAYMENT_STATUSES = new Set(["pending", "pendente", "awaiting_payment", "overdue", "vencido", "past_due"]);

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} cycle
 * @param {import("./billingPlanRepository.js").Suse7PlanRow} plan
 * @param {Record<string, unknown>} subscription
 * @param {string} paymentMethod
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 */
async function buildCheckoutFromExistingRenewalPayment(
  supabase,
  cycle,
  plan,
  subscription,
  paymentMethod,
  providerApi
) {
  const { data: payment, error } = await supabase
    .from("billing_payments")
    .select("id, provider_payment_id, status, amount, raw_payload")
    .eq("id", cycle.generated_payment_id)
    .maybeSingle();
  if (error) throw error;
  if (!payment?.provider_payment_id) {
    const err = new Error("RENEWAL_PAYMENT_NOT_FOUND");
    /** @type {any} */ (err).code = "RENEWAL_PAYMENT_NOT_FOUND";
    throw err;
  }

  const status = String(payment.status || "").toLowerCase();
  if (!OPEN_PAYMENT_STATUSES.has(status)) {
    const err = new Error("RENEWAL_CYCLE_NOT_PAYABLE");
    /** @type {any} */ (err).code = "RENEWAL_CYCLE_NOT_PAYABLE";
    throw err;
  }

  const mapped = mapCheckoutStartResponse(
    {
      kind: "paid",
      subscription,
      asaas: { firstPayment: payment.raw_payload },
    },
    plan,
    paymentMethod
  );

  const providerPaymentId = String(payment.provider_payment_id);
  if (paymentMethod === "PIX") {
    const pix = await fetchPixCheckoutPayload(providerApi, providerPaymentId);
    if (pix) mapped.pix = pix;
  }
  if (paymentMethod === "BOLETO") {
    const boleto = await fetchBoletoCheckoutPayload(providerApi, providerPaymentId);
    if (boleto) mapped.boleto = boleto;
  }

  return {
    renewal_cycle_id: String(cycle.id),
    plan_key: plan.plan_key,
    payment_method: paymentMethod,
    checkout: mapped,
    reused_existing_payment: true,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   user: { id: string };
 *   renewalCycleId: string;
 *   paymentMethod: string;
 *   providerApi: import("../providers/BillingProvider.js").BillingProvider;
 *   remoteIp?: string | null;
 *   paymentMethodId?: string | null;
 *   card?: Record<string, unknown> | null;
 * }} ctx
 */
export async function payRenewalCycle(ctx) {
  const cycle = await getRenewalCycleForUser(ctx.supabase, ctx.renewalCycleId, ctx.user.id);
  if (!cycle) {
    const err = new Error("RENEWAL_CYCLE_NOT_FOUND");
    /** @type {any} */ (err).code = "RENEWAL_CYCLE_NOT_FOUND";
    throw err;
  }

  if (!PAYABLE_CYCLE_STATUSES.has(String(cycle.renewal_status))) {
    const err = new Error("RENEWAL_CYCLE_NOT_PAYABLE");
    /** @type {any} */ (err).code = "RENEWAL_CYCLE_NOT_PAYABLE";
    throw err;
  }

  const { data: subscription, error: subErr } = await ctx.supabase
    .from("billing_subscriptions")
    .select("*")
    .eq("id", cycle.subscription_id)
    .eq("user_id", ctx.user.id)
    .maybeSingle();
  if (subErr) throw subErr;
  if (!subscription) {
    const err = new Error("SUBSCRIPTION_NOT_FOUND");
    /** @type {any} */ (err).code = "SUBSCRIPTION_NOT_FOUND";
    throw err;
  }

  const plan = await getActivePlanById(ctx.supabase, String(subscription.plan_id));
  if (!plan?.id) {
    const err = new Error("PLAN_NOT_FOUND");
    /** @type {any} */ (err).code = "PLAN_NOT_FOUND";
    throw err;
  }

  if (String(plan.plan_key) !== String(cycle.current_plan_key)) {
    const err = new Error("RENEWAL_PLAN_MISMATCH");
    /** @type {any} */ (err).code = "RENEWAL_PLAN_MISMATCH";
    throw err;
  }

  const paymentMethod = normalizeCheckoutPaymentMethod(ctx.paymentMethod);

  if (cycle.generated_payment_id) {
    return buildCheckoutFromExistingRenewalPayment(
      ctx.supabase,
      /** @type {Record<string, unknown>} */ (cycle),
      plan,
      /** @type {Record<string, unknown>} */ (subscription),
      paymentMethod,
      ctx.providerApi
    );
  }

  const dueDateIso = new Date().toISOString().slice(0, 10);

  const created = await createRenewalCyclePayment(
    ctx.supabase,
    /** @type {Record<string, unknown>} */ (subscription),
    plan,
    /** @type {Record<string, unknown>} */ (cycle),
    ctx.providerApi,
    {
      paymentMethod,
      dueDateIso,
      remoteIp: ctx.remoteIp,
      paymentMethodId: ctx.paymentMethodId,
      card: ctx.card,
      source: "renewal_pay",
    }
  );

  const mapped = mapCheckoutStartResponse(
    {
      kind: "paid",
      subscription,
      asaas: { firstPayment: created.asaasPayment },
    },
    plan,
    paymentMethod
  );

  if (paymentMethod === "PIX" && created.payment?.provider_payment_id) {
    const pix = await fetchPixCheckoutPayload(ctx.providerApi, String(created.payment.provider_payment_id));
    if (pix) mapped.pix = pix;
  }
  if (paymentMethod === "BOLETO" && created.payment?.provider_payment_id) {
    const boleto = await fetchBoletoCheckoutPayload(ctx.providerApi, String(created.payment.provider_payment_id));
    if (boleto) mapped.boleto = boleto;
  }

  if (paymentMethod === "CREDIT_CARD" && created.confirmed) {
    mapped.kind = "paid";
  }

  return {
    renewal_cycle_id: String(cycle.id),
    plan_key: plan.plan_key,
    payment_method: paymentMethod,
    checkout: mapped,
    reused_existing_payment: false,
  };
}
