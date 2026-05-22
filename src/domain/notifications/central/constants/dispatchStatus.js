// =============================================================================
// Status de dispatch — motor central
// =============================================================================

/** @type {const} */
export const S7_NOTIFICATION_DISPATCH_STATUS = Object.freeze({
  PENDING: "PENDING",
  QUEUED: "QUEUED",
  SENT: "SENT",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
});
