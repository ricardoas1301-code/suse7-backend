// ======================================================================
// POST /api/billing/renewals/:renewal_cycle_id/pay
// ======================================================================

import { logBilling } from "../billingLog.js";
import { RENEWAL_STATUS } from "../billingConstants.js";
import { getRenewalCycleForUser } from "./billingRenewalCycleRepository.js";
import { getActivePlanById } from "./billingPlanRepository.js";
import { createRenewalCyclePayment } from "./billingRenewalPaymentService.js";
import { fetchPixCheckoutPayload } from "./billingPixCheckoutService.js";
import { fetchBoletoCheckoutPayload } from "./billingBoletoCheckoutService.js";
import { mapCheckoutStartResponse } from "./billingCheckoutResponse.js";
import { normalizeCheckoutPaymentMethod } from "./billingSubscriptionService.js";
import { loadCanonicalBillableSubscriptionContext } from "./billingCanonicalSubscriptionService.js";
import { resolveRenewalChargeDueDatePolicy } from "./billingPaymentDueDatePolicy.js";
import { findExistingRenewalCyclePayment } from "./billingRenewalIdempotencyService.js";
import {
  applyRecurringCardPreferenceAfterConfirmedPayment,
  recordRenewalRecurringConsent,
  RECURRING_CONSENT_RULE_VERSION,
} from "./billingRenewalRecurringConsentService.js";
import { updateRenewalCycle } from "./billingRenewalCycleRepository.js";

const PAYABLE_CYCLE_STATUSES = new Set([
  RENEWAL_STATUS.SCHEDULED,
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
 *   recurringConsent?: boolean;
 *   correlationId?: string | null;
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

  const { canonicalSubscriptionId } = await loadCanonicalBillableSubscriptionContext(ctx.supabase, ctx.user.id);
  if (canonicalSubscriptionId && String(subscription.id) !== canonicalSubscriptionId) {
    const err = new Error("RENEWAL_CYCLE_NOT_PAYABLE");
    /** @type {any} */ (err).code = "RENEWAL_CYCLE_NOT_PAYABLE";
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

  if (paymentMethod === "CREDIT_CARD" && ctx.recurringConsent !== true) {
    const err = new Error("RECURRING_CONSENT_REQUIRED");
    /** @type {any} */ (err).code = "RECURRING_CONSENT_REQUIRED";
    throw err;
  }

  logBilling("billing", "BILLING_RENEWAL_PAYMENT_REQUESTED", {
    user_id: ctx.user.id,
    renewal_cycle_id: String(cycle.id),
    subscription_id: String(subscription.id),
    payment_method: paymentMethod,
    renewal_status: String(cycle.renewal_status),
  });

  if (cycle.generated_payment_id) {
    logBilling("billing", "BILLING_RENEWAL_PAYMENT_REUSED", {
      user_id: ctx.user.id,
      renewal_cycle_id: String(cycle.id),
      generated_payment_id: String(cycle.generated_payment_id),
      payment_method: paymentMethod,
    });
    return buildCheckoutFromExistingRenewalPayment(
      ctx.supabase,
      /** @type {Record<string, unknown>} */ (cycle),
      plan,
      /** @type {Record<string, unknown>} */ (subscription),
      paymentMethod,
      ctx.providerApi
    );
  }

  const duePolicy = resolveRenewalChargeDueDatePolicy({
    cycleDueDate: cycle.renewal_due_date ?? subscription.next_due_date,
    paymentMethod,
  });
  const dueDateIso = duePolicy.due_date ?? new Date().toISOString().slice(0, 10);
  const cycleStart = String(cycle.cycle_start).slice(0, 10);

  const existingPayment = await findExistingRenewalCyclePayment(ctx.supabase, {
    userId: ctx.user.id,
    subscriptionId: String(subscription.id),
    planId: String(plan.id),
    billingCycleStart: cycleStart,
    paymentMethod,
  });

  if (existingPayment?.payment?.id) {
    if (!cycle.generated_payment_id) {
      await updateRenewalCycle(ctx.supabase, String(cycle.id), {
        generated_payment_id: existingPayment.payment.id,
        provider_payment_id: existingPayment.payment.provider_payment_id ?? null,
      });
    }
    logBilling("billing", "BILLING_RENEWAL_PAYMENT_IDEMPOTENCY_HIT", {
      user_id: ctx.user.id,
      renewal_cycle_id: String(cycle.id),
      payment_id: String(existingPayment.payment.id),
      idempotency_key: existingPayment.idempotency_key,
      payment_method: paymentMethod,
    });
    return buildCheckoutFromExistingRenewalPayment(
      ctx.supabase,
      {
        ...cycle,
        generated_payment_id: existingPayment.payment.id,
      },
      plan,
      /** @type {Record<string, unknown>} */ (subscription),
      paymentMethod,
      ctx.providerApi
    );
  }

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
      recurringConsent: ctx.recurringConsent === true,
      correlationId: ctx.correlationId ?? null,
      consentRuleVersion: RECURRING_CONSENT_RULE_VERSION,
    }
  );

  if (paymentMethod === "CREDIT_CARD" && ctx.recurringConsent === true) {
    await recordRenewalRecurringConsent(ctx.supabase, {
      userId: ctx.user.id,
      subscriptionId: String(subscription.id),
      renewalCycleId: String(cycle.id),
      paymentMethodId: ctx.paymentMethodId ?? null,
      correlationId: ctx.correlationId ?? null,
    });
  }

  if (paymentMethod === "CREDIT_CARD" && created.confirmed && ctx.recurringConsent === true) {
    await applyRecurringCardPreferenceAfterConfirmedPayment(ctx.supabase, String(subscription.id), {
      paymentMethod: "CREDIT_CARD",
      paymentMethodId: ctx.paymentMethodId ?? null,
      correlationId: ctx.correlationId ?? null,
    });
  }

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

  logBilling("billing", "BILLING_RENEWAL_PAYMENT_CREATED", {
    user_id: ctx.user.id,
    renewal_cycle_id: String(cycle.id),
    payment_id: created.payment?.id ?? null,
    provider_payment_id: created.payment?.provider_payment_id ?? null,
    payment_method: paymentMethod,
    reused_existing_payment: false,
  });

  return {
    renewal_cycle_id: String(cycle.id),
    plan_key: plan.plan_key,
    payment_method: paymentMethod,
    checkout: mapped,
    reused_existing_payment: false,
  };
}
