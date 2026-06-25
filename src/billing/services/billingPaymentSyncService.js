// ======================================================================

// Sincroniza cobrança com Asaas e ativa assinatura somente se pago

// ======================================================================



import { logBilling, logBillingError } from "../billingLog.js";

import {

  activateSubscriptionFromPaidPayment,

  isAsaasPaymentConfirmedStatus,

} from "./billingSubscriptionActivationService.js";

import { emitBillingCommunicationPlaceholder } from "./billingPixCheckoutService.js";



/**

 * @param {unknown} value

 */

function asTrimmedString(value) {

  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;

}



/**

 * @param {unknown} value

 */

function parseAsaasDateOnly(value) {

  const raw = asTrimmedString(value);

  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);

  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  const d = new Date(raw);

  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @param {string} providerPaymentId

 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi

 */

export async function refreshBillingPaymentFromProvider(supabase, userId, providerPaymentId, providerApi) {

  const payId = String(providerPaymentId || "").trim();

  if (!payId) {

    const err = new Error("PROVIDER_PAYMENT_ID_REQUIRED");

    /** @type {any} */ (err).code = "PROVIDER_PAYMENT_ID_REQUIRED";

    throw err;

  }



  const { data: localPay, error: payError } = await supabase

    .from("billing_payments")

    .select("id, user_id, subscription_id, provider, provider_payment_id, status")

    .eq("provider", "asaas")

    .eq("provider_payment_id", payId)

    .limit(1);

  if (payError) throw payError;

  const localPayRow = Array.isArray(localPay) ? localPay[0] : null;

  if (!localPayRow || String(localPayRow.user_id) !== userId) {

    const err = new Error("PAYMENT_NOT_FOUND");

    /** @type {any} */ (err).code = "PAYMENT_NOT_FOUND";

    throw err;

  }



  const remote = await providerApi.getPayment(payId);

  const remoteStatus = asTrimmedString(remote && typeof remote === "object" ? /** @type {{ status?: unknown }} */ (remote).status : null);

  const nextDueDate =

    parseAsaasDateOnly(remote && typeof remote === "object" ? /** @type {{ dueDate?: unknown }} */ (remote).dueDate : null) ||

    parseAsaasDateOnly(remote && typeof remote === "object" ? /** @type {{ originalDueDate?: unknown }} */ (remote).originalDueDate : null);



  const confirmed = isAsaasPaymentConfirmedStatus(remoteStatus);

  const localPaymentStatus = confirmed ? "CONFIRMED" : String(remoteStatus || "PENDING").toUpperCase();



  await supabase

    .from("billing_payments")

    .update({

      status: localPaymentStatus,

      raw_payload: remote && typeof remote === "object" ? remote : {},

      paid_at: confirmed ? new Date().toISOString() : null,

      updated_at: new Date().toISOString(),

    })

    .eq("id", localPayRow.id);



  let activation = { activated: false, idempotent: false, subscription_id: null };



  if (confirmed) {

    try {

      activation = await activateSubscriptionFromPaidPayment(supabase, {

        paymentId: String(localPayRow.id),

        userId,

        subscriptionId: localPayRow.subscription_id != null ? String(localPayRow.subscription_id) : null,

        providerPaymentId: payId,

        nextDueDate,

        paidAt: new Date().toISOString(),

        source: "payment_refresh",

      });

      if (activation.subscription_id) {

        emitBillingCommunicationPlaceholder("billing.payment_confirmed", {

          user_id: userId,

          provider_payment_id: payId,

        });

        emitBillingCommunicationPlaceholder("billing.subscription_activated", {

          user_id: userId,

          subscription_id: activation.subscription_id,

        });

      }

    } catch (error) {

      logBillingError("billing", "payment_refresh_activation_failed", error, {

        user_id: userId,

        provider_payment_id: payId,

      });

      throw error;

    }

  }



  logBilling("billing", "payment_refresh", {

    user_id: userId,

    provider_payment_id: payId,

    remote_status: remoteStatus,

    confirmed,

    subscription_activated: Boolean(activation.activated),

    subscription_id: activation.subscription_id ?? null,

  });



  return {

    payment_status: localPaymentStatus.toLowerCase(),

    remote_status: remoteStatus,

    confirmed,

    subscription_activated: Boolean(activation.activated),

    subscription_id: activation.subscription_id ?? null,

    idempotent: Boolean(activation.idempotent),

  };

}


