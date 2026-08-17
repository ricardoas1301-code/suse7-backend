// =============================================================================
// Status da outbox WhatsApp — Fase 3.5A
// =============================================================================

export const S7_WHATSAPP_OUTBOX_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  SENT: "sent",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const S7_WHATSAPP_MAX_ATTEMPTS = 5;
