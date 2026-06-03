// =============================================================================
// Status de dispatch — motor central
// Fase S5.2 (Dispatcher Central): vocabulário estendido de status por canal.
// Os valores legados (PENDING/QUEUED/SENT/FAILED/SKIPPED) são preservados;
// PROCESSING/DEDUPED/RETRY_SCHEDULED são adicionados (superset).
// =============================================================================

/** @type {const} */
export const S7_NOTIFICATION_DISPATCH_STATUS = Object.freeze({
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  QUEUED: "QUEUED",
  SENT: "SENT",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
  DEDUPED: "DEDUPED",
  RETRY_SCHEDULED: "RETRY_SCHEDULED",
});

/**
 * Status terminais (não evoluem mais sozinhos).
 * @type {ReadonlySet<string>}
 */
export const S7_DISPATCH_TERMINAL_STATUS = new Set([
  S7_NOTIFICATION_DISPATCH_STATUS.SENT,
  S7_NOTIFICATION_DISPATCH_STATUS.FAILED,
  S7_NOTIFICATION_DISPATCH_STATUS.SKIPPED,
  S7_NOTIFICATION_DISPATCH_STATUS.DEDUPED,
]);

/**
 * Status em andamento (ainda podem mudar).
 * @type {ReadonlySet<string>}
 */
export const S7_DISPATCH_IN_FLIGHT_STATUS = new Set([
  S7_NOTIFICATION_DISPATCH_STATUS.PENDING,
  S7_NOTIFICATION_DISPATCH_STATUS.PROCESSING,
  S7_NOTIFICATION_DISPATCH_STATUS.QUEUED,
  S7_NOTIFICATION_DISPATCH_STATUS.RETRY_SCHEDULED,
]);

/** @param {string} status */
export function isTerminalDispatchStatus(status) {
  return S7_DISPATCH_TERMINAL_STATUS.has(String(status ?? "").trim().toUpperCase());
}

/** @param {string} status */
export function isValidDispatchStatus(status) {
  return Object.prototype.hasOwnProperty.call(
    S7_NOTIFICATION_DISPATCH_STATUS,
    String(status ?? "").trim().toUpperCase()
  );
}
