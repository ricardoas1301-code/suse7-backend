// ======================================================================
// Telemetria de performance — executive-summary (P_2.1.4 hotfix 01)
// ======================================================================

/**
 * @param {number | undefined} startedAt
 */
export function executivePerfElapsedMs(startedAt) {
  if (startedAt == null || !Number.isFinite(startedAt)) return null;
  return Math.max(0, Date.now() - startedAt);
}

/**
 * @param {string} step
 * @param {Record<string, unknown>} [payload]
 */
export function logExecutiveSummaryPerf(step, payload = {}) {
  console.info("[S7_EXECUTIVE_SUMMARY_PERF]", {
    step,
    ...payload,
  });
}

/**
 * @param {number} requestStartedAt
 */
export function createExecutiveSummaryPerf(requestStartedAt = Date.now()) {
  /** @type {Record<string, number>} */
  const marks = { request_start: requestStartedAt };

  return {
    requestStartedAt,
    marks,
    /**
     * @param {string} startStep
     * @param {string} endStep
     */
    stepDurationMs(startStep, endStep) {
      const start = marks[startStep];
      const end = marks[endStep];
      if (start == null || end == null) return null;
      return Math.max(0, end - start);
    },
    /**
     * @param {string} step
     */
    mark(step) {
      marks[step] = Date.now();
    },
    /**
     * @param {string} step
     * @param {Record<string, unknown>} [extra]
     */
    log(step, extra = {}) {
      const at = marks[step] ?? Date.now();
      logExecutiveSummaryPerf(step, {
        ...extra,
        elapsed_since_request_ms: executivePerfElapsedMs(requestStartedAt),
        step_at_ms: at,
      });
    },
    /**
     * @param {Record<string, unknown>} [extra]
     */
    logResponseReady(extra = {}) {
      logExecutiveSummaryPerf("response_ready", {
        ...extra,
        total_duration_ms: executivePerfElapsedMs(requestStartedAt),
      });
    },
  };
}
