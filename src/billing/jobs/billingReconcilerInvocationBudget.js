// ======================================================================
// P0.3-C.1B-R — SSOT de budget para invocation serverless do reconciler
// Plataforma Vercel: maxDuration 60s — job deve encerrar com margem.
// ======================================================================

/** Limite hard da plataforma (vercel.json maxDuration). */
export const BILLING_RECONCILER_PLATFORM_MAX_DURATION_MS = 60_000;

/** Margem para HTTP, cold start, serialização e latência DB. */
export const BILLING_RECONCILER_HTTP_OVERHEAD_MS = 15_000;

/** Budget seguro alvo por invocation (~42–45s). */
export const BILLING_RECONCILER_INVOCATION_BUDGET_MS = 45_000;

/** Limite Class B por run quando sem budget customizado. */
export const BILLING_RECONCILER_PENDING_BATCH_LIMIT = 10;

/** Recovery máximo por run (pode ser reduzido pelo budget remanescente). */
export const BILLING_RECONCILER_RECOVERY_BATCH_LIMIT = 10;

/** Estimativa conservadora por pending Class B (ms). */
export const BILLING_RECONCILER_EST_MS_PER_PENDING = 800;

/** Estimativa conservadora por sale recovery (ms). */
export const BILLING_RECONCILER_EST_MS_PER_RECOVERY = 1_200;

/**
 * @param {{ startedAtMs?: number; budgetMs?: number }} [options]
 */
export function createReconcilerInvocationBudget(options = {}) {
  const startedAtMs = options.startedAtMs ?? Date.now();
  const budgetMs = options.budgetMs ?? BILLING_RECONCILER_INVOCATION_BUDGET_MS;

  return {
    startedAtMs,
    budgetMs,
    elapsedMs() {
      return Date.now() - startedAtMs;
    },
    remainingMs() {
      return Math.max(0, budgetMs - this.elapsedMs());
    },
    isExpired() {
      return this.elapsedMs() >= budgetMs;
    },
    shouldYield(minRemainingMs = 0) {
      return this.remainingMs() <= minRemainingMs;
    },
    snapshot() {
      return {
        budget_ms: budgetMs,
        elapsed_ms: this.elapsedMs(),
        remaining_ms: this.remainingMs(),
      };
    },
  };
}

/**
 * @param {ReturnType<typeof createReconcilerInvocationBudget>} budget
 * @param {number} estMsPerItem
 * @param {number} maxLimit
 */
export function resolveBoundedBatchLimit(budget, estMsPerItem, maxLimit) {
  if (budget.isExpired()) return 0;
  const affordable = Math.floor(budget.remainingMs() / estMsPerItem);
  return Math.max(0, Math.min(maxLimit, affordable));
}
