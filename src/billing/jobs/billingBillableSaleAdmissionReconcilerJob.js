// ======================================================================
// Reconciliador recorrente de admissions (S1.HF.6.9A.10)
// Periodicidade alvo: a cada 60s via cron HTTP.
// RECOVERY_REQUIRED não depende de execução manual.
// ======================================================================

import { logBilling } from "../billingLog.js";
import { reconcileExpiredBillableSaleReservations } from "../services/billingBillableSaleAdmissionService.js";

export const BILLABLE_SALE_ADMISSION_RECONCILER_DEFAULTS = {
  batch_limit: 100,
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
  const maxRetries = options.maxRetries ?? BILLABLE_SALE_ADMISSION_RECONCILER_DEFAULTS.max_retries;
  let attempt = 0;
  /** @type {Record<string, unknown> | null} */
  let lastResult = null;

  try {
    while (attempt < maxRetries) {
      attempt += 1;
      try {
        lastResult = await reconcileExpiredBillableSaleReservations(supabase, { batchLimit });
        logBilling("billing", "BILLING_ADMISSION_RECONCILER_OK", {
          source: options.source ?? "cron",
          attempt,
          batch_limit: batchLimit,
          processed: lastResult?.processed ?? null,
          expired: lastResult?.expired ?? null,
          finalized: lastResult?.finalized ?? null,
          recovery: lastResult?.recovery ?? null,
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
