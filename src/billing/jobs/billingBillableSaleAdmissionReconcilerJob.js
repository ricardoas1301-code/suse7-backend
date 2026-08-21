// ======================================================================
// Reconciliador recorrente de admissions (S1.HF.6.9A.10)
// Periodicidade alvo: a cada 60s via cron HTTP.
// RECOVERY_REQUIRED não depende de execução manual.
// ======================================================================

import { logBilling } from "../billingLog.js";
import { reconcileExpiredBillableSaleReservations } from "../services/billingBillableSaleAdmissionService.js";
import {
  MANUAL_REVIEW_PENDING_RECONCILER_DEFAULT_LIMIT,
  MANUAL_REVIEW_RECOVERY_DEFAULT_LIMIT,
} from "../services/billingManualReviewPendingService.js";
import {
  reconcileManualReviewPendingBatch,
  recoverSalesMissingManualReviewPending,
} from "../services/billingManualReviewPendingReconcilerService.js";

export const BILLABLE_SALE_ADMISSION_RECONCILER_DEFAULTS = {
  batch_limit: 100,
  /** Class B — pending manual review (separado de expired atomic). */
  pending_batch_limit: MANUAL_REVIEW_PENDING_RECONCILER_DEFAULT_LIMIT,
  recovery_limit: MANUAL_REVIEW_RECOVERY_DEFAULT_LIMIT,
  period_ms: 60_000,
  max_retries: 3,
  alert_after_exhausted_retries: true,
};

/** @type {{ running: boolean; lastStartedAt: string | null; lastFinishedAt: string | null; lastError: string | null }} */
const lockState = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null,
};

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   batchLimit?: number;
 *   pendingBatchLimit?: number;
 *   recoveryLimit?: number;
 *   maxRetries?: number;
 *   source?: string;
 * }} [options]
 */
export async function runBillableSaleAdmissionReconcilerJob(supabase, options = {}) {
  if (lockState.running) {
    logBilling("billing", "BILLING_ADMISSION_RECONCILER_SKIP_LOCKED", {
      source: options.source ?? "cron",
    });
    return { ok: false, skipped: true, reason: "lock_held" };
  }

  lockState.running = true;
  lockState.lastStartedAt = new Date().toISOString();
  lockState.lastError = null;

  const batchLimit = options.batchLimit ?? BILLABLE_SALE_ADMISSION_RECONCILER_DEFAULTS.batch_limit;
  const pendingBatchLimit =
    options.pendingBatchLimit ?? BILLABLE_SALE_ADMISSION_RECONCILER_DEFAULTS.pending_batch_limit;
  const recoveryLimit =
    options.recoveryLimit ?? BILLABLE_SALE_ADMISSION_RECONCILER_DEFAULTS.recovery_limit;
  const maxRetries = options.maxRetries ?? BILLABLE_SALE_ADMISSION_RECONCILER_DEFAULTS.max_retries;
  let attempt = 0;
  /** @type {Record<string, unknown> | null} */
  let lastResult = null;

  try {
    while (attempt < maxRetries) {
      attempt += 1;
      try {
        // Class A — expired/reservation recovery (prioridade: catraca atômica existente).
        const expiredResult = await reconcileExpiredBillableSaleReservations(supabase, {
          batchLimit,
        });

        // Class B — PENDING_MANUAL_REVIEW (promote/finalize only; nunca reserve v2).
        const pendingResult = await reconcileManualReviewPendingBatch(supabase, {
          limit: pendingBatchLimit,
        });

        // Gap recovery — sale persistida sem pending (limitado, pós-cutover operacional).
        const recoveryResult = await recoverSalesMissingManualReviewPending(supabase, {
          limit: recoveryLimit,
          dryRun: false,
        });

        lastResult = {
          class_a_expired: expiredResult,
          class_b_pending: pendingResult,
          sale_pending_recovery: recoveryResult,
        };

        logBilling("billing", "BILLING_ADMISSION_RECONCILER_OK", {
          source: options.source ?? "cron",
          attempt,
          batch_limit: batchLimit,
          pending_batch_limit: pendingBatchLimit,
          processed: expiredResult?.processed ?? null,
          expired: expiredResult?.expired ?? null,
          finalized: expiredResult?.finalized ?? null,
          recovery: expiredResult?.recovery ?? null,
          pending_selected: pendingResult?.selected_count ?? null,
          pending_remained: pendingResult?.remained_pending ?? null,
          pending_promoted: pendingResult?.promoted ?? null,
          pending_final_not_billable: pendingResult?.final_not_billable ?? null,
          gap_recovery_materialized: recoveryResult?.materialized ?? null,
        });
        lockState.lastFinishedAt = new Date().toISOString();
        return { ok: true, attempt, result: lastResult };
      } catch (err) {
        lockState.lastError = err instanceof Error ? err.message : String(err);
        logBilling("billing", "BILLING_ADMISSION_RECONCILER_RETRY", {
          source: options.source ?? "cron",
          attempt,
          max_retries: maxRetries,
          message: lockState.lastError,
        });
        if (attempt >= maxRetries) {
          if (BILLABLE_SALE_ADMISSION_RECONCILER_DEFAULTS.alert_after_exhausted_retries) {
            logBilling("billing", "BILLING_ADMISSION_RECONCILER_ALERT_EXHAUSTED", {
              source: options.source ?? "cron",
              attempt,
              message: lockState.lastError,
            });
          }
          throw err;
        }
      }
    }
    return { ok: false, attempt, result: lastResult };
  } finally {
    lockState.running = false;
  }
}

export function getBillableSaleAdmissionReconcilerLockState() {
  return { ...lockState };
}
