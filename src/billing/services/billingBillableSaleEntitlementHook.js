// ======================================================================
// Hook pós-venda — transição de entitlement (S1.HF.6.9A.10)
// Baby pós-trial: somente caminho atômico.
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_SALE_PERIOD_CLASS,
  BILLING_SYNC_METADATA_KEYS,
  BILLING_SYNC_STATE,
  BILLING_USAGE_LIMIT_METADATA_KEYS,
} from "../billingConstants.js";
import { formatBillingCivilDateInSaoPaulo } from "./billingCycleService.js";
import { transitionApplyPaidUsageMachine } from "./billingEntitlementStateTransitionService.js";
import { evaluateBillableSaleBeforeProcessingAtomic } from "./billingBillableSaleAdmissionService.js";
import { loadCanonicalBillableSubscriptionContext } from "./billingCanonicalSubscriptionService.js";
import { resolveBillingAccessEntitlementSnapshot } from "./billingSubscriptionEntitlementService.js";
import { countSellerEcosystemSalesUsage } from "./subscriptionUsageMeter.js";
import {
  readUsageLimitStateFromMetadata,
  resolveUsageLimitStateMachine,
} from "./billingUsageLimitStateService.js";
import { readSuspensionFallbackEntitlement } from "./billingSuspensionFallbackEntitlementService.js";
import { loadSellerEntitlementOverlay } from "./billingSellerEntitlementStoreService.js";
import {
  normalizeBillingSnapshotOrigin,
  shouldBypassAtomicQuotaReservation,
} from "./billingQuotaEligibilityService.js";
import { resolveCanonicalAccessPrecedence } from "./billingAccessPrecedenceService.js";

export {
  evaluateBillableSaleBeforeProcessingAtomic as evaluateBillableSaleBeforeProcessing,
  reserveBillableSaleV2,
  finalizeBillableSaleV2,
  releaseBillableSaleV2,
  reconcileExpiredBillableSaleReservations,
  rollbackBillableSaleAdmission,
  recordBillableSaleIgnoredAtHardLimit,
  renewBillableSaleReservationLease,
  runWithBillableSaleReservationHeartbeat,
  reportBillableSaleFinalizeFailure,
} from "./billingBillableSaleAdmissionService.js";

/**
 * @param {string | null | undefined} periodClass
 * @param {string | null | undefined} reason
 */
function resolveObservationLogEvent(periodClass, reason) {
  if (periodClass === BILLING_SALE_PERIOD_CLASS.IMPORTACAO_HISTORICA || reason === "onboarding_import") {
    return "BILLING_HISTORICAL_IMPORT_OBSERVED";
  }
  if (periodClass === BILLING_SALE_PERIOD_CLASS.PRE_OPERATIONAL_CUTOVER) {
    return "BILLING_PRE_CUTOVER_OBSERVED";
  }
  if (periodClass === BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW || reason === "manual_review_required") {
    return "BILLING_MANUAL_REVIEW";
  }
  if (
    periodClass === BILLING_SALE_PERIOD_CLASS.TRIAL_OBSERVADO ||
    reason === "trial_unlimited" ||
    reason === "trial_active_unlimited" ||
    reason === "before_quota_counting_started"
  ) {
    return "BILLING_TRIAL_OBSERVED";
  }
  return "BILLING_CURRENT_CYCLE_BILLABLE";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   is_new_sale: boolean;
 *   external_order_id?: string | null;
 *   atomic_admission?: Record<string, unknown> | null;
 *   period_class?: string | null;
 *   snapshot_origin?: string | null;
 *   official_order_at?: string | null;
 *   now?: Date;
 * }} options
 */
export async function notifyBillableSaleRecorded(supabase, userId, options) {
  if (!options?.is_new_sale) {
    return { applied: false, reason: "deduplicated_reprocess" };
  }

  if (options.atomic_admission?.duplicate) {
    return { applied: false, reason: "duplicate", idempotent: true };
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const civilNow = formatBillingCivilDateInSaoPaulo(now) ?? "";
  const snapshotOrigin = normalizeBillingSnapshotOrigin(
    options.snapshot_origin ?? options.atomic_admission?.snapshot_origin,
  );
  const periodClass =
    options.period_class ?? options.atomic_admission?.period_class ?? null;
  const officialOrderAt =
    options.official_order_at ?? options.atomic_admission?.official_order_at ?? null;

  const overlay = await loadSellerEntitlementOverlay(supabase, userId);
  const precedence = resolveCanonicalAccessPrecedence(overlay.metadata);
  if (!precedence.allow_process_sale) {
    logBilling("billing", "BILLING_MANUAL_REVIEW", {
      user_id: userId,
      reason: precedence.reason,
      precedence_rank: precedence.precedence_rank,
      snapshot_origin: snapshotOrigin,
      official_order_at: officialOrderAt,
      period_class: periodClass,
    });
    return {
      applied: false,
      reason: precedence.reason,
      precedence_rank: precedence.precedence_rank,
      snapshot_origin: snapshotOrigin,
      official_order_at: officialOrderAt,
      period_class: periodClass,
    };
  }

  if (options.atomic_admission?.quota_bypassed) {
    const event = resolveObservationLogEvent(
      /** @type {string|null} */ (periodClass),
      String(options.atomic_admission?.reason ?? ""),
    );
    logBilling("billing", event, {
      user_id: userId,
      reason: options.atomic_admission?.reason ?? null,
      period_class: periodClass,
      snapshot_origin: snapshotOrigin,
      official_order_at: officialOrderAt,
      external_order_id: options.external_order_id ?? null,
    });
    return {
      applied: false,
      reason: String(options.atomic_admission?.reason ?? "quota_bypassed_observed"),
      quota_bypassed: true,
      period_class: periodClass,
      snapshot_origin: snapshotOrigin,
      official_order_at: officialOrderAt,
    };
  }

  const trialBypass = shouldBypassAtomicQuotaReservation(overlay.metadata, now);
  if (trialBypass.bypass && precedence.allow_quota_bypass_trial) {
    logBilling("billing", "BILLING_TRIAL_OBSERVED", {
      user_id: userId,
      trial_state: trialBypass.trial_state ?? null,
      external_order_id: options.external_order_id ?? null,
      snapshot_origin: snapshotOrigin,
      official_order_at: officialOrderAt,
      period_class: BILLING_SALE_PERIOD_CLASS.TRIAL_OBSERVADO,
    });
    return {
      applied: false,
      reason: "trial_observed_not_billable",
      quota_bypassed: true,
      trial_state: trialBypass.trial_state ?? null,
      period_class: BILLING_SALE_PERIOD_CLASS.TRIAL_OBSERVADO,
      snapshot_origin: snapshotOrigin,
      official_order_at: officialOrderAt,
    };
  }

  const { canonicalSubscription } = await loadCanonicalBillableSubscriptionContext(supabase, userId);
  if (!canonicalSubscription?.id) {
    return { applied: false, reason: "subscription_not_found" };
  }

  const subscriptionId = String(canonicalSubscription.id);
  const meta =
    canonicalSubscription.metadata && typeof canonicalSubscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (canonicalSubscription.metadata)
      : {};

  if (options.atomic_admission?.atomic) {
    const finalizeOk = Boolean(
      options.atomic_admission?.finalize?.finalized || options.atomic_admission?.finalize_ok,
    );
    const pendingReconciliation =
      Boolean(
        options.atomic_admission?.reconciliation_required || options.atomic_admission?.finalize_failed,
      ) && !finalizeOk;

    if (pendingReconciliation || options.atomic_admission?.finalize_failed) {
      logBilling("billing", "BILLING_BILLABLE_SALE_BABY_PENDING_RECONCILIATION", {
        user_id: userId,
        subscription_id: subscriptionId,
        admission_id: options.atomic_admission?.admission_id ?? null,
        snapshot_origin: snapshotOrigin,
        official_order_at: officialOrderAt,
        period_class: periodClass,
      });
      return {
        applied: false,
        reason: "pending_reconciliation",
        reconciliation_required: true,
        admission_id: options.atomic_admission?.admission_id ?? null,
        snapshot_origin: snapshotOrigin,
        official_order_at: officialOrderAt,
        period_class: periodClass,
      };
    }

    if (
      finalizeOk ||
      options.atomic_admission?.activate_hard_pause ||
      meta[BILLING_SYNC_METADATA_KEYS.SYNC_STATE] === BILLING_SYNC_STATE.HARD_PAUSED
    ) {
      logBilling("billing", "BILLING_CURRENT_CYCLE_BILLABLE", {
        user_id: userId,
        subscription_id: subscriptionId,
        usage_count: options.atomic_admission?.usage_count ?? null,
        admission_id: options.atomic_admission?.admission_id ?? null,
        snapshot_origin: snapshotOrigin,
        official_order_at: officialOrderAt,
        period_class: periodClass ?? BILLING_SALE_PERIOD_CLASS.FRANQUIA_ELEGIVEL,
        idempotent: true,
      });
      return {
        applied: true,
        idempotent: true,
        baby: {
          hard_paused: Boolean(
            options.atomic_admission?.activate_hard_pause ||
              meta[BILLING_SYNC_METADATA_KEYS.SYNC_STATE] === BILLING_SYNC_STATE.HARD_PAUSED,
          ),
          atomic: true,
          admission_id: options.atomic_admission?.admission_id ?? null,
        },
        period_class: periodClass ?? BILLING_SALE_PERIOD_CLASS.FRANQUIA_ELEGIVEL,
        snapshot_origin: snapshotOrigin,
        official_order_at: officialOrderAt,
      };
    }

    return {
      applied: false,
      reason: "pending_reconciliation",
      reconciliation_required: true,
      admission_id: options.atomic_admission?.admission_id ?? null,
      snapshot_origin: snapshotOrigin,
      official_order_at: officialOrderAt,
      period_class: periodClass,
    };
  }

  const snapshot = await resolveBillingAccessEntitlementSnapshot(supabase, userId, { now });
  const isBaby = snapshot.effective_entitlement === BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE;

  // Baby pós-trial sem atomic_admission → fail-closed (sem legado count→transition).
  if (isBaby) {
    logBilling("billing", "BILLING_MANUAL_REVIEW", {
      user_id: userId,
      subscription_id: subscriptionId,
      reason: "atomic_admission_required",
      snapshot_origin: snapshotOrigin,
      official_order_at: officialOrderAt,
      period_class: periodClass,
      external_order_id: options.external_order_id ?? null,
    });
    return {
      applied: false,
      reason: "atomic_admission_required",
      reconciliation_required: true,
      manual_review_required: true,
      snapshot_origin: snapshotOrigin,
      official_order_at: officialOrderAt,
      period_class: periodClass,
    };
  }

  const fallback = readSuspensionFallbackEntitlement(meta);
  const periodStart = snapshot.fallback_period_start ?? fallback.fallback_period_start;
  const periodEnd = snapshot.fallback_period_end ?? fallback.fallback_period_end;

  let usageCount = Number(snapshot.usage_count ?? 0);
  if (periodStart && periodEnd) {
    usageCount = await countSellerEcosystemSalesUsage(supabase, userId, {
      period_start: periodStart,
      period_end: periodEnd,
    });
  }

  const usageLimit = snapshot.usage_limit != null ? Number(snapshot.usage_limit) : null;
  const idempotencyKey = options.external_order_id
    ? `billable_sale:${options.external_order_id}`
    : `billable_sale:${civilNow}:${usageCount}`;

  const machine = resolveUsageLimitStateMachine({
    usageCount,
    usageLimit,
    civilNow,
    cycleKey: String(meta[BILLING_USAGE_LIMIT_METADATA_KEYS.CYCLE_KEY] ?? periodStart ?? civilNow),
    persisted: readUsageLimitStateFromMetadata(meta),
  });

  const paidResult = await transitionApplyPaidUsageMachine(supabase, subscriptionId, machine, meta, {
    idempotency_key: idempotencyKey,
    source: "ml_sales_pipeline_paid_usage",
  });

  logBilling("billing", "BILLING_BILLABLE_SALE_PAID_TRANSITION", {
    user_id: userId,
    subscription_id: subscriptionId,
    usage_count: usageCount,
    usage_state: machine.usage_state,
    result: paidResult,
    snapshot_origin: snapshotOrigin,
    official_order_at: officialOrderAt,
  });

  return {
    applied: true,
    paid: paidResult,
    snapshot_origin: snapshotOrigin,
    official_order_at: officialOrderAt,
  };
}
