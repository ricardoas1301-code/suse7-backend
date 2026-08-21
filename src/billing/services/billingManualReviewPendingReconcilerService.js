// ======================================================================
// P0.3-C.1B — reconciler Class B (PENDING_MANUAL_REVIEW) + gap recovery
// ======================================================================

import { BILLING_RECONCILER_EST_MS_PER_PENDING, BILLING_RECONCILER_EST_MS_PER_RECOVERY } from "../jobs/billingReconcilerInvocationBudget.js";
import { randomUUID } from "node:crypto";
import { logBilling } from "../billingLog.js";
import { BILLING_SALE_PERIOD_CLASS } from "../billingConstants.js";
import { finalizeBillableSaleV2 } from "./billingBillableSaleAdmissionService.js";
import {
  computeManualReviewNextRecoveryAt,
  finalizeManualReviewNotBillable,
  MANUAL_REVIEW_PENDING_RECONCILER_DEFAULT_LIMIT,
  MANUAL_REVIEW_RECOVERY_DEFAULT_LIMIT,
  MANUAL_REVIEW_RECOVERY_LOOKBACK_DAYS,
  materializeManualReviewPendingAfterSale,
  promoteManualReviewPendingToReservation,
  reclassifyManualReviewPendingCommercially,
  resolveManualReviewReconciliationAction,
  resolveUsageLimitForManualReviewPromote,
  upsertManualReviewPendingAdmission,
} from "./billingManualReviewPendingService.js";
import {
  pendingCycleKeysAligned,
} from "./billingManualReviewPendingMetadataService.js";
import {
  isOnboardingImportOrigin,
  normalizeBillingSnapshotOrigin,
} from "./billingQuotaEligibilityService.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ limit?: number; now?: Date }} [options]
 */
export async function selectDueManualReviewPendingAdmissions(supabase, options = {}) {
  const limit = options.limit ?? MANUAL_REVIEW_PENDING_RECONCILER_DEFAULT_LIMIT;
  const nowIso = (options.now instanceof Date ? options.now : new Date()).toISOString();

  const { data, error } = await supabase
    .from("billing_billable_sale_admissions")
    .select(
      "id,user_id,subscription_id,cycle_key,external_order_id,marketplace,marketplace_account_id,period_class,classification_reason,snapshot_origin,official_order_at,admission_result,next_recovery_at",
    )
    .eq("admission_result", "PENDING_MANUAL_REVIEW")
    .lte("next_recovery_at", nowIso)
    .order("next_recovery_at", { ascending: true })
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} pendingRow
 * @param {{ now?: Date }} [options]
 */
export async function reconcileOneManualReviewPendingAdmission(supabase, pendingRow, options = {}) {
  const userId = String(pendingRow.user_id ?? "");
  const admissionId = String(pendingRow.id ?? "");
  const externalOrderId = String(pendingRow.external_order_id ?? "");

  if (!userId || !admissionId) {
    return { ok: false, reason: "invalid_pending_row" };
  }

  let classified;
  try {
    classified = await reclassifyManualReviewPendingCommercially(supabase, userId, {
      snapshot_origin: pendingRow.snapshot_origin,
      official_order_at: pendingRow.official_order_at,
      now: options.now,
    });
  } catch (err) {
    logBilling("billing", "BILLING_MANUAL_REVIEW_RECLASSIFY_FAILED", {
      user_id: userId,
      admission_id: admissionId,
      external_order_id: externalOrderId,
      message: err instanceof Error ? err.message : String(err),
    });
    await upsertManualReviewPendingAdmission(supabase, userId, {
      subscription_id: String(pendingRow.subscription_id),
      cycle_key: String(pendingRow.cycle_key),
      external_order_id: externalOrderId,
      marketplace: String(pendingRow.marketplace),
      marketplace_account_id: String(pendingRow.marketplace_account_id),
      period_class: pendingRow.period_class != null ? String(pendingRow.period_class) : null,
      classification_reason: "classifier_temporary_failure",
      snapshot_origin: pendingRow.snapshot_origin,
      official_order_at: pendingRow.official_order_at,
      next_recovery_at: computeManualReviewNextRecoveryAt(
        options.now instanceof Date ? options.now : new Date(),
      ),
    });
    return { ok: true, outcome: "remain_pending", reason: "classifier_temporary_failure" };
  }

  const action = resolveManualReviewReconciliationAction(classified);

  if (action.action === "remain_pending") {
    await upsertManualReviewPendingAdmission(supabase, userId, {
      subscription_id: String(pendingRow.subscription_id),
      cycle_key: String(pendingRow.cycle_key),
      external_order_id: externalOrderId,
      marketplace: String(pendingRow.marketplace),
      marketplace_account_id: String(pendingRow.marketplace_account_id),
      period_class: classified.class,
      classification_reason: action.reason,
      snapshot_origin: pendingRow.snapshot_origin,
      official_order_at: classified.official_order_at ?? pendingRow.official_order_at,
      next_recovery_at: computeManualReviewNextRecoveryAt(
        options.now instanceof Date ? options.now : new Date(),
      ),
    });
    return { ok: true, outcome: "remain_pending", reason: action.reason };
  }

  if (action.action === "promote") {
    const targetCycleKey =
      action.cycle_key != null
        ? String(action.cycle_key)
        : classified.cycle_key != null
          ? String(classified.cycle_key)
          : null;

    if (!pendingCycleKeysAligned(pendingRow.cycle_key, targetCycleKey)) {
      await upsertManualReviewPendingAdmission(supabase, userId, {
        subscription_id: String(pendingRow.subscription_id),
        cycle_key: String(pendingRow.cycle_key),
        external_order_id: externalOrderId,
        marketplace: String(pendingRow.marketplace),
        marketplace_account_id: String(pendingRow.marketplace_account_id),
        period_class: classified.class,
        classification_reason: "cycle_identity_unresolved",
        snapshot_origin: pendingRow.snapshot_origin,
        official_order_at: classified.official_order_at ?? pendingRow.official_order_at,
        next_recovery_at: computeManualReviewNextRecoveryAt(
          options.now instanceof Date ? options.now : new Date(),
        ),
      });
      return { ok: true, outcome: "remain_pending", reason: "cycle_identity_unresolved" };
    }
  }

  if (action.action === "finalize") {
    const result = await finalizeManualReviewNotBillable(supabase, userId, {
      admission_id: admissionId,
      classification_reason: action.reason,
    });
    return {
      ok: Boolean(result.ok),
      outcome: "final_not_billable",
      reason: result.reason ?? action.reason,
      duplicate: Boolean(result.duplicate),
    };
  }

  // promote — NUNCA reserve v2
  const usageLimit = await resolveUsageLimitForManualReviewPromote(supabase, userId, pendingRow);
  const reservationOwnerToken = randomUUID();
  const promoteResult = await promoteManualReviewPendingToReservation(supabase, userId, {
    admission_id: admissionId,
    reservation_owner_token: reservationOwnerToken,
    usage_limit: usageLimit,
  });

  if (!promoteResult.ok) {
    if (promoteResult.reason === "baby_hard_limit_reached") {
      await upsertManualReviewPendingAdmission(supabase, userId, {
        subscription_id: String(pendingRow.subscription_id),
        cycle_key: String(pendingRow.cycle_key),
        external_order_id: externalOrderId,
        marketplace: String(pendingRow.marketplace),
        marketplace_account_id: String(pendingRow.marketplace_account_id),
        period_class: classified.class,
        classification_reason: "baby_hard_limit_reached",
        snapshot_origin: pendingRow.snapshot_origin,
        official_order_at: classified.official_order_at ?? pendingRow.official_order_at,
        next_recovery_at: computeManualReviewNextRecoveryAt(
          options.now instanceof Date ? options.now : new Date(),
        ),
      });
      return { ok: true, outcome: "remain_pending", reason: "baby_hard_limit_reached" };
    }
    return {
      ok: false,
      outcome: "promote_failed",
      reason: promoteResult.reason ?? "promote_failed",
    };
  }

  let finalizeResult = null;
  if (promoteResult.process_sale !== false) {
    try {
      finalizeResult = await finalizeBillableSaleV2(supabase, {
        userId,
        reservationId: admissionId,
        reservationOwnerToken,
        persistedAt: new Date(),
      });
    } catch (finalizeErr) {
      logBilling("billing", "BILLING_MANUAL_REVIEW_PROMOTE_FINALIZE_FAILED", {
        user_id: userId,
        admission_id: admissionId,
        message: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
      });
      return {
        ok: true,
        outcome: "promoted_pending_finalize",
        reason: "finalize_failed_recovery_required",
        promote: promoteResult,
      };
    }
  }

  return {
    ok: true,
    outcome: "promoted",
    reason: promoteResult.reason ?? action.reason,
    duplicate: Boolean(promoteResult.duplicate),
    finalized: Boolean(finalizeResult?.finalized),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ limit?: number; now?: Date; deadline?: { shouldYield: (n?: number) => boolean } }} [options]
 */
export async function reconcileManualReviewPendingBatch(supabase, options = {}) {
  const selected = await selectDueManualReviewPendingAdmissions(supabase, options);
  /** @type {Record<string, number>} */
  const counts = {
    selected_count: selected.length,
    remained_pending: 0,
    promoted: 0,
    final_not_billable: 0,
    errors: 0,
    skipped_budget: 0,
  };

  /** @type {Array<Record<string, unknown>>} */
  const details = [];

  for (const row of selected) {
    if (options.deadline?.shouldYield(BILLING_RECONCILER_EST_MS_PER_PENDING)) {
      counts.skipped_budget += selected.length - details.length;
      break;
    }
    try {
      const result = await reconcileOneManualReviewPendingAdmission(
        supabase,
        /** @type {Record<string, unknown>} */ (row),
        options,
      );
      details.push({ admission_id: row.id, external_order_id: row.external_order_id, ...result });
      if (result.outcome === "remain_pending" || result.outcome === "promoted_pending_finalize") {
        counts.remained_pending += 1;
      } else if (result.outcome === "promoted") {
        counts.promoted += 1;
      } else if (result.outcome === "final_not_billable") {
        counts.final_not_billable += 1;
      } else if (!result.ok) {
        counts.errors += 1;
      }
    } catch (err) {
      counts.errors += 1;
      details.push({
        admission_id: row.id,
        external_order_id: row.external_order_id,
        ok: false,
        outcome: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logBilling("billing", "BILLING_MANUAL_REVIEW_RECONCILER_BATCH", counts);
  return { ...counts, details };
}

/**
 * Vendas operacionais recentes sem admission — recovery limitado (sem full scan).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   limit?: number;
 *   lookbackDays?: number;
 *   marketplaceAccountId?: string | null;
 *   now?: Date;
 * }} [options]
 */
export async function selectOperationalSalesMissingAdmission(supabase, options = {}) {
  const limit = options.limit ?? MANUAL_REVIEW_RECOVERY_DEFAULT_LIMIT;
  const lookbackDays = options.lookbackDays ?? MANUAL_REVIEW_RECOVERY_LOOKBACK_DAYS;
  const now = options.now instanceof Date ? options.now : new Date();
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("sales_orders")
    .select(
      "id,user_id,external_order_id,marketplace,marketplace_account_id,date_created_marketplace,created_at",
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(Math.min(limit * 4, 200));

  if (options.marketplaceAccountId) {
    query = query.eq("marketplace_account_id", String(options.marketplaceAccountId));
  }

  const { data: sales, error } = await query;
  if (error) throw error;
  if (!sales?.length) return [];

  /** @type {Array<Record<string, unknown>>} */
  const candidates = [];

  for (const sale of sales) {
    if (candidates.length >= limit) break;
    const userId = String(sale.user_id ?? "");
    const externalOrderId = String(sale.external_order_id ?? "");
    const marketplace = String(sale.marketplace ?? "");
    const marketplaceAccountId = String(sale.marketplace_account_id ?? "");
    if (!userId || !externalOrderId || !marketplace || !marketplaceAccountId) continue;

    const { count, error: admErr } = await supabase
      .from("billing_billable_sale_admissions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .eq("marketplace_account_id", marketplaceAccountId)
      .eq("external_order_id", externalOrderId)
      .in("admission_result", [
        "PENDING_MANUAL_REVIEW",
        "RESERVED",
        "PERSISTED",
        "RECOVERY_REQUIRED",
        "FINAL_NOT_BILLABLE",
      ]);

    if (admErr) throw admErr;
    if ((count ?? 0) > 0) continue;

    candidates.push(sale);
  }

  return candidates;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   limit?: number;
 *   lookbackDays?: number;
 *   marketplaceAccountId?: string | null;
 *   snapshot_origin?: string | null;
 *   dryRun?: boolean;
 *   now?: Date;
 *   deadline?: { shouldYield: (n?: number) => boolean };
 * }} [options]
 */
export async function recoverSalesMissingManualReviewPending(supabase, options = {}) {
  const candidates = await selectOperationalSalesMissingAdmission(supabase, options);
  /** @type {Record<string, number>} */
  const counts = {
    scanned: candidates.length,
    materialized: 0,
    skipped: 0,
    errors: 0,
  };
  /** @type {Array<Record<string, unknown>>} */
  const details = [];

  for (const sale of candidates) {
    if (options.deadline?.shouldYield(BILLING_RECONCILER_EST_MS_PER_RECOVERY)) {
      counts.skipped += candidates.length - details.filter((d) => !d.skipped_budget).length;
      details.push({ skipped_budget: true, reason: "invocation_budget" });
      break;
    }

    const userId = String(sale.user_id ?? "");
    const externalOrderId = String(sale.external_order_id ?? "");
    const snapshotOrigin = normalizeBillingSnapshotOrigin(
      options.snapshot_origin ?? "operational_sync",
    );

    if (isOnboardingImportOrigin(snapshotOrigin)) {
      counts.skipped += 1;
      details.push({ external_order_id: externalOrderId, skipped: true, reason: "historical" });
      continue;
    }

    try {
      const classified = await reclassifyManualReviewPendingCommercially(supabase, userId, {
        snapshot_origin: snapshotOrigin,
        official_order_at: sale.date_created_marketplace,
        now: options.now,
      });

      const shouldMaterialize =
        classified.manual_review_required ||
        classified.class === BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW;

      if (!shouldMaterialize) {
        counts.skipped += 1;
        details.push({
          external_order_id: externalOrderId,
          skipped: true,
          reason: classified.reason,
          class: classified.class,
        });
        continue;
      }

      if (options.dryRun) {
        details.push({
          external_order_id: externalOrderId,
          date: sale.date_created_marketplace ?? sale.created_at,
          classification: classified.class,
          reason: classified.reason,
          dry_run: true,
        });
        continue;
      }

      const result = await materializeManualReviewPendingAfterSale(supabase, userId, {
        external_order_id: externalOrderId,
        marketplace: String(sale.marketplace),
        marketplace_account_id: String(sale.marketplace_account_id),
        snapshot_origin: snapshotOrigin,
        official_order_at: sale.date_created_marketplace,
        period_class: classified.class,
        classification_reason: classified.reason,
        now: options.now,
      });

      if (result.ok) {
        counts.materialized += 1;
      } else {
        counts.skipped += 1;
      }
      details.push({
        external_order_id: externalOrderId,
        ok: Boolean(result.ok),
        reason: result.reason ?? null,
        admission_id: result.admission_id ?? null,
      });
    } catch (err) {
      counts.errors += 1;
      details.push({
        external_order_id: externalOrderId,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ...counts, details };
}
