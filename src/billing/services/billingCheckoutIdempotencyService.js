// ======================================================================
// Idempotência de checkout Asaas — evita cobranças duplicadas
// ======================================================================

import { logBilling } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { normalizeCheckoutPaymentMethod } from "./billingSubscriptionService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {string} userId
 * @param {string} planId
 * @param {string} paymentMethod
 */
export function buildAsaasCheckoutIdempotencyKey(userId, planId, paymentMethod) {
  const pm = normalizeCheckoutPaymentMethod(paymentMethod);
  return `${userId}:${planId}:${pm}`;
}

/**
 * Reutiliza assinatura/cobrança pendente equivalente (mesmo seller, plano e método).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} planId
 * @param {string | null | undefined} planKey
 * @param {string | null | undefined} paymentMethod
 */
export async function findReusablePendingAsaasCheckout(supabase, userId, planId, planKey, paymentMethod) {
  const paymentMethodResolved = normalizeCheckoutPaymentMethod(paymentMethod);
  const planKeyNorm = asTrimmedString(planKey)?.toLowerCase() ?? null;

  const { data: subs, error } = await supabase
    .from("billing_subscriptions")
    .select("*")
    .eq("user_id", userId)
    .eq("provider", "asaas")
    .eq("status", SUBSCRIPTION_STATUS.PENDING)
    .eq("plan_id", planId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw error;

  for (const sub of subs ?? []) {
    const meta = sub.metadata && typeof sub.metadata === "object" ? /** @type {Record<string, unknown>} */ (sub.metadata) : {};
    const subPaymentMethod = normalizeCheckoutPaymentMethod(meta.payment_method);
    if (subPaymentMethod !== paymentMethodResolved) continue;

    const rowPlanKey = asTrimmedString(sub.plan_key)?.toLowerCase() ?? null;
    if (planKeyNorm && rowPlanKey && rowPlanKey !== planKeyNorm) continue;

    const { data: payRows, error: payError } = await supabase
      .from("billing_payments")
      .select("*")
      .eq("subscription_id", sub.id)
      .in("status", ["PENDING", "pending"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (payError) throw payError;

    const payRow = Array.isArray(payRows) ? payRows[0] : null;
    const firstPayment =
      payRow?.raw_payload && typeof payRow.raw_payload === "object" ? payRow.raw_payload : null;

    return {
      subscription: sub,
      payment: payRow,
      asaas: {
        id: asTrimmedString(sub.provider_subscription_id),
        status:
          meta.asaas && typeof meta.asaas === "object"
            ? asTrimmedString(/** @type {Record<string, unknown>} */ (meta.asaas).remote_status) ?? "PENDING"
            : "PENDING",
        firstPayment,
      },
      idempotency_key: buildAsaasCheckoutIdempotencyKey(userId, planId, paymentMethodResolved),
    };
  }

  return null;
}

/**
 * @param {{
 *   user_id: string;
 *   plan_id: string;
 *   plan_key: string;
 *   payment_method: string;
 *   amount: string;
 *   route?: string | null;
 *   request_id?: string | null;
 * }} ctx
 */
export function logAsaasPaymentCreateAudit(ctx) {
  logBilling("billing", "BILLING_ASAAS_PAYMENT_CREATE", {
    user_id: ctx.user_id,
    plan_id: ctx.plan_id,
    plan_key: ctx.plan_key,
    payment_method: ctx.payment_method,
    amount: ctx.amount,
    reason: "explicit_user_action",
    route: ctx.route ?? null,
    request_id: ctx.request_id ?? null,
    idempotency_key: buildAsaasCheckoutIdempotencyKey(ctx.user_id, ctx.plan_id, ctx.payment_method),
  });
}

/**
 * @param {{
 *   user_id: string;
 *   plan_key: string;
 *   payment_method: string;
 *   subscription_id: string;
 *   payment_id?: string | null;
 *   provider_payment_id?: string | null;
 *   idempotency_key: string;
 * }} ctx
 */
export function logAsaasPaymentReuseAudit(ctx) {
  logBilling("billing", "BILLING_ASAAS_PAYMENT_REUSE_EXISTING_PENDING", {
    user_id: ctx.user_id,
    plan_key: ctx.plan_key,
    payment_method: ctx.payment_method,
    subscription_id: ctx.subscription_id,
    payment_id: ctx.payment_id ?? null,
    asaas_payment_id: ctx.provider_payment_id ?? null,
    idempotency_key: ctx.idempotency_key,
  });
}
