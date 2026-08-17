// ======================================================================
// Início de checkout/assinatura — backend only
// ======================================================================

import { getBillingProvider } from "../providers/index.js";
import { normalizeCheckoutPaymentMethod } from "./billingSubscriptionService.js";
import { getActivePlanById, getActivePlanByKey, getActivePlanBySlug } from "./billingPlanRepository.js";
import { checkoutPlan } from "./billingSubscriptionService.js";
import { mapCheckoutStartResponse } from "./billingCheckoutResponse.js";
import { emitBillingCommunicationPlaceholder, fetchPixCheckoutPayload } from "./billingPixCheckoutService.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   planKey?: string | null;
 *   planId?: string | null;
 *   planSlug?: string | null;
 * }} selectors
 */
async function resolveCheckoutPlan(supabase, selectors) {
  const planId = selectors.planId != null && String(selectors.planId).trim() !== "" ? String(selectors.planId).trim() : null;
  const planKey = selectors.planKey != null && String(selectors.planKey).trim() !== "" ? String(selectors.planKey).trim() : null;
  const planSlug = selectors.planSlug != null && String(selectors.planSlug).trim() !== "" ? String(selectors.planSlug).trim() : null;

  if (planId) return getActivePlanById(supabase, planId);
  if (planSlug) {
    const bySlug = await getActivePlanBySlug(supabase, planSlug);
    if (bySlug) return bySlug;
    return getActivePlanByKey(supabase, planSlug);
  }
  if (planKey) return getActivePlanByKey(supabase, planKey);
  return null;
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> };
 *   planKey?: string | null;
 *   planId?: string | null;
 *   planSlug?: string | null;
 *   paymentMethod?: string | null;
 *   providerKey?: string;
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
export async function startBillingCheckout(ctx) {
  const providerKey = ctx.providerKey || "asaas";
  const providerApi = getBillingProvider(providerKey);
  const plan = await resolveCheckoutPlan(ctx.supabase, ctx);

  if (!plan && !ctx.planKey && !ctx.planId && !ctx.planSlug) {
    const err = new Error("PLAN_KEY_OR_ID_REQUIRED");
    /** @type {any} */ (err).code = "PLAN_KEY_OR_ID_REQUIRED";
    throw err;
  }
  if (!plan) {
    const err = new Error("PLAN_NOT_FOUND");
    /** @type {any} */ (err).code = "PLAN_NOT_FOUND";
    throw err;
  }

  const paymentMethod = normalizeCheckoutPaymentMethod(ctx.paymentMethod);

  const result = await checkoutPlan({
    supabase: ctx.supabase,
    user: ctx.user,
    planKey: plan.plan_key,
    planId: plan.id,
    paymentMethod,
    providerApi,
    providerKey,
    supersedeMode: ctx.supersedeMode ?? "checkout",
    explicitUserAction: ctx.explicitUserAction === true,
    auditRoute: ctx.auditRoute ?? null,
    auditRequestId: ctx.auditRequestId ?? null,
    cardCheckout: ctx.cardCheckout ?? null,
  });

  const mapped = mapCheckoutStartResponse(result, plan, paymentMethod);

  if (paymentMethod === "PIX" && mapped.payment?.provider_payment_id) {
    const pix = await fetchPixCheckoutPayload(providerApi, mapped.payment.provider_payment_id);
    if (pix) {
      mapped.pix = pix;
      if (mapped.payment && typeof mapped.payment === "object") {
        mapped.payment.pix_copy_paste = pix.copy_paste_code ?? mapped.payment.pix_copy_paste;
        mapped.payment.invoice_url = null;
      }
    }
    emitBillingCommunicationPlaceholder("billing.pix_created", {
      user_id: ctx.user.id,
      provider_payment_id: mapped.payment?.provider_payment_id,
      plan_key: plan.plan_key,
    });
  }

  return mapped;
}
