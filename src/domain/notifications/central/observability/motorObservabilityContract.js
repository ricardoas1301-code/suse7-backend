// =============================================================================
// S7 — Observabilidade do Motor Central (Fase S5.10)
// Contrato oficial — reutiliza logs e tabelas existentes (sem segundo sistema).
// =============================================================================

/** Estágios da timeline oficial (jornada evento → entrega). */
export const S7_MOTOR_OBS_TIMELINE_STAGE = Object.freeze({
  EVENT: "event",
  DISPATCHER: "dispatcher",
  PREFERENCES: "preferences",
  CHANNEL: "channel",
  TEMPLATE: "template",
  RECIPIENT: "recipient",
  DISPATCH: "dispatch",
  DELIVERY: "delivery",
  OUTBOX: "outbox",
});

/** Eventos semânticos do contrato (mapeiam sufixos de log legados). */
export const S7_MOTOR_OBS_EVENT = Object.freeze({
  EVENT_CREATED: "event_created",
  EVENT_DEDUPLICATED: "event_deduplicated",
  EVENT_DISCARDED: "event_discarded",
  DISPATCH_CREATED: "dispatch_created",
  DISPATCH_EXECUTED: "dispatch_executed",
  DISPATCH_FAILED: "dispatch_failed",
  CHANNEL_SELECTED: "channel_selected",
  CHANNEL_IGNORED: "channel_ignored",
  TEMPLATE_RESOLVED: "template_resolved",
  RECIPIENT_RESOLVED: "recipient_resolved",
  DELIVERY_STARTED: "delivery_started",
  DELIVERY_COMPLETED: "delivery_completed",
  DELIVERY_FAILED: "delivery_failed",
});

/** Tabelas fonte de verdade (backend). */
export const S7_MOTOR_OBS_TABLES = Object.freeze({
  EVENTS: "s7_notification_events",
  DISPATCHES: "s7_notification_dispatches",
  DELIVERY_LOGS: "s7_notification_delivery_logs",
  EMAIL_OUTBOX: "s7_notification_email_outbox",
  WHATSAPP_OUTBOX: "s7_notification_whatsapp_outbox",
  POPUP_DELIVERIES: "s7_notification_popup_deliveries",
});

/** Workers internos documentados. */
export const S7_MOTOR_OBS_WORKERS = Object.freeze({
  EMAIL: "/api/internal/notifications/email/process",
  WHATSAPP: "/api/internal/notifications/whatsapp/process",
});

/** Saúde do motor (sem alertas nesta fase). */
export const S7_MOTOR_HEALTH_STATUS = Object.freeze({
  HEALTHY: "healthy",
  WARNING: "warning",
  RISK: "risk",
  CRITICAL: "critical",
});

/** Log canônico do núcleo — não substitui prefixos por canal. */
export const S7_MOTOR_OBS_CORE_LOG_PREFIX = "[S7_NOTIFICATION]";
