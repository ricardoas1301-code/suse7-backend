// =============================================================================
// S7 — Observabilidade do Motor Central — superfície pública
// =============================================================================

export { logCentralNotification } from "./centralNotificationLog.js";

export {
  S7_MOTOR_OBS_TIMELINE_STAGE,
  S7_MOTOR_OBS_EVENT,
  S7_MOTOR_OBS_TABLES,
  S7_MOTOR_OBS_WORKERS,
  S7_MOTOR_HEALTH_STATUS,
  S7_MOTOR_OBS_CORE_LOG_PREFIX,
} from "./motorObservabilityContract.js";

export {
  S7_MOTOR_OBS_LOG_PREFIX_REGISTRY,
  S7_MOTOR_OBS_LOG_SUFFIX_MAP,
  mapLegacyLogSuffixToObservabilityEvent,
} from "./motorObservabilityLogRegistry.js";

export { buildMotorCommunicationTimeline } from "./motorObservabilityTimeline.js";
export {
  planMotorOperationalMetrics,
  planMotorMetricsFromEngineSummary,
} from "./motorObservabilityMetrics.js";
export { evaluateMotorHealthFromMetrics } from "./motorObservabilityHealth.js";
export { buildMotorDiagnosisCorrelation } from "./motorObservabilityDiagnosis.js";
export { logMotorObservability } from "./motorObservabilityLog.js";

export {
  getOfficialMotorObservabilitySnapshot,
  evaluateOfficialMotorHealth,
  evaluateOfficialMotorTimeline,
} from "./motorObservabilityOfficial.js";
