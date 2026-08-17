// =============================================================================
// Status da outbox de e-mail
// =============================================================================

/** @type {const} */
export const S7_EMAIL_OUTBOX_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  SENT: "sent",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const S7_EMAIL_MAX_ATTEMPTS = 5;
