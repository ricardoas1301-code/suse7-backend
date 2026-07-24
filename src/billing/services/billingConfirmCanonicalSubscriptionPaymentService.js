// ======================================================================
// Único ponto de confirmação de pagamento canônico (S1.HF.6.9A.12 / 12A)
// Pix / boleto / cartão / webhook / sync / checkout convergem aqui.
// Cobrança criada ≠ pago. Não define FULL_ACCESS diretamente.
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_ENTITLEMENT_SOURCE,
  SUBSCRIPTION_STATUS,
} from "../billingConstants.js";
import { loadCanonicalBillableSubscriptionContext } from "./billingCanonicalSubscriptionService.js";
import { activateSubscriptionFromPaidPayment } from "./billingSubscriptionActivationService.js";
import {
  applyPaidLifecycleTransitionAtomic,
  BILLING_PAID_TRANSITION_KIND,
  resolveEarlyPaymentScheduling,
} from "./billingPaidLifecycleAtomicService.js";
import { resolvePaidCivilCycleClock } from "./billingPaidCivilCycleService.js";
import { transitionDeactivateSuspensionFallback } from "./billingEntitlementStateTransitionService.js";
import { clearPaymentDelinquencyOwnerFromMetadata } from "./billingPaidLifecycleService.js";
import { patchSubscriptionEntitlementMetadata } from "./billingSellerEntitlementStoreService.js";
import { classifyFinancialPaymentEvent } from "./billingFinancialEventClassificationService.js";
import { reevaluateBabyQuotaAfterEntitlementChange } from "./billingBabyQuotaReevaluationService.js";
import { convergePaidLifecycleAfterMutation } from "./billingPaidLifecycleConvergenceService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   canonicalSubscriptionId?: string | null;
 *   linkedSubscriptionId?: string | null;
 *   provider?: string;
 *   providerPaymentId?: string | null;
 *   providerEventId?: string | null;
 *   eventType?: string | null;
 *   paymentStatus?: string | null;
 *   paymentAmount?: string | number | null;
 *   paidAt?: string | null;
 *   nextDueDate?: string | null;
 *   rawPayload?: Record<string, unknown> | null;
 *   paymentRow?: Record<string, unknown> | null;
 *   paymentId?: string | null;
 *   correlationId?: string | null;
 *   source?: string | null;
 *   now?: Date;
 * }} input
 */
export async function confirmCanonicalSubscriptionPayment(supabase, input) {
  const userId = String(input.userId ?? "").trim();
  if (!userId) return { ok: false, error: "MISSING_USER" };

  const paymentRow =
    input.paymentRow && typeof input.paymentRow === "object"
      ? input.paymentRow
      : {
          id: input.paymentId ?? input.providerPaymentId,
          status: input.paymentStatus,
          amount: input.paymentAmount,
          raw_payload: input.rawPayload ?? {
            status: input.paymentStatus,
            id: input.providerPaymentId,
          },
        };

  const remoteStatus =
    asTrimmedString(
      paymentRow.raw_payload && typeof paymentRow.raw_payload === "object"
        ? /** @type {Record<string, unknown>} */ (paymentRow.raw_payload).status
        : null,
    ) ??
    asTrimmedString(paymentRow.status) ??
    asTrimmedString(input.paymentStatus);

  const classification = classifyFinancialPaymentEvent(input.eventType, remoteStatus);
  if (!classification.may_enter_confirm_facade) {
    return {
      ok: true,
      confirmed: false,
      reason: "PAYMENT_NOT_CONFIRMED",
      classification,
      note: "Evento pendente não quita competência / não reativa / não remove owner",
    };
  }

  const ctx = await loadCanonicalBillableSubscriptionContext(supabase, userId);
  let canonical = ctx.canonicalSubscription;
  let canonicalId = ctx.canonicalSubscriptionId;

  const linkedId =
    asTrimmedString(input.linkedSubscriptionId) ??
    asTrimmedString(input.canonicalSubscriptionId) ??
    asTrimmedString(paymentRow.subscription_id);

  // Pagamento apontando para assinatura distinta da canônica
  if (linkedId && canonicalId && String(linkedId) !== String(canonicalId)) {
    const { data: linkedRow } = await supabase
      .from("billing_subscriptions")
      .select("id, user_id, status, provider, metadata, created_at")
      .eq("id", linkedId)
      .maybeSingle();
    const linkedStatus = String(linkedRow?.status ?? "").toLowerCase();
    const firstPaidCheckout = linkedStatus === SUBSCRIPTION_STATUS.PENDING && String(linkedRow?.user_id) === userId;
    if (!firstPaidCheckout) {
      logBilling("billing", "PAID_PAYMENT_REJECTED_NON_CANONICAL", {
        user_id: userId,
        linked_subscription_id: linkedId,
        canonical_subscription_id: canonicalId,
        provider_payment_id: input.providerPaymentId ?? paymentRow.id ?? null,
        reconcile_only: true,
      });
      return {
        ok: false,
        error: "SUBSCRIPTION_NOT_CANONICAL",
        reconcile_only: true,
        linked_subscription_id: linkedId,
        canonical_subscription_id: canonicalId,
      };
    }
    // Primeira ativação paga: a pending vira canônica após activate.
    canonical = /** @type {Record<string, unknown>} */ (linkedRow);
    canonicalId = linkedId;
  }

  if (!canonical || !canonicalId) {
    if (linkedId) {
      const { data: linkedRow } = await supabase
        .from("billing_subscriptions")
        .select("*")
        .eq("id", linkedId)
        .eq("user_id", userId)
        .maybeSingle();
      if (linkedRow?.id) {
        canonical = linkedRow;
        canonicalId = String(linkedRow.id);
      }
    }
  }

  if (!canonical || !canonicalId) {
    return { ok: false, error: "NO_CANONICAL_SUBSCRIPTION" };
  }

  if (String(canonical.user_id ?? "") !== userId) {
    return { ok: false, error: "PAYMENT_SELLER_MISMATCH" };
  }

  const clock = resolvePaidCivilCycleClock(canonical, input.now instanceof Date ? input.now : new Date());
  const competenceKey = clock.next_competence_key ?? clock.competence_key;
  if (!competenceKey) return { ok: false, error: "COMPETENCE_UNRESOLVED" };

  const paymentId =
    asTrimmedString(paymentRow.id) ??
    asTrimmedString(input.paymentId) ??
    asTrimmedString(input.providerPaymentId);

  const atomic = await applyPaidLifecycleTransitionAtomic(supabase, {
    provider: input.provider ?? "asaas",
    providerEventId: input.providerEventId ?? null,
    providerPaymentId: asTrimmedString(input.providerPaymentId) ?? paymentId,
    canonicalSubscriptionId: canonicalId,
    competenceKey,
    eventType: BILLING_PAID_TRANSITION_KIND.PAYMENT_CONFIRMED,
    paidConfirmed: true,
    correlationId: input.correlationId ?? null,
  });

  if (atomic.ok && atomic.idempotent) {
    return {
      ok: true,
      confirmed: true,
      idempotent: true,
      canonical_subscription_id: canonicalId,
      competence_key: competenceKey,
      classification,
    };
  }

  if (
    process.env.BILLING_PAID_LIFECYCLE_ATOMIC_REQUIRED === "true" &&
    (!atomic.ok || atomic.fail_closed || atomic.rpc_missing)
  ) {
    logBilling("billing", "PAID_ATOMIC_REQUIRED_BLOCKED", {
      user_id: userId,
      subscription_id: canonicalId,
      competence_key: competenceKey,
      reason: atomic.error ?? "atomic_required",
    });
    return {
      ok: false,
      confirmed: false,
      error: "BILLING_PAID_LIFECYCLE_ATOMIC_REQUIRED",
      atomic,
      fail_closed: true,
    };
  }

  const paidAt = input.paidAt ?? new Date().toISOString();
  const early = resolveEarlyPaymentScheduling({
    subscription: canonical,
    paidAtIso: paidAt,
    nextPeriodStartCivil: clock.next_period_start_civil ?? "",
    nextPeriodEndExclusiveCivil: clock.next_period_end_exclusive ?? "",
    paymentId: String(paymentId ?? ""),
  });

  const wasSuspended =
    String(canonical.status).toLowerCase() === SUBSCRIPTION_STATUS.PAST_DUE ||
    String(
      canonical.metadata && typeof canonical.metadata === "object"
        ? /** @type {Record<string, unknown>} */ (canonical.metadata).delinquency_status
        : "",
    ).toLowerCase() === "suspended" ||
    Boolean(
      canonical.metadata &&
        typeof canonical.metadata === "object" &&
        /** @type {Record<string, unknown>} */ (canonical.metadata).suspension_fallback_active,
    );

  let metadataWorking =
    canonical.metadata && typeof canonical.metadata === "object"
      ? { .../** @type {Record<string, unknown>} */ (canonical.metadata) }
      : {};

  if (wasSuspended) {
    await transitionDeactivateSuspensionFallback(supabase, canonical, {
      source: "confirm_canonical_payment_reactivate",
      idempotency_key: `reactivate:${canonicalId}:${paymentId ?? ""}`,
    });
    const cleared = clearPaymentDelinquencyOwnerFromMetadata(metadataWorking);
    metadataWorking = cleared.metadata;
    metadataWorking.effective_entitlement = BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN;
    metadataWorking.entitlement_source = BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE;
    metadataWorking.effective_entitlement_source = BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE;
    metadataWorking.suspension_fallback_active = false;
  }

  // Motor Baby Quota reavalia — Financial Engine não apaga por conveniência.
  const babyReeval = reevaluateBabyQuotaAfterEntitlementChange(metadataWorking, {
    effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN,
    entitlement_source: BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE,
    now: input.now instanceof Date ? input.now : new Date(),
  });
  metadataWorking = babyReeval.metadata;

  if (wasSuspended || babyReeval.changed) {
    await patchSubscriptionEntitlementMetadata(
      supabase,
      canonicalId,
      metadataWorking,
      {
        delinquency_status: "none",
        paid_subscription_status: "ACTIVE",
      },
      {
        source: "confirm_canonical_reactivate_reeval",
        idempotency_key: input.correlationId ?? null,
      },
    );
  }

  // Ativação + renovação internas — somente via fachada.
  const activation = await activateSubscriptionFromPaidPayment(supabase, {
    viaCanonicalFacade: true,
    paymentId: asTrimmedString(input.paymentId) ?? (paymentRow.id != null ? String(paymentRow.id) : null),
    providerPaymentId: asTrimmedString(input.providerPaymentId),
    userId,
    subscriptionId: canonicalId,
    nextDueDate: input.nextDueDate ?? null,
    paidAt,
    source: input.source ?? "confirm_canonical_subscription_payment",
  });

  const converged = convergePaidLifecycleAfterMutation({
    subscription: {
      ...canonical,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      metadata: metadataWorking,
    },
    now: input.now instanceof Date ? input.now : new Date(),
  });

  logBilling("billing", "PAID_PAYMENT_CONFIRMED_CANONICAL", {
    user_id: userId,
    subscription_id: canonicalId,
    competence_key: competenceKey,
    early_payment: Boolean(early.early),
    advance_current_period: false,
    provider_payment_id: input.providerPaymentId ?? paymentId,
    atomic_claimed: Boolean(atomic.claimed),
    baby_quota_reevaluation: babyReeval.result,
    lifecycle_converged: converged.lifecycle_state,
    transient_converged_from: converged.transient_converged_from,
  });

  return {
    ok: true,
    confirmed: true,
    idempotent: Boolean(atomic.idempotent),
    canonical_subscription_id: canonicalId,
    competence_key: competenceKey,
    early_payment: Boolean(early.early),
    period_advanced: false,
    access_profile_forced: false,
    baby_quota_reevaluation: babyReeval.result,
    baby_quota_changed: babyReeval.changed,
    lifecycle_state: converged.lifecycle_state,
    transient_converged_from: converged.transient_converged_from,
    activation,
    classification,
    atomic_rpc_missing: Boolean(atomic.rpc_missing),
  };
}
