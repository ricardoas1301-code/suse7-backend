// ======================================================================
// Conclusão de renovação — pagamento confirmado → ciclo → assinatura
// ======================================================================

import Decimal from "decimal.js";
import { logBilling, logBillingError } from "../billingLog.js";
import { RENEWAL_STATUS, SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { decimalToScale2String, toDecimal } from "../utils/moneyDecimal.js";
import {
  addUtcMonthsKeepingAnchorDay,
  deriveInclusivePeriodEndBeforeNextBilling,
  formatBillingCivilDateInSaoPaulo,
  formatUtcDateOnly,
  isoBillingPeriodStartFromCivil,
  isEarlyRenewalPaymentWithinCurrentPeriod,
  resolveBillingCycleAnchor,
  startOfUtcDay,
} from "./billingCycleService.js";
import { getActivePlanById } from "./billingPlanRepository.js";
import { findOpenRenewalCycleForSubscription, updateRenewalCycle } from "./billingRenewalCycleRepository.js";
import { transitionDeactivateSuspensionFallback } from "./billingEntitlementStateTransitionService.js";
import { isAsaasPaymentConfirmedStatus } from "./billingSubscriptionActivationService.js";
import { normalizeCheckoutPaymentMethod } from "./billingSubscriptionService.js";
import {
  applyRecurringCardPreferenceAfterConfirmedPayment,
  recordRenewalRecurringConsent,
} from "./billingRenewalRecurringConsentService.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} rawPayload
 */
function readPaymentPayload(rawPayload) {
  return rawPayload && typeof rawPayload === "object" ? /** @type {Record<string, unknown>} */ (rawPayload) : {};
}

/**
 * Método oficial do provider (sem fallback para Pix).
 *
 * @param {unknown} rawPayload
 */
export function resolveOfficialPaymentMethod(rawPayload) {
  const payload = readPaymentPayload(rawPayload);
  const billingType = asTrimmedString(payload.billingType) ?? asTrimmedString(payload.billing_type);
  const paymentMethod = asTrimmedString(payload.payment_method) ?? asTrimmedString(payload.paymentMethod);
  const raw = billingType ?? paymentMethod;
  if (!raw) return null;
  return normalizeCheckoutPaymentMethod(raw);
}

/**
 * @param {unknown} expected
 * @param {unknown} received
 */
export function paymentAmountsMatch(expected, received) {
  try {
    return decimalToScale2String(toDecimal(expected)) === decimalToScale2String(toDecimal(received));
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, unknown>} subscription
 */
function readLastRenewalPaymentId(subscription) {
  const meta =
    subscription.metadata && typeof subscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (subscription.metadata)
      : {};
  return asTrimmedString(meta.last_renewal_payment_id);
}

/**
 * @param {Record<string, unknown>} subscription
 * @param {Record<string, unknown>} cycle
 */
function buildSubscriptionPeriodPatchFromRenewalCycle(subscription, cycle) {
  const anchor = resolveBillingCycleAnchor(subscription);
  const anchorDay = anchor.getUTCDate();
  const periodStart = startOfUtcDay(cycle.cycle_start);
  if (!periodStart) return null;

  const dueRaw = asTrimmedString(cycle.renewal_due_date) ?? asTrimmedString(cycle.cycle_end);
  const nextBillingAt = dueRaw
    ? startOfUtcDay(dueRaw)
    : addUtcMonthsKeepingAnchorDay(periodStart, 1, anchorDay);
  if (!nextBillingAt) return null;

  const periodEnd = deriveInclusivePeriodEndBeforeNextBilling(nextBillingAt);
  return {
    current_period_start: periodStart.toISOString(),
    current_period_end: periodEnd.toISOString(),
    next_due_date: formatUtcDateOnly(nextBillingAt),
    billing_cycle_anchor: anchor.toISOString(),
  };
}

/**
 * Avanço de um período mensal a partir do fim do período persistido.
 *
 * @param {Record<string, unknown>} subscription
 */
export function buildNextSubscriptionPeriodPatch(subscription) {
  const anchor = resolveBillingCycleAnchor(subscription);
  const anchorDay = anchor.getUTCDate();
  const currentEnd = startOfUtcDay(subscription.current_period_end);
  if (!currentEnd) return null;

  const nextPeriodStart = new Date(currentEnd.getTime() + MS_PER_DAY);
  const normalizedStart = startOfUtcDay(nextPeriodStart);
  if (!normalizedStart) return null;

  const nextBillingAt = addUtcMonthsKeepingAnchorDay(normalizedStart, 1, anchorDay);
  const periodEnd = deriveInclusivePeriodEndBeforeNextBilling(nextBillingAt);

  return {
    current_period_start: normalizedStart.toISOString(),
    current_period_end: periodEnd.toISOString(),
    next_due_date: formatUtcDateOnly(nextBillingAt),
    billing_cycle_anchor: anchor.toISOString(),
  };
}

/**
 * Reativação após suspensão — novo ciclo ancorado na confirmação do pagamento (paid_at civil).
 *
 * @param {Record<string, unknown>} subscription
 * @param {unknown} paidAtIso
 */
export function buildReactivationPeriodPatchFromPaidAt(subscription, paidAtIso) {
  const paidCivil = formatBillingCivilDateInSaoPaulo(paidAtIso);
  if (!paidCivil) return null;

  const periodStartIso = isoBillingPeriodStartFromCivil(paidCivil);
  const periodStart = startOfUtcDay(periodStartIso);
  if (!periodStart) return null;

  const anchorDay = Number(paidCivil.split("-")[2]);
  const safeAnchorDay = Number.isFinite(anchorDay) && anchorDay >= 1 && anchorDay <= 31 ? anchorDay : periodStart.getUTCDate();
  const nextBillingAt = addUtcMonthsKeepingAnchorDay(periodStart, 1, safeAnchorDay);
  const periodEnd = deriveInclusivePeriodEndBeforeNextBilling(nextBillingAt);

  return {
    current_period_start: periodStartIso,
    current_period_end: periodEnd.toISOString(),
    next_due_date: formatUtcDateOnly(nextBillingAt),
    billing_cycle_anchor: periodStartIso,
  };
}

/**
 * @param {Record<string, unknown>} cycle
 */
function isSuspendedRenewalCycle(cycle) {
  return String(cycle?.renewal_status ?? "") === RENEWAL_STATUS.SUSPENDED;
}

/**
 * @param {Record<string, unknown>} cycle
 */
function isGraceRenewalCycle(cycle) {
  return String(cycle?.renewal_status ?? "") === RENEWAL_STATUS.GRACE_PERIOD;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} paymentRow
 * @param {string} subscriptionId
 */
export async function resolveRenewalCycleForPayment(supabase, paymentRow, subscriptionId) {
  const payload = readPaymentPayload(paymentRow.raw_payload);
  const paymentId = String(paymentRow.id);

  const explicitCycleId = asTrimmedString(payload.renewal_cycle_id);
  if (explicitCycleId) {
    const { data, error } = await supabase
      .from("billing_renewal_cycles")
      .select("*")
      .eq("id", explicitCycleId)
      .eq("subscription_id", subscriptionId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  const externalReference = asTrimmedString(payload.externalReference) ?? asTrimmedString(payload.external_reference);
  if (externalReference?.startsWith("renewal:")) {
    const cycleId = externalReference.split(":")[1];
    if (cycleId) {
      const { data, error } = await supabase
        .from("billing_renewal_cycles")
        .select("*")
        .eq("id", cycleId)
        .eq("subscription_id", subscriptionId)
        .maybeSingle();
      if (error) throw error;
      if (data) return data;
    }
  }

  const { data: byGenerated, error: genErr } = await supabase
    .from("billing_renewal_cycles")
    .select("*")
    .eq("generated_payment_id", paymentId)
    .maybeSingle();
  if (genErr) throw genErr;
  if (byGenerated) return byGenerated;

  const providerPaymentId = asTrimmedString(paymentRow.provider_payment_id);
  if (providerPaymentId) {
    const { data: byProvider, error: provErr } = await supabase
      .from("billing_renewal_cycles")
      .select("*")
      .eq("provider_payment_id", providerPaymentId)
      .maybeSingle();
    if (provErr) throw provErr;
    if (byProvider) return byProvider;
  }

  return null;
}

/**
 * @param {Record<string, unknown>} paymentRow
 * @param {Record<string, unknown>} subscription
 */
function isProviderSubscriptionRecurringPayment(paymentRow, subscription) {
  const payload = readPaymentPayload(paymentRow.raw_payload);
  const providerSubId = asTrimmedString(subscription.provider_subscription_id);
  if (!providerSubId) return false;

  const nestedSub = payload.subscription;
  const paymentProviderSubId =
    typeof nestedSub === "string"
      ? nestedSub.trim()
      : nestedSub && typeof nestedSub === "object"
        ? asTrimmedString(/** @type {Record<string, unknown>} */ (nestedSub).id)
        : null;

  if (!paymentProviderSubId || paymentProviderSubId !== providerSubId) return false;

  const externalReference = asTrimmedString(payload.externalReference) ?? asTrimmedString(payload.external_reference);
  if (externalReference?.startsWith("renewal:")) return false;
  if (asTrimmedString(payload.renewal_cycle_id)) return false;
  if (String(paymentRow.event_type_snapshot || "") === "RENEWAL_CHARGE") return true;

  return true;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} paymentRow
 * @param {Record<string, unknown>} subscription
 * @param {import("./billingPlanRepository.js").Suse7PlanRow} plan
 */
async function tryLinkOpenRenewalCycleToPayment(supabase, paymentRow, subscription, plan) {
  const openCycle = await findOpenRenewalCycleForSubscription(supabase, String(subscription.id), {
    userId: String(subscription.user_id),
    reason: "payment_confirmed_link",
  });
  if (!openCycle?.id) return null;
  if (openCycle.generated_payment_id && String(openCycle.generated_payment_id) !== String(paymentRow.id)) {
    return null;
  }
  const expectedAmount = subscription.amount ?? plan.price_monthly;
  if (!paymentAmountsMatch(expectedAmount, paymentRow.amount)) return null;

  const updated = await updateRenewalCycle(supabase, String(openCycle.id), {
    generated_payment_id: String(paymentRow.id),
    provider_payment_id: asTrimmedString(paymentRow.provider_payment_id),
  });

  logBilling("billing", "BILLING_PAYMENT_LINKED_TO_RENEWAL_CYCLE", {
    user_id: subscription.user_id,
    subscription_id: subscription.id,
    payment_id: paymentRow.id,
    renewal_cycle_id: openCycle.id,
  });

  return updated;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   paymentRow: Record<string, unknown>;
 *   subscription: Record<string, unknown>;
 *   cycleId?: string | null;
 *   source?: string;
 * }} ctx
 */
async function maybeFinalizeRenewalRecurringCardConsent(supabase, ctx) {
  const payload = readPaymentPayload(ctx.paymentRow.raw_payload);
  if (payload.recurring_consent !== true) return;
  if (resolveOfficialPaymentMethod(ctx.paymentRow.raw_payload) !== "CREDIT_CARD") return;

  const renewalCycleId =
    asTrimmedString(payload.renewal_cycle_id) ??
    asTrimmedString(ctx.cycleId) ??
    null;
  const paymentMethodId = asTrimmedString(payload.payment_method_id);
  const correlationId = asTrimmedString(payload.recurring_consent_correlation_id);
  const userId = String(ctx.subscription.user_id);
  const subscriptionId = String(ctx.subscription.id);

  if (renewalCycleId) {
    await recordRenewalRecurringConsent(supabase, {
      userId,
      subscriptionId,
      renewalCycleId,
      paymentMethodId,
      correlationId,
      consentedAt: asTrimmedString(ctx.paymentRow.paid_at) ?? new Date().toISOString(),
    });
  }

  await applyRecurringCardPreferenceAfterConfirmedPayment(supabase, subscriptionId, {
    paymentMethod: "CREDIT_CARD",
    paymentMethodId,
    correlationId,
    consentedAt: asTrimmedString(ctx.paymentRow.paid_at) ?? new Date().toISOString(),
  });

  logBilling("billing", "BILLING_RENEWAL_RECURRING_CARD_FINALIZED", {
    user_id: userId,
    subscription_id: subscriptionId,
    payment_id: ctx.paymentRow.id ?? null,
    renewal_cycle_id: renewalCycleId,
    payment_method_id: paymentMethodId,
    source: ctx.source ?? "unknown",
    correlation_id: correlationId,
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   paymentRow: Record<string, unknown>;
 *   subscription: Record<string, unknown>;
 *   paidAt?: string | null;
 *   source?: string;
 *   correlationId?: string | null;
 *   allowRecurringFallback?: boolean;
 * }} ctx
 */
export async function completeSubscriptionRenewalFromPaidPayment(supabase, ctx) {
  const { paymentRow, subscription } = ctx;
  const subscriptionId = String(subscription.id);
  const paymentId = String(paymentRow.id);
  const source = ctx.source ?? "unknown";

  const remoteStatus =
    readPaymentPayload(paymentRow.raw_payload).status != null
      ? String(readPaymentPayload(paymentRow.raw_payload).status)
      : String(paymentRow.status || "");
  const confirmed =
    isAsaasPaymentConfirmedStatus(remoteStatus) ||
    ["CONFIRMED", "PAID", "RECEIVED", "RECEIVED_IN_CASH"].includes(String(paymentRow.status || "").toUpperCase());

  if (!confirmed) {
    return { renewed: false, reason: "payment_not_confirmed" };
  }

  logBilling("billing", "BILLING_PAYMENT_RESOLVED", {
    user_id: subscription.user_id,
    subscription_id: subscriptionId,
    payment_id: paymentId,
    source,
    correlation_id: ctx.correlationId ?? null,
  });

  const officialMethod = resolveOfficialPaymentMethod(paymentRow.raw_payload);
  logBilling("billing", "BILLING_PAYMENT_METHOD_RESOLVED", {
    user_id: subscription.user_id,
    subscription_id: subscriptionId,
    payment_id: paymentId,
    payment_method: officialMethod,
    source,
  });

  if (readLastRenewalPaymentId(subscription) === paymentId) {
    logBilling("billing", "SUBSCRIPTION_RENEWAL_IDEMPOTENCY_HIT", {
      user_id: subscription.user_id,
      subscription_id: subscriptionId,
      payment_id: paymentId,
      source,
    });
    return { renewed: false, idempotent: true, reason: "already_renewed_for_payment" };
  }

  const plan = await getActivePlanById(supabase, String(subscription.plan_id));
  if (!plan?.id) {
    return { renewed: false, reason: "plan_not_found" };
  }

  const expectedAmount = subscription.amount ?? plan.price_monthly;
  if (!paymentAmountsMatch(expectedAmount, paymentRow.amount)) {
    logBilling("billing", "RENEWAL_PAYMENT_MISMATCH", {
      user_id: subscription.user_id,
      subscription_id: subscriptionId,
      payment_id: paymentId,
      expected_amount: decimalToScale2String(toDecimal(expectedAmount)),
      plan_amount: decimalToScale2String(toDecimal(plan.price_monthly)),
      subscription_amount:
        subscription.amount != null ? decimalToScale2String(toDecimal(subscription.amount)) : null,
      received_amount: paymentRow.amount != null ? decimalToScale2String(toDecimal(paymentRow.amount)) : null,
      source,
    });
    return { renewed: false, reason: "amount_mismatch" };
  }

  let cycle = await resolveRenewalCycleForPayment(supabase, paymentRow, subscriptionId);
  if (!cycle?.id) {
    cycle = await tryLinkOpenRenewalCycleToPayment(supabase, paymentRow, subscription, plan);
  }

  /** @type {ReturnType<typeof buildNextSubscriptionPeriodPatch> | ReturnType<typeof buildSubscriptionPeriodPatchFromRenewalCycle> | null} */
  let periodPatch = null;
  let renewalMode = null;

  if (cycle?.id) {
    logBilling("billing", "RENEWAL_CYCLE_RESOLVED", {
      user_id: subscription.user_id,
      subscription_id: subscriptionId,
      payment_id: paymentId,
      renewal_cycle_id: cycle.id,
      renewal_status: cycle.renewal_status,
      source,
    });

    const paidAtIso = ctx.paidAt ?? asTrimmedString(paymentRow.paid_at) ?? new Date().toISOString();

    if (isSuspendedRenewalCycle(cycle)) {
      if (String(cycle.renewal_status) !== RENEWAL_STATUS.EXPIRED) {
        await updateRenewalCycle(supabase, String(cycle.id), {
          renewal_status: RENEWAL_STATUS.EXPIRED,
          provider_payment_id: asTrimmedString(paymentRow.provider_payment_id),
          generated_payment_id: paymentId,
        });
      }
      periodPatch = buildReactivationPeriodPatchFromPaidAt(subscription, paidAtIso);
      renewalMode = "reactivation_after_suspension";
    } else {
      periodPatch = buildSubscriptionPeriodPatchFromRenewalCycle(subscription, cycle);
      renewalMode = isGraceRenewalCycle(cycle) ? "grace_renewal" : "renewal_cycle";
    }
  } else if (ctx.allowRecurringFallback !== false && isProviderSubscriptionRecurringPayment(paymentRow, subscription)) {
    periodPatch = buildNextSubscriptionPeriodPatch(subscription);
    renewalMode = "asaas_recurring_payment";
    logBilling("billing", "RENEWAL_CYCLE_NOT_FOUND", {
      user_id: subscription.user_id,
      subscription_id: subscriptionId,
      payment_id: paymentId,
      fallback: renewalMode,
      source,
    });
  } else {
    logBilling("billing", "RENEWAL_CYCLE_NOT_FOUND", {
      user_id: subscription.user_id,
      subscription_id: subscriptionId,
      payment_id: paymentId,
      source,
    });
    return { renewed: false, reason: "renewal_cycle_not_found" };
  }

  if (!periodPatch) {
    return { renewed: false, reason: "period_patch_unresolved" };
  }

  logBilling("billing", "SUBSCRIPTION_RENEWAL_STARTED", {
    user_id: subscription.user_id,
    subscription_id: subscriptionId,
    payment_id: paymentId,
    renewal_cycle_id: cycle?.id ?? null,
    renewal_mode: renewalMode,
    source,
  });

  const meta =
    subscription.metadata && typeof subscription.metadata === "object"
      ? { .../** @type {Record<string, unknown>} */ (subscription.metadata) }
      : {};

  if (cycle?.id && String(cycle.renewal_status) !== RENEWAL_STATUS.PAID && renewalMode !== "reactivation_after_suspension") {
    await updateRenewalCycle(supabase, String(cycle.id), {
      renewal_status: RENEWAL_STATUS.PAID,
      provider_payment_id: asTrimmedString(paymentRow.provider_payment_id),
      generated_payment_id: paymentId,
    });
  }

  const paidAtIso = ctx.paidAt ?? asTrimmedString(paymentRow.paid_at) ?? new Date().toISOString();
  const scheduleInsteadOfImmediateActivation =
    renewalMode !== "reactivation_after_suspension" &&
    isEarlyRenewalPaymentWithinCurrentPeriod(subscription, paidAtIso);

  const scheduledPeriodStartDay = formatUtcDateOnly(startOfUtcDay(periodPatch.current_period_start));
  const scheduledPeriodEndDay = formatUtcDateOnly(startOfUtcDay(periodPatch.current_period_end));

  const scheduledRenewal = scheduleInsteadOfImmediateActivation
    ? {
        payment_id: paymentId,
        paid_at: paidAtIso,
        renewal_cycle_id: cycle?.id != null ? String(cycle.id) : null,
        renewal_mode: renewalMode,
        period_start: scheduledPeriodStartDay,
        period_end: scheduledPeriodEndDay,
        period_start_iso: periodPatch.current_period_start,
        period_end_iso: periodPatch.current_period_end,
        next_due_date: periodPatch.next_due_date,
        billing_cycle_anchor: periodPatch.billing_cycle_anchor,
        activated_at: null,
      }
    : null;

  const subscriptionUpdate = scheduleInsteadOfImmediateActivation
    ? {
        status: SUBSCRIPTION_STATUS.ACTIVE,
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
        next_due_date: periodPatch.next_due_date,
        metadata: {
          ...meta,
          last_renewal_payment_id: paymentId,
          last_renewal_at: paidAtIso,
          last_renewal_mode: renewalMode,
          scheduled_renewal: scheduledRenewal,
          delinquency_status: "none",
        },
        updated_at: new Date().toISOString(),
      }
    : {
        status: SUBSCRIPTION_STATUS.ACTIVE,
        current_period_start: periodPatch.current_period_start,
        current_period_end: periodPatch.current_period_end,
        next_due_date: periodPatch.next_due_date,
        metadata: {
          ...meta,
          last_renewal_payment_id: paymentId,
          last_renewal_at: paidAtIso,
          last_renewal_mode: renewalMode,
          billing_cycle_anchor: periodPatch.billing_cycle_anchor,
          delinquency_status: "none",
          scheduled_renewal: null,
        },
        updated_at: new Date().toISOString(),
      };

  const { error: subErr } = await supabase
    .from("billing_subscriptions")
    .update(subscriptionUpdate)
    .eq("id", subscriptionId);

  if (subErr) {
    logBillingError("billing", "SUBSCRIPTION_RENEWAL_FAILED", subErr, {
      user_id: subscription.user_id,
      subscription_id: subscriptionId,
      payment_id: paymentId,
      source,
    });
    throw subErr;
  }

  if (renewalMode === "reactivation_after_suspension" || renewalMode === "grace_renewal") {
    try {
      await transitionDeactivateSuspensionFallback(supabase, subscriptionId, {
        payment_id: paymentId,
        source,
      });
    } catch (fallbackErr) {
      logBillingError("billing", "suspension_fallback_deactivation_failed", fallbackErr, {
        subscription_id: subscriptionId,
        payment_id: paymentId,
        source,
      });
    }
  }

  await maybeFinalizeRenewalRecurringCardConsent(supabase, {
    paymentRow,
    subscription,
    cycleId: cycle?.id != null ? String(cycle.id) : null,
    source,
  });

  if (scheduleInsteadOfImmediateActivation) {
    logBilling("billing", "SUBSCRIPTION_RENEWAL_SCHEDULED", {
      user_id: subscription.user_id,
      subscription_id: subscriptionId,
      payment_id: paymentId,
      renewal_cycle_id: cycle?.id ?? null,
      renewal_mode: renewalMode,
      current_period_start: subscription.current_period_start,
      current_period_end: subscription.current_period_end,
      scheduled_period_start: scheduledRenewal?.period_start_iso,
      scheduled_period_end: scheduledRenewal?.period_end_iso,
      next_due_date: periodPatch.next_due_date,
      source,
    });

    return {
      renewed: true,
      scheduled: true,
      activated: false,
      idempotent: false,
      renewal_mode: renewalMode,
      renewal_cycle_id: cycle?.id ?? null,
      period: {
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
        next_due_date: periodPatch.next_due_date,
        scheduled: scheduledRenewal,
      },
    };
  }

  logBilling("billing", "SUBSCRIPTION_RENEWED", {
    user_id: subscription.user_id,
    subscription_id: subscriptionId,
    payment_id: paymentId,
    renewal_cycle_id: cycle?.id ?? null,
    renewal_mode: renewalMode,
    current_period_start: periodPatch.current_period_start,
    current_period_end: periodPatch.current_period_end,
    next_due_date: periodPatch.next_due_date,
    source,
  });

  return {
    renewed: true,
    scheduled: false,
    activated: true,
    idempotent: false,
    renewal_mode: renewalMode,
    renewal_cycle_id: cycle?.id ?? null,
    period: periodPatch,
  };
}
