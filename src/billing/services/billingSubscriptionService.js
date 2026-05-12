// ======================================================================
// billingSubscriptionService — checkout (preço e limites só do DB)
// ======================================================================

import Decimal from "decimal.js";
import { decimalToScale2String, isZeroMoney, toDecimal } from "../utils/moneyDecimal.js";
import { logBilling, logBillingError } from "../billingLog.js";
import { ensureBillingCustomerForUser } from "./billingCustomerService.js";
import { getActivePlanById, getActivePlanByKey } from "./billingPlanRepository.js";
import { SUBSCRIPTION_STATUS, SUBSCRIPTION_STATUS_SUPERSEDED } from "../billingConstants.js";

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
  if (pm === "CREDIT_CARD") return "CREDIT_CARD";
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
 * }} ctx
 */
export async function checkoutPlan(ctx) {
  const { supabase, user, planKey, planId, paymentMethod, providerApi, providerKey } = ctx;

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

  /** Plano sem cobrança no gateway (ex.: baby). */
  if (plan.billing_required === false) {
    const baseMetadata = {
      plan_key: plan.plan_key,
      sales_limit_monthly: salesLimit,
      payment_method: paymentMethodResolved,
      source: "checkout",
    };
    await deactivateSupersededSubscriptions(supabase, user.id);
    const row = {
      user_id: user.id,
      plan_id: plan.id,
      provider: "internal",
      provider_customer_id: "internal",
      provider_subscription_id: null,
      status: SUBSCRIPTION_STATUS.INTERNAL_FREE,
      amount: decimalToScale2String(price),
      currency: "BRL",
      metadata: { ...baseMetadata, internal: true },
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from("billing_subscriptions").insert(row).select("*").single();
    if (error) throw error;
    logBilling("billing", "checkout_internal_ok", { user_id: user.id, plan_key: plan.plan_key });
    return { kind: "internal_free", subscription: data };
  }

  /** Cobrança via gateway (Asaas). */
  if (plan.billing_required === true && providerKey === "asaas") {
    if (paymentMethodResolved === "CREDIT_CARD") {
      const err = new Error("CREDIT_CARD_NOT_SUPPORTED_YET");
      /** @type {any} */ (err).code = "CREDIT_CARD_NOT_SUPPORTED_YET";
      throw err;
    }

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

    await deactivateSupersededSubscriptions(supabase, user.id);
    const customer = await ensureBillingCustomerForUser(supabase, providerApi, providerKey, user);
    const valueStr = decimalToScale2String(price);
    const nextDueDate = addDaysUtcIso(3);
    const asaasBody = {
      customer: customer.provider_customer_id,
      billingType: paymentMethodResolved,
      value: valueStr,
      nextDueDate,
      cycle: mapAsaasCycle(),
      description: `Suse7 — ${plan.name}`,
      externalReference: `${user.id}:${plan.id}`,
    };

    logBilling("billing", "checkout_paid_asaas_create_subscription", {
      user_id: user.id,
      plan_key: plan.plan_key,
      billing_type: paymentMethodResolved,
    });

    const asaasSub = await providerApi.createSubscription(asaasBody);
    const subId =
      asaasSub && typeof asaasSub === "object" && typeof /** @type {{ id?: unknown }} */ (asaasSub).id === "string"
        ? String(/** @type {{ id?: string }} */ (asaasSub).id)
        : null;
    if (!subId) {
      throw new Error("Asaas não retornou id da assinatura");
    }

    const remoteStatus =
      asaasSub && typeof asaasSub === "object" && typeof /** @type {{ status?: unknown }} */ (asaasSub).status === "string"
        ? String(/** @type {{ status?: string }} */ (asaasSub).status).toUpperCase()
        : "PENDING";

    const localStatus = remoteStatus === "ACTIVE" ? SUBSCRIPTION_STATUS.ACTIVE : SUBSCRIPTION_STATUS.PENDING;

    const row = {
      user_id: user.id,
      plan_id: plan.id,
      provider: providerKey,
      provider_customer_id: customer.provider_customer_id,
      provider_subscription_id: subId,
      status: localStatus,
      amount: valueStr,
      currency: "BRL",
      metadata: { ...baseMetadata, asaas: { remote_status: remoteStatus } },
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from("billing_subscriptions").insert(row).select("*").single();
    if (error) throw error;

    const pay =
      asaasSub && typeof asaasSub === "object" ? /** @type {{ firstPayment?: { id?: string } }} */ (asaasSub).firstPayment : null;
    const firstPayId = pay && typeof pay.id === "string" ? pay.id : null;
    if (firstPayId) {
      const payIns = {
        user_id: user.id,
        subscription_id: data.id,
        provider: providerKey,
        provider_payment_id: firstPayId,
        status: "PENDING",
        amount: valueStr,
        currency: "BRL",
        event_type_snapshot: "CHECKOUT_FIRST",
        raw_payload: asaasSub,
        updated_at: new Date().toISOString(),
      };
      const pe = await supabase.from("billing_payments").upsert(payIns, { onConflict: "provider,provider_payment_id" });
      if (pe.error) {
        logBillingError("billing", "checkout_first_payment_upsert_failed", pe.error, { user_id: user.id });
      }
    }

    logBilling("billing", "checkout_paid_ok", { user_id: user.id, plan_key: plan.plan_key, subscription_id: data.id });
    return { kind: "paid", subscription: data, asaas: asaasSub };
  }

  const err = new Error("Plano exige billing_required=true com gateway não suportado nesta rota.");
  /** @type {any} */ (err).code = "PLAN_BILLING_CONFIG";
  throw err;
}
