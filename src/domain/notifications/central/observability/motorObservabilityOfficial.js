// =============================================================================
// S7 — Observabilidade Oficial do Motor Central (Fase S5.10)
// Fonte única de metadados — NÃO cria segundo sistema de logs.
// =============================================================================

import {
  S7_MOTOR_HEALTH_STATUS,
  S7_MOTOR_OBS_CORE_LOG_PREFIX,
  S7_MOTOR_OBS_EVENT,
  S7_MOTOR_OBS_TABLES,
  S7_MOTOR_OBS_TIMELINE_STAGE,
  S7_MOTOR_OBS_WORKERS,
} from "./motorObservabilityContract.js";
import {
  S7_MOTOR_OBS_LOG_PREFIX_REGISTRY,
  S7_MOTOR_OBS_LOG_SUFFIX_MAP,
} from "./motorObservabilityLogRegistry.js";
import { buildMotorDiagnosisCorrelation } from "./motorObservabilityDiagnosis.js";
import { evaluateMotorHealthFromMetrics } from "./motorObservabilityHealth.js";
import { planMotorOperationalMetrics } from "./motorObservabilityMetrics.js";
import { buildMotorCommunicationTimeline } from "./motorObservabilityTimeline.js";
import { describeCommunicationDispatcherPipeline } from "../preferences/communicationDispatcherBridge.js";

/**
 * Snapshot oficial de observabilidade (sem secrets).
 */
export function getOfficialMotorObservabilitySnapshot() {
  return {
    phase: "S5.10",
    parallel_log_system: false,
    single_source_of_truth: true,
    core_log: {
      function: "logCentralNotification",
      prefix: S7_MOTOR_OBS_CORE_LOG_PREFIX,
      note: "Hub canônico — contrato, dispatcher, pipeline, prefs, recipients",
    },
    channel_logs: {
      email: { prefix: "[S7_EMAIL]", function: "logEmailNotification" },
      whatsapp: { prefix: "[S7_WHATSAPP]", function: "logWhatsAppNotification" },
      in_app_legacy: { prefix: "[S7_IN_APP]", function: "logInAppNotification" },
      sininho: { prefix: "[S7_SININHO]", function: "logSininhoNotification" },
      popup: { prefix: "[S7_POPUP]", function: "logPopupNotification" },
      preferences: { prefix: "[S7_COMMS_PREF]", function: "logCommunicationPreferences" },
      actions: { prefix: "[S7_ACTIONS]", function: "logNotificationActions" },
    },
    log_prefix_registry: S7_MOTOR_OBS_LOG_PREFIX_REGISTRY,
    semantic_events: Object.values(S7_MOTOR_OBS_EVENT),
    legacy_suffix_map: S7_MOTOR_OBS_LOG_SUFFIX_MAP,
    persistence: {
      tables: S7_MOTOR_OBS_TABLES,
      delivery_logs_primary: S7_MOTOR_OBS_TABLES.DELIVERY_LOGS,
      dispatches_primary: S7_MOTOR_OBS_TABLES.DISPATCHES,
      events_primary: S7_MOTOR_OBS_TABLES.EVENTS,
    },
    outboxes: {
      email: S7_MOTOR_OBS_TABLES.EMAIL_OUTBOX,
      whatsapp: S7_MOTOR_OBS_TABLES.WHATSAPP_OUTBOX,
    },
    workers: S7_MOTOR_OBS_WORKERS,
    timeline: {
      builder: "buildMotorCommunicationTimeline",
      stages: Object.values(S7_MOTOR_OBS_TIMELINE_STAGE),
      journey: "event → dispatcher → canal → destinatário → entrega",
    },
    metrics: {
      planner: "planMotorOperationalMetrics",
      from_summary: "planMotorMetricsFromEngineSummary",
      legacy_summary: "getCentralNotificationEngineSummary",
      indicators: [
        "events_published",
        "dispatches_executed",
        "deliveries_completed",
        "deliveries_failed",
        "success_rate_percent",
        "error_rate_percent",
      ],
      dashboard_phase: "futuro",
    },
    health: {
      statuses: Object.values(S7_MOTOR_HEALTH_STATUS),
      evaluator: "evaluateMotorHealthFromMetrics",
      automatic_alerts: false,
    },
    diagnosis: {
      builder: "buildMotorDiagnosisCorrelation",
      correlation_fields: ["event_id", "dispatch_id", "seller_id", "correlation_id"],
    },
    dispatcher_pipeline: describeCommunicationDispatcherPipeline(),
    duplication_notes: {
      preferences:
        "PREFERENCES_RESOLVED em logCentralNotification e logNotificationActions — mesmo evento, camadas diferentes",
      recipients:
        "RECIPIENTS_RESOLVED em logCentralNotification e logNotificationActions — preservado",
      recommendation: "S5.10 formaliza mapa; consolidação física de logs em fase futura opcional",
    },
    seller_ux: {
      altered: false,
      inbox_separate: true,
    },
    future_compat: {
      new_channels: "novos prefixos no registry + delivery_logs",
      new_providers: "provider_key em delivery_logs",
      new_marketplaces: "event.marketplace + recipient marketplace_account_id",
    },
  };
}

/**
 * @param {Parameters<typeof planMotorOperationalMetrics>[0]} metricsInput
 */
export function evaluateOfficialMotorHealth(metricsInput) {
  const metrics = planMotorOperationalMetrics(metricsInput);
  return {
    metrics,
    health: evaluateMotorHealthFromMetrics(metrics),
  };
}

/**
 * @param {Parameters<typeof buildMotorCommunicationTimeline>[0]} timelineInput
 */
export function evaluateOfficialMotorTimeline(timelineInput) {
  return buildMotorCommunicationTimeline(timelineInput);
}
