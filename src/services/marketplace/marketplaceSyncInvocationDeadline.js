/**
 * SSOT — soft/hard deadline para invocações serverless do marketplace sync.
 *
 * Contrato (P0.2-N.1):
 * - Um relógio absoluto por HTTP invocation (T0 = request start).
 * - safeAbsoluteDeadline = MIN(T0 + requested, T0 + platformMax - shutdownMargin).
 * - Fase de orquestração (drain) e fase de job compartilham o MESMO relógio.
 * - MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS limita apenas orquestração, NÃO o job.
 * - Nunca resetar o relógio após claim.
 *
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
    Math.min(300000, Number.isFinite(Number(requestedBudgetMs)) ? Number(requestedBudgetMs) : 120000)
  );
  return Math.min(requested, platformSafeWorkMs);
}

/**
 * Budget solicitado da invocation HTTP (capado depois pelo platform-safe).
 * NÃO confundir com MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS (orquestração only).
 * @param {{ budgetMs?: number }} [opts]
 */
export function resolveInvocationRequestedBudgetMs(opts = {}) {
  if (opts.budgetMs != null && Number.isFinite(Number(opts.budgetMs))) {
    return Math.max(3000, Number(opts.budgetMs));
  }
  const raw =
    process.env.MARKETPLACE_SYNC_INVOCATION_BUDGET_MS ??
    process.env.ML_MARKETPLACE_SYNC_BUDGET_MS ??
    "120000";
  return Math.min(
    300000,
    Math.max(3000, parseInt(String(raw), 10) || 120000)
  );
}

/**
 * Teto opcional só para fase A (pool/selector/recovery sweep) — não limita job work.
 */
export function resolveDrainOrchestrationTimeboxMs() {
  const raw =
    process.env.MARKETPLACE_SYNC_DRAIN_ORCHESTRATION_MS ??
    process.env.MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS ??
    "15000";
  return Math.min(120000, Math.max(3000, parseInt(String(raw), 10) || 15000));
}

/** Mínimo conservador para iniciar trabalho útil (primeira search ML). */
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
 * Trace temporal seguro por invocation (sem PII).
 * @param {number} startedAtMs
 */
export function createInvocationTrace(startedAtMs) {
  /** @type {{ phase: string; at_ms: number; elapsed_ms: number }[]} */
  const phases = [{ phase: "request_start", at_ms: startedAtMs, elapsed_ms: 0 }];
  let lastAt = startedAtMs;

  const mark = (phase) => {
    const now = Date.now();
    phases.push({
      phase,
      at_ms: now,
      elapsed_ms: now - startedAtMs,
    });
    lastAt = now;
  };

  const durationSincePrevious = () => Date.now() - lastAt;

  const summary = () => {
    const now = Date.now();
    /** @type {Record<string, number>} */
    const durations = {};
    for (let i = 1; i < phases.length; i += 1) {
      const prev = phases[i - 1];
      const cur = phases[i];
      durations[`${prev.phase}_to_${cur.phase}_ms`] = cur.at_ms - prev.at_ms;
    }
    return {
      request_start_ms: startedAtMs,
      total_ms: now - startedAtMs,
      phases: phases.map((p) => ({ phase: p.phase, elapsed_ms: p.elapsed_ms })),
      phase_durations: durations,
    };
  };

  return { mark, summary, durationSincePrevious };
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
    safe_absolute_deadline_at: new Date(softDeadlineMs).toISOString(),
    requested_budget_ms: requestedBudgetMs,
    effective_budget_ms: effectiveBudgetMs,
    platform_max_duration_ms: platformMaxMs,
    shutdown_margin_ms: shutdownMarginMs,
    elapsed_ms: nowFn() - startedAtMs,
    remaining_soft_ms: Math.max(0, softDeadlineMs - nowFn()),
    remaining_safe_ms: Math.max(0, softDeadlineMs - nowFn()),
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
