/**
 * SSOT — soft/hard deadline para invocações serverless do marketplace sync.
 *
 * P0.2-N.1: MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS limita orquestração, não o job.
 * effective_budget = MIN(requested_budget, platform_max - shutdown_margin)
 */

export function resolvePlatformMaxDurationMs() {
  return Math.min(
    300000,
    Math.max(5000, parseInt(process.env.MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS || "60000", 10) || 60000)
  );
}

export function resolveShutdownMarginMs() {
  return Math.min(
    45000,
    Math.max(3000, parseInt(process.env.MARKETPLACE_SYNC_SHUTDOWN_MARGIN_MS || "18000", 10) || 18000)
  );
}

export function resolveMinExternalWorkMs() {
  return Math.min(
    60000,
    Math.max(1000, parseInt(process.env.MARKETPLACE_SYNC_MIN_EXTERNAL_WORK_MS || "8000", 10) || 8000)
  );
}

/**
 * @param {number} requestedBudgetMs
 * @param {{ platformMaxDurationMs?: number; shutdownMarginMs?: number }} [opts]
 */
export function computeEffectiveBudgetMs(requestedBudgetMs, opts = {}) {
  const platformMax = opts.platformMaxDurationMs ?? resolvePlatformMaxDurationMs();
  const margin = opts.shutdownMarginMs ?? resolveShutdownMarginMs();
  const platformSafeWorkMs = Math.max(3000, platformMax - margin);
  const requested = Math.max(
    3000,
    Math.min(120000, Number.isFinite(Number(requestedBudgetMs)) ? Number(requestedBudgetMs) : 120000)
  );
  return Math.min(requested, platformSafeWorkMs);
}

/**
 * Budget da invocation HTTP — NÃO usar MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS aqui.
 * @param {{ budgetMs?: number }} [opts]
 */
export function resolveInvocationRequestedBudgetMs(opts = {}) {
  if (opts.budgetMs != null && Number.isFinite(Number(opts.budgetMs))) {
    return Math.max(3000, Number(opts.budgetMs));
  }
  const invocationRaw = process.env.MARKETPLACE_SYNC_INVOCATION_BUDGET_MS;
  if (invocationRaw != null && String(invocationRaw).trim() !== "") {
    return Math.min(
      300000,
      Math.max(3000, parseInt(String(invocationRaw), 10) || 120000)
    );
  }
  const legacyRaw = parseInt(String(process.env.ML_MARKETPLACE_SYNC_BUDGET_MS || ""), 10);
  if (Number.isFinite(legacyRaw) && legacyRaw >= 60000) {
    return Math.min(300000, Math.max(3000, legacyRaw));
  }
  return 120000;
}

/**
 * Teto opcional da fase de orquestração (pool/selector) — não limita job work.
 */
export function resolveDrainOrchestrationTimeboxMs() {
  const raw =
    process.env.MARKETPLACE_SYNC_DRAIN_ORCHESTRATION_MS ??
    process.env.MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS ??
    "15000";
  return Math.min(120000, Math.max(3000, parseInt(String(raw), 10) || 15000));
}

export function resolveMinimumUsefulJobStartMs() {
  const raw = parseInt(process.env.MARKETPLACE_SYNC_MIN_USEFUL_JOB_START_MS || "0", 10);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(60000, Math.max(1000, raw));
  }
  const mlTimeout = Math.min(
    120000,
    Math.max(3000, parseInt(process.env.ML_REQUEST_TIMEOUT_MS || "28000", 10) || 28000)
  );
  return Math.min(mlTimeout + 2000, resolveMinExternalWorkMs() + 4000);
}

/**
 * @param {{
 *   requestedBudgetMs?: number;
 *   startedAtMs?: number;
 *   platformMaxDurationMs?: number;
 *   shutdownMarginMs?: number;
 *   nowFn?: () => number;
 * }} [opts]
 */
export function createInvocationDeadline(opts = {}) {
  const nowFn = typeof opts.nowFn === "function" ? opts.nowFn : () => Date.now();
  const startedAtMs = opts.startedAtMs ?? nowFn();
  const platformMaxMs = opts.platformMaxDurationMs ?? resolvePlatformMaxDurationMs();
  const shutdownMarginMs = opts.shutdownMarginMs ?? resolveShutdownMarginMs();
  const requestedBudgetMs = Math.max(
    3000,
    Number.isFinite(Number(opts.requestedBudgetMs)) ? Number(opts.requestedBudgetMs) : 120000
  );
  const effectiveBudgetMs = computeEffectiveBudgetMs(requestedBudgetMs, {
    platformMaxDurationMs: platformMaxMs,
    shutdownMarginMs,
  });

  const hardDeadlineMs = startedAtMs + platformMaxMs;
  const softDeadlineMs = startedAtMs + effectiveBudgetMs;

  const snapshot = () => ({
    invocation_started_at: new Date(startedAtMs).toISOString(),
    hard_deadline_at: new Date(hardDeadlineMs).toISOString(),
    soft_deadline_at: new Date(softDeadlineMs).toISOString(),
    requested_budget_ms: requestedBudgetMs,
    effective_budget_ms: effectiveBudgetMs,
    platform_max_duration_ms: platformMaxMs,
    shutdown_margin_ms: shutdownMarginMs,
    elapsed_ms: nowFn() - startedAtMs,
    remaining_soft_ms: Math.max(0, softDeadlineMs - nowFn()),
    remaining_hard_ms: Math.max(0, hardDeadlineMs - nowFn()),
  });

  const logEvent = (event, extra = {}) => {
    console.info("[S7][marketplace-sync-deadline]", { event, ...snapshot(), ...extra });
  };

  return {
    startedAtMs,
    hardDeadlineMs,
    softDeadlineMs,
    requestedBudgetMs,
    effectiveBudgetMs,
    platformMaxMs,
    shutdownMarginMs,
    nowFn,
    get deadlineMs() {
      return softDeadlineMs;
    },
    getElapsedMs: () => nowFn() - startedAtMs,
    getRemainingSoftMs: () => Math.max(0, softDeadlineMs - nowFn()),
    getRemainingSafeMs: () => Math.max(0, softDeadlineMs - nowFn()),
    getRemainingHardMs: () => Math.max(0, hardDeadlineMs - nowFn()),
    hasBudgetForExternalWork: (estimatedMs = resolveMinExternalWorkMs()) => {
      const est = Math.max(0, Number(estimatedMs) || 0);
      const remainingSoft = softDeadlineMs - nowFn();
      const remainingHard = hardDeadlineMs - nowFn();
      if (remainingHard <= shutdownMarginMs) return false;
      if (remainingSoft <= 0) return false;
      return remainingSoft >= est;
    },
    isSoftExpired: () => nowFn() >= softDeadlineMs,
    isHardExpired: () => nowFn() >= hardDeadlineMs,
    shouldStopBeforeNextExternalWork: (estimatedMs = resolveMinExternalWorkMs()) => {
      const est = Math.max(0, Number(estimatedMs) || 0);
      const remainingSoft = softDeadlineMs - nowFn();
      const remainingHard = hardDeadlineMs - nowFn();
      if (remainingHard <= shutdownMarginMs) return true;
      if (remainingSoft <= 0) return true;
      return remainingSoft < est;
    },
    shouldAllowBackoffSleep: (delayMs) => {
      const delay = Math.max(0, Number(delayMs) || 0);
      if (delay <= 0) return true;
      const remainingSoft = softDeadlineMs - nowFn();
      const remainingHard = hardDeadlineMs - nowFn();
      if (remainingHard <= shutdownMarginMs) return false;
      return delay <= remainingSoft - 500;
    },
    snapshot,
    logEvent,
  };
}
