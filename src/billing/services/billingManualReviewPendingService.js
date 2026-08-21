// ======================================================================
// P0.3-C.1B — pending manual review durável (materialização + RPCs)
// Pending eligible → promote RPC only (nunca reserve v2).
// ======================================================================

import { randomUUID } from "node:crypto";
import { logBilling } from "../billingLog.js";
import { BILLING_SALE_PERIOD_CLASS, BILLING_SNAPSHOT_ORIGIN } from "../billingConstants.js";
import {
  classifySalePeriodForQuota,
  isOnboardingImportOrigin,
  normalizeBillingSnapshotOrigin,
  resolveOfficialOrderAt,
} from "./billingQuotaEligibilityService.js";
import {
  resolveBabyAdmissionCycleKey,
  resolveSalesLimitSnapshotFromMetadata,
} from "./billingBillableSaleAdmissionService.js";
import { loadCanonicalBillableSubscriptionContext } from "./billingCanonicalSubscriptionService.js";
import { loadSellerEntitlementOverlay } from "./billingSellerEntitlementStoreService.js";
import { resolveBillingAccessEntitlementSnapshot } from "./billingSubscriptionEntitlementService.js";

export const MANUAL_REVIEW_PENDING_RECONCILER_DEFAULT_LIMIT = 50;
export const MANUAL_REVIEW_RECOVERY_DEFAULT_LIMIT = 25;
export const MANUAL_REVIEW_RECOVERY_LOOKBACK_DAYS = 30;
export const MANUAL_REVIEW_PENDING_RETRY_INTERVAL_MS = 15 * 60 * 1000;

/**
 * @param {Record<string, unknown>} classified
 */
export function resolveManualReviewReconciliationAction(classified) {
  if (
    classified.manual_review_required ||
    classified.class === BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW
  ) {
    return { action: "remain_pending", reason: String(classified.reason ?? "manual_review_required") };
  }

  if (
    classified.quota_eligible === true &&
    classified.class === BILLING_SALE_PERIOD_CLASS.FRANQUIA_ELEGIVEL
  ) {
    return {
      action: "promote",
      reason: String(classified.reason ?? "current_cycle_eligible"),
      cycle_key: classified.cycle_key != null ? String(classified.cycle_key) : null,
    };
  }

  if (
    classified.class === BILLING_SALE_PERIOD_CLASS.PRE_OPERATIONAL_CUTOVER ||
    classified.class === BILLING_SALE_PERIOD_CLASS.IMPORTACAO_HISTORICA ||
    classified.class === BILLING_SALE_PERIOD_CLASS.TRIAL_OBSERVADO
  ) {
    return {
      action: "finalize",
      reason: String(classified.reason ?? classified.class),
      period_class: classified.class,
    };
  }

  return {
    action: "remain_pending",
    reason: String(classified.reason ?? "reconciliation_inconclusive"),
  };
}

/**
 * @param {Date} [now]
 */
export function computeManualReviewNextRecoveryAt(now = new Date()) {
  return new Date(now.getTime() + MANUAL_REVIEW_PENDING_RETRY_INTERVAL_MS);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   subscription_id: string;
 *   cycle_key: string;
 *   external_order_id: string;
 *   marketplace: string;
 *   marketplace_account_id: string;
 *   period_class?: string | null;
 *   classification_reason?: string | null;
 *   snapshot_origin?: string | null;
 *   official_order_at?: string | Date | null;
 *   next_recovery_at?: string | Date | null;
 * }} input
 */
export async function upsertManualReviewPendingAdmission(supabase, userId, input) {
  const officialIso =
    input.official_order_at instanceof Date
      ? input.official_order_at.toISOString()
      : input.official_order_at != null
        ? String(input.official_order_at)
        : null;
  const nextRecoveryIso =
    input.next_recovery_at instanceof Date
      ? input.next_recovery_at.toISOString()
      : input.next_recovery_at != null
        ? String(input.next_recovery_at)
        : computeManualReviewNextRecoveryAt().toISOString();

  const { data, error } = await supabase.rpc("billing_upsert_manual_review_pending_v1", {
    p_user_id: userId,
    p_subscription_id: input.subscription_id,
    p_cycle_key: input.cycle_key,
    p_external_order_id: input.external_order_id,
    p_marketplace: input.marketplace,
    p_marketplace_account_id: input.marketplace_account_id,
    p_period_class: input.period_class ?? null,
    p_classification_reason: input.classification_reason ?? null,
    p_snapshot_origin: normalizeBillingSnapshotOrigin(input.snapshot_origin),
    p_official_order_at: officialIso,
    p_next_recovery_at: nextRecoveryIso,
  });

  if (error) throw error;

  const row = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
  logBilling("billing", "BILLING_MANUAL_REVIEW_PENDING_UPSERT", {
    user_id: userId,
    external_order_id: input.external_order_id,
    ok: Boolean(row.ok),
    created: Boolean(row.created),
    duplicate: Boolean(row.duplicate),
    admission_id: row.admission_id ?? null,
    reason: row.reason ?? null,
  });

  return row;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   admission_id: string;
 *   reservation_owner_token?: string;
 *   usage_limit?: number | null;
 * }} input
 */
export async function promoteManualReviewPendingToReservation(supabase, userId, input) {
  const reservationOwnerToken = input.reservation_owner_token ?? randomUUID();
  const { data, error } = await supabase.rpc(
    "billing_promote_manual_review_pending_to_reservation_v1",
    {
      p_user_id: userId,
      p_admission_id: input.admission_id,
      p_reservation_owner_token: reservationOwnerToken,
      p_usage_limit: input.usage_limit ?? null,
      p_simulate_tx_failure: false,
    },
  );

  if (error) throw error;

  const row = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
  logBilling("billing", "BILLING_MANUAL_REVIEW_PROMOTE", {
    user_id: userId,
    admission_id: input.admission_id,
    ok: Boolean(row.ok),
    promoted: Boolean(row.promoted),
    reason: row.reason ?? null,
    usage_count: row.usage_count ?? null,
  });

  return { ...row, reservation_owner_token: reservationOwnerToken };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ admission_id: string; classification_reason?: string | null }} input
 */
export async function finalizeManualReviewNotBillable(supabase, userId, input) {
  const { data, error } = await supabase.rpc("billing_finalize_manual_review_not_billable_v1", {
    p_user_id: userId,
    p_admission_id: input.admission_id,
    p_classification_reason: input.classification_reason ?? null,
  });

  if (error) throw error;

  const row = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
  logBilling("billing", "BILLING_MANUAL_REVIEW_FINALIZE", {
    user_id: userId,
    admission_id: input.admission_id,
    ok: Boolean(row.ok),
    duplicate: Boolean(row.duplicate),
    reason: row.reason ?? null,
  });

  return row;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   external_order_id: string;
 *   marketplace: string;
 *   marketplace_account_id: string;
 *   atomic_admission?: Record<string, unknown> | null;
 *   period_class?: string | null;
 *   classification_reason?: string | null;
 *   snapshot_origin?: string | null;
 *   official_order_at?: string | Date | null;
 *   now?: Date;
 * }} input
 */
export async function materializeManualReviewPendingAfterSale(supabase, userId, input) {
  const snapshotOrigin = normalizeBillingSnapshotOrigin(
    input.snapshot_origin ?? input.atomic_admission?.snapshot_origin,
  );

  if (isOnboardingImportOrigin(snapshotOrigin)) {
    return { ok: false, skipped: true, reason: "historical_import_blocked" };
  }

  const { canonicalSubscription } = await loadCanonicalBillableSubscriptionContext(supabase, userId);
  if (!canonicalSubscription?.id) {
    return { ok: false, reason: "subscription_not_found" };
  }

  const meta =
    canonicalSubscription.metadata && typeof canonicalSubscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (canonicalSubscription.metadata)
      : {};
  const overlay = await loadSellerEntitlementOverlay(supabase, userId);
  const mergedMeta = { ...meta, ...overlay.metadata };
  const snapshot = await resolveBillingAccessEntitlementSnapshot(supabase, userId, {
    now: input.now instanceof Date ? input.now : new Date(),
  });
  const cycleKey = resolveBabyAdmissionCycleKey(mergedMeta, snapshot);

  const official =
    resolveOfficialOrderAt({
      date_created_marketplace: input.official_order_at,
      official_order_at: input.official_order_at,
    }) ??
    (input.official_order_at instanceof Date
      ? input.official_order_at
      : input.official_order_at != null
        ? new Date(String(input.official_order_at))
        : null);

  return upsertManualReviewPendingAdmission(supabase, userId, {
    subscription_id: String(canonicalSubscription.id),
    cycle_key: cycleKey,
    external_order_id: String(input.external_order_id),
    marketplace: String(input.marketplace),
    marketplace_account_id: String(input.marketplace_account_id),
    period_class:
      input.period_class ??
      (input.atomic_admission?.period_class != null
        ? String(input.atomic_admission.period_class)
        : BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW),
    classification_reason:
      input.classification_reason ??
      (input.atomic_admission?.classification_reason != null
        ? String(input.atomic_admission.classification_reason)
        : String(input.atomic_admission?.reason ?? "manual_review_required")),
    snapshot_origin: snapshotOrigin,
    official_order_at: official,
  });
}

/**
 * Reclassifica pending com metadata comercial atual (funções canônicas).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   snapshot_origin?: string | null;
 *   official_order_at?: string | null;
 *   now?: Date;
 * }} input
 */
export async function reclassifyManualReviewPendingCommercially(supabase, userId, input) {
  const now = input.now instanceof Date ? input.now : new Date();
  const overlay = await loadSellerEntitlementOverlay(supabase, userId);
  const { canonicalSubscription } = await loadCanonicalBillableSubscriptionContext(supabase, userId);
  const canonMeta =
    canonicalSubscription?.metadata && typeof canonicalSubscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (canonicalSubscription.metadata)
      : {};
  const mergedMeta = { ...canonMeta, ...overlay.metadata };
  const official = resolveOfficialOrderAt({
    date_created_marketplace: input.official_order_at,
    official_order_at: input.official_order_at,
  });

  return classifySalePeriodForQuota({
    metadata: mergedMeta,
    official_order_at: official,
    snapshot_origin: normalizeBillingSnapshotOrigin(input.snapshot_origin),
    now,
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} pendingRow
 */
export async function resolveUsageLimitForManualReviewPromote(supabase, userId, pendingRow) {
  const { canonicalSubscription } = await loadCanonicalBillableSubscriptionContext(supabase, userId);
  const meta =
    canonicalSubscription?.metadata && typeof canonicalSubscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (canonicalSubscription.metadata)
      : {};
  return resolveSalesLimitSnapshotFromMetadata(meta);
}

/**
 * Origens operacionais elegíveis para recovery/backfill (não histórico).
 */
export const OPERATIONAL_BILLING_SNAPSHOT_ORIGINS = [
  BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_SYNC,
  BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_WEBHOOK,
  BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_RECONCILIATION,
];
