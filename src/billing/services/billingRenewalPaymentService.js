// ======================================================================
// Cobrança de renovação — pagamento avulso (não escolhe plano)
// ======================================================================

import Decimal from "decimal.js";
import { logBilling, logBillingError } from "../billingLog.js";
import { RENEWAL_ENGINE_LOG, RENEWAL_STATUS } from "../billingConstants.js";
import { decimalToScale2String, toDecimal } from "../utils/moneyDecimal.js";
import { ensureBillingCustomerForUser } from "./billingCustomerService.js";
import { getActivePlanById } from "./billingPlanRepository.js";
import { assertRenewalPlanMatchesActiveSubscription } from "./billingRenewalService.js";
import { updateRenewalCycle } from "./billingRenewalCycleRepository.js";
import { normalizeCheckoutPaymentMethod } from "./billingSubscriptionService.js";
import { isAsaasPaymentConfirmedStatus } from "./billingSubscriptionActivationService.js";
import { sanitizeBillingCardPayload } from "../utils/billingCardSanitize.js";
import { resolveSellerCreditCardToken } from "./billingCardPaymentMethodService.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 * @param {import("./billingPlanRepository.js").Suse7PlanRow} plan
 * @param {Record<string, unknown>} cycle
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {{
 *   paymentMethod: string;
 *   dueDateIso: string;
 *   remoteIp?: string | null;
 *   paymentMethodId?: string | null;
 *   card?: Record<string, unknown> | null;
 * }} options
 */
export async function createRenewalCyclePayment(supabase, subscription, plan, cycle, providerApi, options) {
  const userId = String(subscription.user_id);
  const subscriptionId = String(subscription.id);
  const planId = String(plan.id);
  assertRenewalPlanMatchesActiveSubscription(subscription, planId);

  const paymentMethod = normalizeCheckoutPaymentMethod(options.paymentMethod);
  const valueStr = decimalToScale2String(toDecimal(plan.price_monthly));
  if (new Decimal(valueStr).lte(0)) {
    const err = new Error("PLAN_PRICE_INVALID");
    /** @type {any} */ (err).code = "PLAN_PRICE_INVALID";
    throw err;
  }

  providerApi.assertConfigured();
  const user = { id: userId, email: null, user_metadata: {} };
  const customer = await ensureBillingCustomerForUser(supabase, providerApi, "asaas", user);

  const cycleStart = String(cycle.cycle_start).slice(0, 10);
  /** @type {Record<string, unknown>} */
  const asaasBody = {
    customer: customer.provider_customer_id,
    billingType: paymentMethod,
    value: valueStr,
    dueDate: options.dueDateIso,
    description: `Suse7 — Renovação ${plan.plan_key}`,
    externalReference: `renewal:${cycle.id}:${userId}:${planId}`,
  };

  if (paymentMethod === "CREDIT_CARD") {
    if (!options.remoteIp) {
      const err = new Error("REMOTE_IP_REQUIRED");
      /** @type {any} */ (err).code = "REMOTE_IP_REQUIRED";
      throw err;
    }
    const resolved = await resolveSellerCreditCardToken(
      supabase,
      providerApi,
      user,
      {
        payment_method_id: options.paymentMethodId ?? null,
        card: options.card ?? null,
        card_type: "CREDIT",
        requireAutoRenew: false,
        persist: false,
        audit: { user_id: userId, plan_key: plan.plan_key, route: "renewal_pay" },
      },
      options.remoteIp
    );
    asaasBody.creditCardToken = resolved.creditCardToken;
    asaasBody.remoteIp = options.remoteIp;
  }

  const asaasPayment = await providerApi.createPayment(asaasBody);
  const providerPaymentId =
    asaasPayment && typeof asaasPayment === "object" && typeof /** @type {{ id?: unknown }} */ (asaasPayment).id === "string"
      ? String(/** @type {{ id?: string }} */ (asaasPayment).id)
      : null;
  if (!providerPaymentId) {
    throw new Error("Asaas não retornou id do pagamento de renovação");
  }

  const remoteStatus =
    asaasPayment && typeof asaasPayment === "object" && typeof /** @type {{ status?: unknown }} */ (asaasPayment).status === "string"
      ? String(/** @type {{ status?: string }} */ (asaasPayment).status)
      : "PENDING";
  const confirmed = isAsaasPaymentConfirmedStatus(remoteStatus);

  const payRow = {
    user_id: userId,
    subscription_id: subscriptionId,
    provider: "asaas",
    provider_payment_id: providerPaymentId,
    status: confirmed ? "CONFIRMED" : "PENDING",
    amount: valueStr,
    currency: "BRL",
    event_type_snapshot: "RENEWAL_CHARGE",
    raw_payload: {
      ...sanitizeBillingCardPayload(asaasPayment),
      billing_cycle_start: cycleStart,
      billing_cycle_end: String(cycle.cycle_end).slice(0, 10),
      plan_id: planId,
      plan_key: plan.plan_key,
      payment_method: paymentMethod,
      renewal_cycle_id: String(cycle.id),
      source: options.source ?? "renewal_engine",
    },
    paid_at: confirmed ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };

  const { data: payment, error: payErr } = await supabase
    .from("billing_payments")
    .upsert(payRow, { onConflict: "provider,provider_payment_id" })
    .select("id, provider_payment_id, status")
    .single();
  if (payErr) throw payErr;

  await updateRenewalCycle(supabase, String(cycle.id), {
    generated_payment_id: payment.id,
    provider_payment_id: providerPaymentId,
    renewal_status: confirmed ? RENEWAL_STATUS.PAID : RENEWAL_STATUS.PENDING_PAYMENT,
  });

  logBilling("billing", RENEWAL_ENGINE_LOG.PAYMENT_CREATED, {
    user_id: userId,
    subscription_id: subscriptionId,
    renewal_cycle_id: String(cycle.id),
    payment_id: payment.id,
    provider_payment_id: providerPaymentId,
    payment_method: paymentMethod,
    plan_key: plan.plan_key,
  });

  return { payment, asaasPayment, confirmed, paymentMethod };
}

/**
 * Tentativa automática com cartão salvo (token Asaas).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 * @param {import("./billingPlanRepository.js").Suse7PlanRow} plan
 * @param {Record<string, unknown>} cycle
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {{ defaultPaymentMethodId?: string | null; remoteIp?: string }} ctx
 */
export async function attemptAutoCardRenewalCharge(supabase, subscription, plan, cycle, providerApi, ctx) {
  const now = new Date().toISOString();
  await updateRenewalCycle(supabase, String(cycle.id), {
    auto_charge_attempted_at: now,
    auto_charge_status: "PROCESSING",
    renewal_status: "AUTO_CHARGE_PROCESSING",
  });

  logBilling("billing", RENEWAL_ENGINE_LOG.AUTO_CHARGE_ATTEMPTED, {
    user_id: subscription.user_id,
    subscription_id: subscription.id,
    renewal_cycle_id: cycle.id,
    plan_key: plan.plan_key,
  });

  try {
    const dueDateIso = new Date().toISOString().slice(0, 10);
    const result = await createRenewalCyclePayment(supabase, subscription, plan, cycle, providerApi, {
      paymentMethod: "CREDIT_CARD",
      dueDateIso,
      remoteIp: ctx.remoteIp ?? "127.0.0.1",
      paymentMethodId: ctx.defaultPaymentMethodId ?? null,
    });

    if (result.confirmed) {
      await updateRenewalCycle(supabase, String(cycle.id), {
        renewal_status: "PAID",
        auto_charge_status: "PAID",
      });
      logBilling("billing", RENEWAL_ENGINE_LOG.AUTO_CHARGE_PAID, {
        user_id: subscription.user_id,
        renewal_cycle_id: cycle.id,
        payment_id: result.payment.id,
      });
      return { ok: true, paid: true, payment: result.payment };
    }

    await updateRenewalCycle(supabase, String(cycle.id), {
      renewal_status: "PENDING_PAYMENT",
      auto_charge_status: "PROCESSING",
    });
    return { ok: true, paid: false, payment: result.payment };
  } catch (error) {
    logBillingError("billing", RENEWAL_ENGINE_LOG.AUTO_CHARGE_FAILED, error, {
      user_id: subscription.user_id,
      renewal_cycle_id: cycle.id,
    });
    await updateRenewalCycle(supabase, String(cycle.id), {
      renewal_status: "PAYMENT_FAILED",
      auto_charge_status: "FAILED",
      retry_count: Number(cycle.retry_count ?? 0) + 1,
      next_retry_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    return { ok: false, paid: false, error: error instanceof Error ? error.message : String(error) };
  }
}
