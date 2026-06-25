// ======================================================================
// billingSubscriptionService — checkout (preço e limites só do DB)
// ======================================================================

import Decimal from "decimal.js";
import { decimalToScale2String, isZeroMoney, toDecimal } from "../utils/moneyDecimal.js";
import { logBilling, logBillingError } from "../billingLog.js";
import { ensureBillingCustomerForUser } from "./billingCustomerService.js";
import { resolveSubscriptionBillingCycle } from "./billingCycleService.js";
import { getActivePlanById, getActivePlanByKey } from "./billingPlanRepository.js";
import { SUBSCRIPTION_STATUS, SUBSCRIPTION_STATUS_SUPERSEDED } from "../billingConstants.js";
import {
  buildAsaasCheckoutIdempotencyKey,
  findReusablePendingAsaasCheckout,
  logAsaasPaymentCreateAudit,
  logAsaasPaymentReuseAudit,
} from "./billingCheckoutIdempotencyService.js";
import { resolveSellerCreditCardToken } from "./billingCardPaymentMethodService.js";
import {
  activateSubscriptionFromPaidPayment,
  isAsaasPaymentConfirmedStatus,
} from "./billingSubscriptionActivationService.js";
import { sanitizeBillingCardPayload } from "../utils/billingCardSanitize.js";
import { assertCreditCardCheckoutOnly } from "../utils/billingCheckoutGuards.js";
import { cancelOrphanAsaasSubscriptionsForUser } from "./billingOrphanAsaasSubscriptionService.js";

function addDaysUtcIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Assinaturas Asaas no Suse7 são mensais até existir coluna de ciclo em `plans`. */
function mapAsaasCycle() {
  return "MONTHLY";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function deactivateSupersededSubscriptions(supabase, userId) {
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({
      status: SUBSCRIPTION_STATUS.CANCELED,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .in("status", SUBSCRIPTION_STATUS_SUPERSEDED);
  if (error) throw error;
}

/**
 * @param {string} raw
 * @returns {"BOLETO" | "PIX" | "CREDIT_CARD"}
 */
export function normalizeCheckoutPaymentMethod(raw) {
  const pm = String(raw || "BOLETO")
    .trim()
    .toUpperCase();
  if (pm === "PIX") return "PIX";
  if (pm === "CREDIT_CARD" || pm === "CREDIT") return "CREDIT_CARD";
  return "BOLETO";
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> };
 *   planKey?: string | null;
 *   planId?: string | null;
 *   paymentMethod?: string | null;
 *   providerApi: import("../providers/BillingProvider.js").BillingProvider;
 *   providerKey: string;
 *   supersedeMode?: "checkout" | "defer";
 *   explicitUserAction?: boolean;
 *   auditRoute?: string | null;
 *   auditRequestId?: string | null;
 *   cardCheckout?: {
 *     remoteIp: string;
 *     payment_method_id?: string | null;
 *     card?: Record<string, unknown> | null;
 *     cpf_cnpj?: string | null;
 *     postal_code?: string | null;
 *     address_number?: string | null;
 *     phone?: string | null;
 *     set_default?: boolean;
 *     persist?: boolean;
 *     card_type?: "credit" | "debit";
 *   } | null;
 * }} ctx
 */
export async function checkoutPlan(ctx) {
  const {
    supabase,
    user,
    planKey,
    planId,
    paymentMethod,
    providerApi,
    providerKey,
    supersedeMode = "checkout",
    explicitUserAction = false,
    auditRoute = null,
    auditRequestId = null,
    cardCheckout = null,
  } = ctx;

  if (explicitUserAction !== true) {
    const err = new Error("EXPLICIT_USER_ACTION_REQUIRED");
    /** @type {any} */ (err).code = "EXPLICIT_USER_ACTION_REQUIRED";
    throw err;
  }

  const pk = planKey != null && String(planKey).trim() !== "" ? String(planKey).trim() : null;
  const pid = planId != null && String(planId).trim() !== "" ? String(planId).trim() : null;

  /** @type {import("./billingPlanRepository.js").Suse7PlanRow | null} */
  let plan = null;
  if (pk) {
    plan = await getActivePlanByKey(supabase, pk);
  } else if (pid) {
    plan = await getActivePlanById(supabase, pid);
  } else {
    const err = new Error("PLAN_KEY_OR_ID_REQUIRED");
    /** @type {any} */ (err).code = "PLAN_KEY_OR_ID_REQUIRED";
    throw err;
  }

  if (!plan) {
    const err = new Error("PLAN_NOT_FOUND");
    /** @type {any} */ (err).code = "PLAN_NOT_FOUND";
    throw err;
  }

  const price = toDecimal(plan.price_monthly);
  const salesLimit =
    plan.sales_limit_monthly != null && Number.isFinite(Number(plan.sales_limit_monthly))
      ? Number(plan.sales_limit_monthly)
      : null;

  const paymentMethodResolved = normalizeCheckoutPaymentMethod(paymentMethod);
  assertCreditCardCheckoutOnly(paymentMethod, cardCheckout?.card_type);

  /** Plano sem cobrança no gateway (ex.: baby). */
  if (plan.billing_required === false) {
    const baseMetadata = {
      plan_key: plan.plan_key,
      sales_limit_monthly: salesLimit,
      payment_method: paymentMethodResolved,
      source: "checkout",
    };
    if (supersedeMode !== "defer") {
      await deactivateSupersededSubscriptions(supabase, user.id);
    }
    const now = new Date();
    const cycle = resolveSubscriptionBillingCycle({ created_at: now.toISOString() }, now);
    const row = {
      user_id: user.id,
      plan_id: plan.id,
      plan_key: plan.plan_key,
      provider: "internal",
      provider_customer_id: "internal",
      provider_subscription_id: null,
      status: SUBSCRIPTION_STATUS.INTERNAL_FREE,
      amount: decimalToScale2String(price),
      currency: "BRL",
      current_period_start: cycle.current_period_start,
      current_period_end: cycle.current_period_end,
      next_due_date: cycle.next_billing_at.slice(0, 10),
      metadata: { ...baseMetadata, internal: true, billing_cycle_anchor: cycle.billing_cycle_anchor },
      updated_at: now.toISOString(),
    };
    const { data, error } = await supabase.from("billing_subscriptions").insert(row).select("*").single();
    if (error) throw error;
    logBilling("billing", "checkout_internal_ok", { user_id: user.id, plan_key: plan.plan_key });
    return { kind: "internal_free", subscription: data };
  }

  /** Cobrança via gateway (Asaas). */
  if (plan.billing_required === true && providerKey === "asaas") {
    const baseMetadata = {
      plan_key: plan.plan_key,
      sales_limit_monthly: salesLimit,
      payment_method: paymentMethodResolved,
      source: "checkout",
    };

    providerApi.assertConfigured();

    if (isZeroMoney(plan.price_monthly)) {
      const err = new Error("Plano com billing_required exige price_monthly > 0");
      /** @type {any} */ (err).code = "PLAN_PRICE_INVALID";
      throw err;
    }

    const valueStr = decimalToScale2String(price);
    const idempotencyKey = buildAsaasCheckoutIdempotencyKey(user.id, plan.id, paymentMethodResolved);

    const reusable = await findReusablePendingAsaasCheckout(
      supabase,
      user.id,
      plan.id,
      plan.plan_key,
      paymentMethodResolved,
    );
    if (reusable?.subscription) {
      logAsaasPaymentReuseAudit({
        user_id: user.id,
        plan_key: plan.plan_key,
        payment_method: paymentMethodResolved,
        subscription_id: String(reusable.subscription.id),
        payment_id: reusable.payment?.id != null ? String(reusable.payment.id) : null,
        provider_payment_id:
          reusable.payment?.provider_payment_id != null ? String(reusable.payment.provider_payment_id) : null,
        idempotency_key: reusable.idempotency_key,
      });
      return { kind: "paid", subscription: reusable.subscription, asaas: reusable.asaas, reused_checkout: true };
    }

    logAsaasPaymentCreateAudit({
      user_id: user.id,
      plan_id: plan.id,
      plan_key: plan.plan_key,
      payment_method: paymentMethodResolved,
      amount: valueStr,
      route: auditRoute,
      request_id: auditRequestId,
    });

    await cancelOrphanAsaasSubscriptionsForUser(
      supabase,
      providerApi,
      user.id,
      { plan_id: plan.id, plan_key: plan.plan_key },
      "checkout_supersede_other_plans"
    );

    /** Plano atual permanece até pagamento confirmado (webhook/refresh). */
    const customer = await ensureBillingCustomerForUser(supabase, providerApi, providerKey, user);
    const todayIso = new Date().toISOString().slice(0, 10);
    const nextDueDate = paymentMethodResolved === "CREDIT_CARD" ? todayIso : addDaysUtcIso(3);

    /** @type {Record<string, unknown>} */
    const asaasBody = {
      customer: customer.provider_customer_id,
      billingType: paymentMethodResolved,
      value: valueStr,
      nextDueDate,
      cycle: mapAsaasCycle(),
      description: `Suse7 — ${plan.name}`,
      externalReference: `${user.id}:${plan.id}`,
    };

    if (paymentMethodResolved === "CREDIT_CARD") {
      if (!cardCheckout?.remoteIp) {
        const err = new Error("REMOTE_IP_REQUIRED");
        /** @type {any} */ (err).code = "REMOTE_IP_REQUIRED";
        throw err;
      }

      logBilling("billing", "BILLING_CARD_CHECKOUT_CREATE", {
        user_id: user.id,
        plan_key: plan.plan_key,
        route: auditRoute,
      });

      let creditCardToken;
      try {
        const resolved = await resolveSellerCreditCardToken(
          supabase,
          providerApi,
          user,
          {
            payment_method_id: cardCheckout.payment_method_id ?? null,
            card: cardCheckout.card ?? null,
            card_type: "CREDIT",
            cpf_cnpj: cardCheckout.cpf_cnpj ?? undefined,
            postal_code: cardCheckout.postal_code ?? undefined,
            address_number: cardCheckout.address_number ?? undefined,
            phone: cardCheckout.phone ?? undefined,
            set_default: cardCheckout.set_default,
            persist: cardCheckout.persist !== false,
            expectedCardType: "CREDIT",
            requireAutoRenew: true,
            audit: {
              user_id: user.id,
              plan_key: plan.plan_key,
              card_type: "CREDIT",
              request_id: auditRequestId ?? undefined,
            },
          },
          cardCheckout.remoteIp
        );
        creditCardToken = resolved.creditCardToken;
      } catch (error) {
        logBillingError("billing", "BILLING_CARD_CHECKOUT_FAILED", error, {
          user_id: user.id,
          plan_key: plan.plan_key,
        });
        throw error;
      }

      asaasBody.creditCardToken = creditCardToken;
      asaasBody.remoteIp = cardCheckout.remoteIp;
    }

    const asaasSub = await providerApi.createSubscription(asaasBody);
    const subId =
      asaasSub && typeof asaasSub === "object" && typeof /** @type {{ id?: unknown }} */ (asaasSub).id === "string"
        ? String(/** @type {{ id?: string }} */ (asaasSub).id)
        : null;
    if (!subId) {
      throw new Error("Asaas não retornou id da assinatura");
    }

    let firstPayment =
      asaasSub && typeof asaasSub === "object"
        ? /** @type {{ firstPayment?: unknown; first_payment?: unknown }} */ (asaasSub).firstPayment ??
          /** @type {{ firstPayment?: unknown; first_payment?: unknown }} */ (asaasSub).first_payment
        : null;
    if (!firstPayment && typeof providerApi.listSubscriptionPayments === "function") {
      const paymentList = await providerApi.listSubscriptionPayments(subId, { limit: 1 });
      const rows =
        paymentList && typeof paymentList === "object" && Array.isArray(/** @type {{ data?: unknown[] }} */ (paymentList).data)
          ? /** @type {{ data: unknown[] }} */ (paymentList).data
          : [];
      firstPayment = rows[0] ?? null;
    }

    const asaasWithPayment =
      asaasSub && typeof asaasSub === "object"
        ? { .../** @type {Record<string, unknown>} */ (asaasSub), firstPayment }
        : { firstPayment };

    const remoteStatus =
      asaasSub && typeof asaasSub === "object" && typeof /** @type {{ status?: unknown }} */ (asaasSub).status === "string"
        ? String(/** @type {{ status?: string }} */ (asaasSub).status).toUpperCase()
        : "PENDING";

    const pay =
      asaasWithPayment && typeof asaasWithPayment === "object"
        ? /** @type {{ firstPayment?: { id?: string; status?: string } }} */ (asaasWithPayment).firstPayment
        : null;
    const firstPayId = pay && typeof pay.id === "string" ? pay.id : null;
    const firstPayRemoteStatus = pay && typeof pay.status === "string" ? String(pay.status) : null;
    const firstPaymentConfirmed = isAsaasPaymentConfirmedStatus(firstPayRemoteStatus);

    /** Pix/boleto: pending até webhook. Cartão aprovado na hora pode ativar. */
    let localStatus = firstPaymentConfirmed ? SUBSCRIPTION_STATUS.ACTIVE : SUBSCRIPTION_STATUS.PENDING;

    const row = {
      user_id: user.id,
      plan_id: plan.id,
      plan_key: plan.plan_key,
      provider: providerKey,
      provider_customer_id: customer.provider_customer_id,
      provider_subscription_id: subId,
      status: localStatus,
      amount: valueStr,
      currency: "BRL",
      next_due_date: nextDueDate,
      metadata: { ...baseMetadata, asaas: { remote_status: remoteStatus } },
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from("billing_subscriptions").insert(row).select("*").single();
    if (error) throw error;

    if (firstPayId) {
      const payIns = {
        user_id: user.id,
        subscription_id: data.id,
        provider: providerKey,
        provider_payment_id: firstPayId,
        status: firstPaymentConfirmed ? "CONFIRMED" : "PENDING",
        amount: valueStr,
        currency: "BRL",
        event_type_snapshot: "CHECKOUT_FIRST",
        raw_payload:
          pay && typeof pay === "object" ? sanitizeBillingCardPayload(pay) : sanitizeBillingCardPayload(asaasWithPayment),
        paid_at: firstPaymentConfirmed ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      };
      const pe = await supabase
        .from("billing_payments")
        .upsert(payIns, { onConflict: "provider,provider_payment_id" })
        .select("id")
        .maybeSingle();
      if (pe.error) {
        logBillingError("billing", "checkout_first_payment_upsert_failed", pe.error, { user_id: user.id });
      }

      if (firstPaymentConfirmed && pe.data?.id) {
        try {
          await activateSubscriptionFromPaidPayment(supabase, {
            paymentId: String(pe.data.id),
            userId: user.id,
            subscriptionId: String(data.id),
            providerPaymentId: firstPayId,
            nextDueDate,
            paidAt: new Date().toISOString(),
            source: "card_checkout",
          });
        } catch (activationError) {
          logBillingError("billing", "card_checkout_activation_failed", activationError, {
            user_id: user.id,
            subscription_id: data.id,
          });
        }
      }
    }

    logBilling("billing", "checkout_paid_ok", {
      user_id: user.id,
      plan_key: plan.plan_key,
      subscription_id: data.id,
      idempotency_key: idempotencyKey,
      asaas_payment_id: firstPayId,
    });
    return { kind: "paid", subscription: data, asaas: asaasWithPayment };
  }

  const err = new Error("Plano exige billing_required=true com gateway não suportado nesta rota.");
  /** @type {any} */ (err).code = "PLAN_BILLING_CONFIG";
  throw err;
}
