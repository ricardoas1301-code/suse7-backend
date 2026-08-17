// ======================================================================
// Resposta pública do checkout — sem expor payload bruto do gateway
// ======================================================================

import { decimalToScale2String, toDecimal } from "../utils/moneyDecimal.js";
import {
  mapPublicBoletoFieldsFromAsaasPayment,
  resolvePublicBoletoOfficialUrl,
} from "./billingBoletoPaymentPresentation.js";

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} amount
 */
function amountToCents(amount) {
  if (amount == null || amount === "") return null;
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/**
 * @param {Record<string, unknown> | null | undefined} firstPayment
 * @param {string} [billingTypeHint]
 */
function mapPublicPayment(firstPayment, billingTypeHint = "") {
  const billingType = (
    asTrimmedString(firstPayment?.billingType) ??
    asTrimmedString(firstPayment?.billing_type) ??
    billingTypeHint
  ).toUpperCase();
  const isPix = billingType === "PIX";
  const isBoleto = billingType === "BOLETO";
  const boletoFields = isBoleto ? mapPublicBoletoFieldsFromAsaasPayment(firstPayment) : null;

  if (!firstPayment) {
    return {
      id: null,
      provider: "asaas",
      provider_payment_id: null,
      status: "pending",
      value: null,
      due_date: null,
      description: null,
      plan_name: null,
      billing_type: billingType || null,
      invoice_url: null,
      bank_slip_url: null,
      identification_field: null,
      boleto_url: null,
      pix_copy_paste: null,
      payment_method: billingType || null,
    };
  }

  const valueRaw = firstPayment.value ?? firstPayment.amount;
  const value =
    valueRaw != null && valueRaw !== ""
      ? typeof valueRaw === "number"
        ? valueRaw.toFixed(2)
        : String(valueRaw)
      : null;

  return {
    id: asTrimmedString(firstPayment.id),
    provider: "asaas",
    provider_payment_id: asTrimmedString(firstPayment.id),
    status: "pending",
    value,
    due_date: asTrimmedString(firstPayment.dueDate) ?? asTrimmedString(firstPayment.originalDueDate),
    description: asTrimmedString(firstPayment.description),
    plan_name: null,
    billing_type: billingType || null,
    invoice_url: isPix ? null : boletoFields?.invoice_url ?? asTrimmedString(firstPayment.transactionReceiptUrl),
    bank_slip_url: isBoleto ? boletoFields?.bank_slip_url ?? null : null,
    identification_field: isBoleto ? boletoFields?.identification_field ?? null : null,
    boleto_url: isBoleto
      ? resolvePublicBoletoOfficialUrl(boletoFields?.bank_slip_url, boletoFields?.invoice_url)
      : null,
    pix_copy_paste: asTrimmedString(firstPayment.pixCopiaECola) ?? asTrimmedString(firstPayment.pix_copy_paste),
    payment_method: billingType || null,
  };
}

/**
 * @param {import("./billingPlanRepository.js").Suse7PlanRow} plan
 */
function mapPublicPlan(plan) {
  return {
    id: plan.id,
    plan_key: plan.plan_key,
    slug: plan.slug ?? plan.plan_key,
    name: plan.name,
    price_monthly: decimalToScale2String(toDecimal(plan.price_monthly)),
    amount_cents: amountToCents(plan.price_monthly),
    sales_limit_monthly: plan.sales_limit_monthly ?? null,
    billing_required: plan.billing_required,
  };
}

/**
 * @param {Record<string, unknown>} result
 * @param {import("./billingPlanRepository.js").Suse7PlanRow | null} [plan]
 * @param {string} [paymentMethodHint]
 */
export function mapCheckoutStartResponse(result, plan = null, paymentMethodHint = "") {
  const asaas = asObject(result.asaas);
  const firstPayment = asObject(asaas?.firstPayment) ?? asObject(asaas?.first_payment);
  const subscription = asObject(result.subscription);
  const payment = mapPublicPayment(firstPayment, paymentMethodHint);
  if (plan && payment && typeof payment === "object") {
    payment.plan_name = plan.name;
    if (!payment.description) payment.description = `Suse7 — ${plan.name}`;
    if (!payment.value) payment.value = decimalToScale2String(toDecimal(plan.price_monthly));
  }

  return {
    kind: asTrimmedString(result.kind) ?? "unknown",
    subscription: subscription
      ? {
          id: subscription.id != null ? String(subscription.id) : null,
          status: asTrimmedString(subscription.status) ?? "pending",
          plan_id: subscription.plan_id != null ? String(subscription.plan_id) : null,
          plan_key: asTrimmedString(subscription.plan_key),
          provider: asTrimmedString(subscription.provider),
          provider_subscription_id: asTrimmedString(subscription.provider_subscription_id),
          next_due_date: asTrimmedString(subscription.next_due_date),
        }
      : null,
    payment,
    pix: null,
    plan: plan ? mapPublicPlan(plan) : null,
    access_pending_confirmation:
      asTrimmedString(result.kind) === "paid" &&
      asTrimmedString(subscription?.status) !== "active",
    card:
      paymentMethodHint === "CREDIT_CARD" || paymentMethodHint === "DEBIT_CARD"
        ? {
            approved: asTrimmedString(subscription?.status) === "active",
            payment_status: asTrimmedString(firstPayment?.status) ?? null,
            card_mode: paymentMethodHint === "DEBIT_CARD" ? "debit" : "credit",
          }
        : null,
  };
}
