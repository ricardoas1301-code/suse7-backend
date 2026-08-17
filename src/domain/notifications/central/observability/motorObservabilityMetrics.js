// =============================================================================
// S7 — Observabilidade (S5.10) — métricas operacionais (infra, puro)
// Sem dashboard executivo nesta fase.
// =============================================================================

/**
 * @param {{
 *   events_published?: number;
 *   dispatches_executed?: number;
 *   deliveries_completed?: number;
 *   deliveries_failed?: number;
 *   window_hours?: number;
 * }} input
 */
export function planMotorOperationalMetrics(input = {}) {
  const eventsPublished = Math.max(0, Number(input.events_published) || 0);
  const dispatchesExecuted = Math.max(0, Number(input.dispatches_executed) || 0);
  const deliveriesCompleted = Math.max(0, Number(input.deliveries_completed) || 0);
  const deliveriesFailed = Math.max(0, Number(input.deliveries_failed) || 0);
  const deliveryAttempts = deliveriesCompleted + deliveriesFailed;

  const successRate =
    deliveryAttempts > 0 ? Math.round((deliveriesCompleted / deliveryAttempts) * 10000) / 100 : null;
  const errorRate =
    deliveryAttempts > 0 ? Math.round((deliveriesFailed / deliveryAttempts) * 10000) / 100 : null;

  return {
    window_hours: input.window_hours ?? 24,
    events_published: eventsPublished,
    dispatches_executed: dispatchesExecuted,
    deliveries_completed: deliveriesCompleted,
    deliveries_failed: deliveriesFailed,
    success_rate_percent: successRate,
    error_rate_percent: errorRate,
    dashboard_ready: false,
    source: "s7_notification_events + s7_notification_dispatches + s7_notification_delivery_logs",
  };
}

/**
 * Enriquece resumo legado Phase 3.1 com métricas S5.10.
 * @param {Awaited<ReturnType<import("../analytics/notificationEngineAnalytics.js").getCentralNotificationEngineSummary>>} summary
 */
export function planMotorMetricsFromEngineSummary(summary) {
  const byStatus = summary?.dispatches_by_status ?? {};
  const sent = Number(byStatus.SENT ?? 0) + Number(byStatus.sent ?? 0);
  const failed = Number(byStatus.FAILED ?? 0) + Number(byStatus.failed ?? 0);
  const total = Number(summary?.dispatches_total ?? 0);

  return planMotorOperationalMetrics({
    events_published: Number(summary?.events_count ?? 0),
    dispatches_executed: total,
    deliveries_completed: sent,
    deliveries_failed: failed,
    window_hours: summary?.window_hours ?? 24,
  });
}
