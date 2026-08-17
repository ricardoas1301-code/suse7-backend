// ======================================================================

// Logs de ciclo de vida do executive-summary (P_2.1.4 hotfix 05).

// ======================================================================



/**

 * @param {Record<string, unknown>} payload

 */

export function logExecutiveSummaryStart(payload) {

  console.info("[S7_EXEC_SUMMARY_START]", payload);

}



/**

 * @param {Record<string, unknown>} payload

 */

export function logExecutiveSummarySourceReady(payload) {

  console.info("[S7_EXEC_SUMMARY_SOURCE_READY]", payload);

}



/**

 * @param {Record<string, unknown>} payload

 */

export function logExecutiveSummaryBuildReady(payload) {

  console.info("[S7_EXEC_SUMMARY_BUILD_READY]", payload);

}



/**

 * @param {Record<string, unknown>} payload

 */

export function logExecutiveSummaryResponseSent(payload) {

  console.info("[S7_EXEC_SUMMARY_RESPONSE_SENT]", payload);

}



/**

 * @param {Record<string, unknown>} payload

 */

export function logExecutiveSummaryError(payload) {

  console.error("[S7_EXEC_SUMMARY_ERROR]", payload);

}



/**

 * @param {number | undefined} startedAt

 */

export function executiveSummaryElapsedMs(startedAt) {

  if (startedAt == null || !Number.isFinite(startedAt)) return null;

  return Math.max(0, Date.now() - startedAt);

}


