/**
 * SSOT — soft/hard deadline para invocações serverless do marketplace sync.
 * effective_budget = MIN(requested_budget, platform_max - shutdown_margin)
 *
 * Hosted (VERCEL): platform_max=60s (kill da plataforma). Local: processo longo,
 * então o requested_budget (120s) deixa de ser esmagado para ~42s.
 */

/**
 * Margem positiva além da estimativa de persist: rede, DB, event loop, log, patch do job, lease.
 * Default 1000 ms — não iniciar persist na igualdade remaining == estimate.
 */
export const MARKETPLACE_SYNC_PERSIST_SAFETY_MARGIN_MS_DEFAULT = 1000;

/**
 * Cap seguro da Vercel (kill da plataforma). Outros serverless futuros herdam este piso.
 */
export const MARKETPLACE_SYNC_VERCEL_PLATFORM_CAP_MS = 60000;

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isMarketplaceSyncServerlessRuntime(env = process.env) {
  if (isVercelRuntime(env)) return true;
  if (env?.AWS_LAMBDA_FUNCTION_NAME && String(env.AWS_LAMBDA_FUNCTION_NAME).trim() !== "") return true;
  if (env?.K_SERVICE && String(env.K_SERVICE).trim() !== "") return true;
  if (env?.FUNCTIONS_WORKER_RUNTIME && String(env.FUNCTIONS_WORKER_RUNTIME).trim() !== "") return true;
  return false;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isVercelRuntime(env = process.env) {
  const raw = env?.VERCEL;
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "off") return false;
  return true;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveDetectedPlatformCapMs(env = process.env) {
  if (isMarketplaceSyncServerlessRuntime(env)) return MARKETPLACE_SYNC_VERCEL_PLATFORM_CAP_MS;
  return 180000;
}

export function resolveDefaultPlatformMaxDurationMs(env = process.env) {
  return resolveDetectedPlatformCapMs(env);
}

/**
 * Override menor reduz. Override maior NÃO ultrapassa o cap detectado.
 * Inválido → cap detectado (default seguro).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveClampedPlatformOverrideMs(env = process.env) {
  const detected = resolveDetectedPlatformCapMs(env);
  const raw = env?.MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS;
  if (raw == null || String(raw).trim() === "") return detected;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return detected;
  const bounded = Math.min(300000, Math.max(5000, n));
  return Math.min(detected, bounded);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePersistSafetyMarginMs(env = process.env) {
  const raw = env?.MARKETPLACE_SYNC_PERSIST_SAFETY_MARGIN_MS;
  if (raw != null && String(raw).trim() !== "") {
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n)) return Math.min(5000, Math.max(200, n));
  }
  return MARKETPLACE_SYNC_PERSIST_SAFETY_MARGIN_MS_DEFAULT;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveDefaultMinExternalWorkMs(env = process.env) {
  return isMarketplaceSyncServerlessRuntime(env) ? 8000 : 2500;
}

/**
 * Estimativa para *decidir* se cabe mais um persist — não é o timeout real do pedido.
 * O timeout continua em ML_INITIAL_SALES_ORDER_PROCESS_TIMEOUT_MS (45s).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveOrderPersistWorkEstimateMs(env = process.env) {
  const raw = env?.MARKETPLACE_SYNC_ORDER_PERSIST_ESTIMATE_MS;
  if (raw != null && String(raw).trim() !== "") {
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n)) return Math.min(60000, Math.max(500, n));
  }
  return isMarketplaceSyncServerlessRuntime(env) ? 3000 : 2500;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePlatformMaxDurationMs(env = process.env) {
  return resolveClampedPlatformOverrideMs(env);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveShutdownMarginMs(env = process.env) {
  const raw = env?.MARKETPLACE_SYNC_SHUTDOWN_MARGIN_MS;
  if (raw != null && String(raw).trim() !== "") {
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n)) return Math.min(45000, Math.max(3000, n));
  }
  return 18000;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveMinExternalWorkMs(env = process.env) {
  const raw = env?.MARKETPLACE_SYNC_MIN_EXTERNAL_WORK_MS;
  if (raw != null && String(raw).trim() !== "") {
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n)) return Math.min(60000, Math.max(1000, n));
  }
  return Math.min(60000, Math.max(1000, resolveDefaultMinExternalWorkMs(env)));
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
    getRemainingHardMs: () => Math.max(0, hardDeadlineMs - nowFn()),
    isSoftExpired: () => nowFn() >= softDeadlineMs,
    isHardExpired: () => nowFn() >= hardDeadlineMs,
    shouldStopBeforeNextExternalWork: (estimatedMs = resolveMinExternalWorkMs()) => {
      const est = Math.max(0, Number(estimatedMs) || 0);
      const remainingSoft = softDeadlineMs - nowFn();
      const remainingHard = hardDeadlineMs - nowFn();
      if (remainingHard <= shutdownMarginMs) return true;
      if (remainingSoft <= 0) return true;
      return remainingSoft <= est;
    },
    shouldStopBeforePersist: (estimatedPersistMs, safetyMarginMs = resolvePersistSafetyMarginMs()) => {
      const est = Math.max(0, Number(estimatedPersistMs) || 0);
      const margin = Math.max(0, Number(safetyMarginMs) || 0);
      const remainingSoft = softDeadlineMs - nowFn();
      const remainingHard = hardDeadlineMs - nowFn();
      if (remainingHard <= shutdownMarginMs) return true;
      if (remainingSoft <= 0) return true;
      return remainingSoft <= est + margin;
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

/**
 * Modelo controlado de empacotamento de pedidos por wake.
 * Espelha `shouldStopBeforeNextExternalWork(persistEstimateMs)` + consumo `perOrderMs`.
 * Não substitui um ciclo E2E real.
 *
 * @param {{
 *   effectiveBudgetMs: number;
 *   firstSearchMs?: number;
 *   perOrderMs: number;
 *   persistEstimateMs: number;
 * }} opts
 */
export function estimateOrdersPackableInWake(opts) {
  const effectiveBudgetMs = Math.max(0, Number(opts.effectiveBudgetMs) || 0);
  const firstSearchMs = Math.max(0, Number(opts.firstSearchMs) || 0);
  const perOrderMs = Math.max(1, Number(opts.perOrderMs) || 1);
  const persistEstimateMs = Math.max(0, Number(opts.persistEstimateMs) || 0);
  let remaining = effectiveBudgetMs - firstSearchMs;
  let orders = 0;
  const safetyMarginMs = Math.max(0, Number(opts.safetyMarginMs) || 0);
  const stopAt = persistEstimateMs + safetyMarginMs;
  while (remaining > stopAt) {
    remaining -= perOrderMs;
    orders += 1;
    if (orders > 100000) break;
  }
  return {
    orders,
    leftover_ms: Math.max(0, remaining),
  };
}

/**
 * @param {number} volume
 * @param {number} ordersPerWake
 */
export function estimateWakesForVolume(volume, ordersPerWake) {
  const n = Math.max(0, Math.floor(Number(volume) || 0));
  const per = Math.max(1, Math.floor(Number(ordersPerWake) || 0));
  if (n === 0) return 0;
  return Math.ceil(n / per);
}
