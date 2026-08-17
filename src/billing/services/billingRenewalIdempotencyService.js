// ======================================================================
// Idempotência de cobrança automática (renewal) — um ciclo por assinatura
// ======================================================================

import { normalizeCheckoutPaymentMethod } from "./billingSubscriptionService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Chave lógica: user + assinatura + plano + início do ciclo + método + motivo.
 *
 * @param {string} userId
 * @param {string} subscriptionId
 * @param {string} planId
 * @param {string} billingCycleStart — YYYY-MM-DD
 * @param {string} paymentMethod
 * @param {string} [reason]
 */
export function buildRenewalChargeIdempotencyKey(
  userId,
  subscriptionId,
  planId,
  billingCycleStart,
  paymentMethod,
  reason = "renewal"
) {
  const pm = normalizeCheckoutPaymentMethod(paymentMethod);
  return `${userId}:${subscriptionId}:${planId}:${billingCycleStart}:${pm}:${reason}`;
}

const OPEN_PAYMENT_STATUSES = new Set(["pending", "pendente", "awaiting_payment", "overdue", "vencido", "past_due"]);
const SETTLED_PAYMENT_STATUSES = new Set(["paid", "pago", "received", "confirmed", "received_in_cash", "confirmed"]);

/**
 * @param {unknown} status
 */
function normalizePaymentStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase();
}

/**
 * @param {unknown} rawPayload
 */
function readPayloadCycleStart(rawPayload) {
  const payload = rawPayload && typeof rawPayload === "object" ? /** @type {Record<string, unknown>} */ (rawPayload) : {};
  return asTrimmedString(payload.billing_cycle_start) ?? asTrimmedString(payload.billing_cycle_start_at);
}

/**
 * Verifica se já existe cobrança equivalente no ciclo (pendente ou paga).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   subscriptionId: string;
 *   planId: string;
 *   billingCycleStart: string;
 *   paymentMethod: string;
 * }} ctx
 */
export async function findExistingRenewalCyclePayment(supabase, ctx) {
  const paymentMethod = normalizeCheckoutPaymentMethod(ctx.paymentMethod);
  const cycleStart = asTrimmedString(ctx.billingCycleStart);
  if (!cycleStart) return null;

  const { data, error } = await supabase
    .from("billing_payments")
    .select("id, provider_payment_id, status, amount, created_at, raw_payload, event_type_snapshot")
    .eq("user_id", ctx.userId)
    .eq("subscription_id", ctx.subscriptionId)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw error;

  for (const row of data ?? []) {
    const status = normalizePaymentStatus(row.status);
    if (!OPEN_PAYMENT_STATUSES.has(status) && !SETTLED_PAYMENT_STATUSES.has(status)) continue;

    const payload = row.raw_payload;
    const payloadCycle = readPayloadCycleStart(payload);
    const payloadPlanId =
      payload && typeof payload === "object"
        ? asTrimmedString(/** @type {Record<string, unknown>} */ (payload).plan_id)
        : null;
    if (payloadPlanId && payloadPlanId !== ctx.planId) continue;

    const payloadMethod =
      payload && typeof payload === "object"
        ? normalizeCheckoutPaymentMethod(
            /** @type {Record<string, unknown>} */ (payload).payment_method ??
              /** @type {Record<string, unknown>} */ (payload).billingType
          )
        : paymentMethod;
    if (payloadMethod !== paymentMethod) continue;

    if (payloadCycle && payloadCycle !== cycleStart) continue;

    const idempotencyKey = buildRenewalChargeIdempotencyKey(
      ctx.userId,
      ctx.subscriptionId,
      ctx.planId,
      cycleStart,
      paymentMethod
    );

    return {
      payment: row,
      idempotency_key: idempotencyKey,
      status,
    };
  }

  return null;
}
