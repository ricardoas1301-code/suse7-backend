// ======================================================================
// Sinais operacionais do GET sync-status — somente leitura (sem side effects).
// ======================================================================

/** @param {number | string | undefined} raw @param {number} fallback */
export function resolveSyncStatusThresholdMs(raw, fallback) {
  const parsed = parseInt(String(raw ?? ""), 10);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(24 * 60 * 60 * 1000, Math.max(30 * 1000, base));
}

/**
 * @param {{
 *   runningRows: Record<string, unknown>[];
 *   pendingRows: Record<string, unknown>[];
 *   nowMs?: number;
 *   staleProgressMs?: number;
 *   pendingQueueWarningMs?: number;
 * }} input
 */
export function computeSyncStatusOperationalSignals(input) {
  const nowMs = input.nowMs ?? Date.now();
  const staleProgressMs = input.staleProgressMs ?? resolveSyncStatusThresholdMs(process.env.ML_SYNC_STATUS_STALE_MS, 90_000);
  const pendingQueueWarningMs =
    input.pendingQueueWarningMs ??
    resolveSyncStatusThresholdMs(process.env.ML_SYNC_PENDING_QUEUE_WARNING_MS, 120_000);

  const runningRows = input.runningRows ?? [];
  const pendingRows = input.pendingRows ?? [];

  const latestRunningTs = runningRows
    .map((r) => Date.parse(String(r.updated_at ?? r.created_at ?? "")))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)[0];

  const staleRunning =
    runningRows.length > 0 && Number.isFinite(latestRunningTs) && nowMs - Number(latestRunningTs) > staleProgressMs;

  const oldestPendingTs = pendingRows
    .map((r) => Date.parse(String(r.updated_at ?? r.created_at ?? "")))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)[0];

  const queuedTooLong =
    pendingRows.length > 0 && Number.isFinite(oldestPendingTs) && nowMs - Number(oldestPendingTs) > pendingQueueWarningMs;

  return {
    staleRunning,
    queuedTooLong,
    staleProgressMs,
    pendingQueueWarningMs,
    pendingCount: pendingRows.length,
    runningCount: runningRows.length,
  };
}

/**
 * @param {{
 *   hasEngagedInitialSync: boolean;
 *   typedStatuses: string[];
 *   hasPartialWarnings: boolean;
 * }} input
 */
export function resolveSyncStatusOverall(input) {
  const typedStatuses = input.typedStatuses ?? [];
  const anyError = typedStatuses.some((s) => s === "error");
  const allDone = typedStatuses.length > 0 && typedStatuses.every((s) => s === "done");

  if (!input.hasEngagedInitialSync) return "awaiting_start";
  if (typedStatuses.length === 0) return "no_jobs";
  if (anyError) return "error";
  if (allDone && input.hasPartialWarnings) return "completed_with_errors";
  if (allDone) return "done";
  return "running";
}
