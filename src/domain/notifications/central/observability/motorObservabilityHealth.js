// =============================================================================
// S7 — Observabilidade (S5.10) — saúde do motor (infra, puro)
// Sem alertas automáticos nesta fase.
// =============================================================================

import { S7_MOTOR_HEALTH_STATUS } from "./motorObservabilityContract.js";

/**
 * @param {{
 *   error_rate_percent?: number | null;
 *   events_published?: number;
 *   deliveries_failed?: number;
 * }} metrics
 */
export function evaluateMotorHealthFromMetrics(metrics = {}) {
  const errorRate = metrics.error_rate_percent;
  const failed = Number(metrics.deliveries_failed ?? 0);
  const published = Number(metrics.events_published ?? 0);

  if (errorRate != null && errorRate >= 25) {
    return {
      status: S7_MOTOR_HEALTH_STATUS.CRITICAL,
      reasons: ["error_rate_above_25"],
      alerts_enabled: false,
    };
  }
  if (errorRate != null && errorRate >= 10) {
    return {
      status: S7_MOTOR_HEALTH_STATUS.RISK,
      reasons: ["error_rate_above_10"],
      alerts_enabled: false,
    };
  }
  if (failed > 0 && published > 0 && failed / published >= 0.05) {
    return {
      status: S7_MOTOR_HEALTH_STATUS.WARNING,
      reasons: ["dispatch_failures_detected"],
      alerts_enabled: false,
    };
  }

  return {
    status: S7_MOTOR_HEALTH_STATUS.HEALTHY,
    reasons: [],
    alerts_enabled: false,
  };
}
