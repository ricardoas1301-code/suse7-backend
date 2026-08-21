// ======================================================================
// Reconciliador recorrente de admissions (S1.HF.6.9A.10 + P0.3-C.1B-R budget)
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
import {
  BILLING_RECONCILER_EST_MS_PER_PENDING,
  BILLING_RECONCILER_EST_MS_PER_RECOVERY,
  BILLING_RECONCILER_INVOCATION_BUDGET_MS,
  BILLING_RECONCILER_RECOVERY_BATCH_LIMIT,
  createReconcilerInvocationBudget,
  resolveBoundedBatchLimit,
} from "./billingReconcilerInvocationBudget.js";

export const BILLABLE_SALE_ADMISSION_RECONCILER_DEFAULTS = {
  batch_limit: 100,
  /** Class B — pending manual review (separado de expired atomic). */
  pending_batch_limit: MANUAL_REVIEW_PENDING_RECONCILER_DEFAULT_LIMIT,
  recovery_limit: MANUAL_REVIEW_RECOVERY_DEFAULT_LIMIT,
  period_ms: 60_000,
  max_retries: 3,
  alert_after_exhausted_retries: true,
  invocation_budget_ms: BILLING_RECONCILER_INVOCATION_BUDGET_MS,
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
 *   invocationBudgetMs?: number;
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
  const budget = createReconcilerInvocationBudget({
    budgetMs:
      options.invocationBudgetMs ?? BILLABLE_SALE_ADMISSION_RECONCILER_DEFAULTS.invocation_budget_ms,
  });

  let attempt = 0;
  /** @type {Record<string, unknown> | null} */
  let lastResult = null;

  try {
    while (attempt < maxRetries) {
      attempt += 1;
      try {
        /** @type {Record<string, unknown>} */
        const phaseTimings = {};
        let softYield = false;
        /** @type {string[]} */
        const yieldReasons = [];

        const classAStarted = Date.now();
        const expiredResult = await reconcileExpiredBillableSaleReservations(supabase, {
          batchLimit,
        });
        phaseTimings.class_a_expired_ms = Date.now() - classAStarted;

        if (budget.shouldYield(BILLING_RECONCILER_EST_MS_PER_PENDING)) {
          softYield = true;
          yieldReasons.push("budget_before_class_b");
          lastResult = {
            class_a_expired: expiredResult,
            class_b_pending: { selected_count: 0, skipped_budget: true },
            sale_pending_recovery: { scanned: 0, skipped_budget: true },
            phase_timings_ms: phaseTimings,
            soft_yield: true,
            remaining_work: true,
            yield_reasons: yieldReasons,
            budget: budget.snapshot(),
          };
          lockState.lastFinishedAt = new Date().toISOString();
          return { ok: true, attempt, result: lastResult };
        }

        const boundedPendingLimit = resolveBoundedBatchLimit(
          budget,
          BILLING_RECONCILER_EST_MS_PER_PENDING,
          pendingBatchLimit,
        );

        const classBStarted = Date.now();
        const pendingResult = await reconcileManualReviewPendingBatch(supabase, {
          limit: boundedPendingLimit,
          deadline: budget,
        });
        phaseTimings.class_b_pending_ms = Date.now() - classBStarted;

        if (budget.shouldYield(BILLING_RECONCILER_EST_MS_PER_RECOVERY)) {
          softYield = true;
          yieldReasons.push("budget_before_recovery");
          lastResult = {
            class_a_expired: expiredResult,
            class_b_pending: pendingResult,
            sale_pending_recovery: { scanned: 0, skipped_budget: true },
            phase_timings_ms: phaseTimings,
            soft_yield: true,
            remaining_work: true,
            yield_reasons: yieldReasons,
            budget: budget.snapshot(),
          };
          lockState.lastFinishedAt = new Date().toISOString();
          return { ok: true, attempt, result: lastResult };
        }

        const boundedRecoveryLimit = resolveBoundedBatchLimit(
          budget,
          BILLING_RECONCILER_EST_MS_PER_RECOVERY,
          Math.min(recoveryLimit, BILLING_RECONCILER_RECOVERY_BATCH_LIMIT),
        );

        const recoveryStarted = Date.now();
        const recoveryResult = await recoverSalesMissingManualReviewPending(supabase, {
          limit: boundedRecoveryLimit,
          dryRun: false,
          deadline: budget,
        });
        phaseTimings.sale_pending_recovery_ms = Date.now() - recoveryStarted;

        if (
          (pendingResult.selected_count ?? 0) >= boundedPendingLimit &&
          boundedPendingLimit > 0
        ) {
          softYield = true;
          yieldReasons.push("class_b_backlog");
        }
        if ((recoveryResult.scanned ?? 0) >= boundedRecoveryLimit && boundedRecoveryLimit > 0) {
          softYield = true;
          yieldReasons.push("recovery_backlog");
        }

        lastResult = {
          class_a_expired: expiredResult,
          class_b_pending: pendingResult,
          sale_pending_recovery: recoveryResult,
          phase_timings_ms: phaseTimings,
          soft_yield: softYield,
          remaining_work: softYield,
          yield_reasons: yieldReasons,
          budget: budget.snapshot(),
        };

        logBilling("billing", "BILLING_ADMISSION_RECONCILER_OK", {
          source: options.source ?? "cron",
          attempt,
          batch_limit: batchLimit,
          pending_batch_limit: boundedPendingLimit,
          recovery_limit: boundedRecoveryLimit,
          processed: expiredResult?.processed ?? null,
          pending_selected: pendingResult?.selected_count ?? null,
          gap_recovery_materialized: recoveryResult?.materialized ?? null,
          soft_yield: softYield,
          elapsed_ms: budget.elapsedMs(),
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
