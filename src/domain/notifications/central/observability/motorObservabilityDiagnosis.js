// =============================================================================
// S7 — Observabilidade (S5.10) — diagnóstico e correlação (infra)
// =============================================================================

import { S7_MOTOR_OBS_TABLES } from "./motorObservabilityContract.js";

/**
 * @param {{
 *   event_id?: string | null;
 *   dispatch_id?: string | null;
 *   seller_id?: string | null;
 *   correlation_id?: string | null;
 * }} input
 */
export function buildMotorDiagnosisCorrelation(input = {}) {
  return {
    event_id: input.event_id ?? null,
    dispatch_id: input.dispatch_id ?? null,
    seller_id: input.seller_id ?? null,
    correlation_id: input.correlation_id ?? null,
    tables: {
      primary: S7_MOTOR_OBS_TABLES.EVENTS,
      joins: [
        { from: S7_MOTOR_OBS_TABLES.EVENTS, to: S7_MOTOR_OBS_TABLES.DISPATCHES, on: "event_id" },
        {
          from: S7_MOTOR_OBS_TABLES.DISPATCHES,
          to: S7_MOTOR_OBS_TABLES.DELIVERY_LOGS,
          on: "dispatch_id",
        },
        {
          from: S7_MOTOR_OBS_TABLES.DISPATCHES,
          to: S7_MOTOR_OBS_TABLES.EMAIL_OUTBOX,
          on: "dispatch_id",
          optional: true,
        },
        {
          from: S7_MOTOR_OBS_TABLES.DISPATCHES,
          to: S7_MOTOR_OBS_TABLES.WHATSAPP_OUTBOX,
          on: "dispatch_id",
          optional: true,
        },
      ],
    },
    troubleshooting: {
      apis: [
        "/api/notifications/events",
        "/api/notifications/deliveries",
        "/api/notifications/events/:id (detail)",
      ],
      log_prefixes: "S7_MOTOR_OBS_LOG_PREFIX_REGISTRY",
      timeline_builder: "buildMotorCommunicationTimeline",
    },
    audit_operational: true,
  };
}
