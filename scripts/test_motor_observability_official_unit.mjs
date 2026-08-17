#!/usr/bin/env node
/**
 * S5.10 — Observabilidade do Motor Central — testes de unidade (sem rede).
 */

const {
  S7_MOTOR_OBS_EVENT,
  S7_MOTOR_OBS_TABLES,
  S7_MOTOR_HEALTH_STATUS,
  getOfficialMotorObservabilitySnapshot,
  evaluateOfficialMotorHealth,
  evaluateOfficialMotorTimeline,
  buildMotorDiagnosisCorrelation,
  mapLegacyLogSuffixToObservabilityEvent,
  planMotorOperationalMetrics,
  S7_MOTOR_OBS_LOG_PREFIX_REGISTRY,
} = await import("../src/domain/notifications/central/observability/index.js");

const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

assert("delivery logs table", S7_MOTOR_OBS_TABLES.DELIVERY_LOGS === "s7_notification_delivery_logs");
assert("events table", S7_MOTOR_OBS_TABLES.EVENTS === "s7_notification_events");

const snap = getOfficialMotorObservabilitySnapshot();
assert("snapshot S5.10", snap.phase === "S5.10");
assert("no parallel log system", snap.parallel_log_system === false);
assert("semantic events count", snap.semantic_events?.length >= 12);
assert("timeline builder", snap.timeline?.builder === "buildMotorCommunicationTimeline");
assert("delivery logs primary", snap.persistence?.delivery_logs_primary === S7_MOTOR_OBS_TABLES.DELIVERY_LOGS);
assert("workers email", snap.workers?.EMAIL?.includes("email/process"));
assert("seller ux preserved", snap.seller_ux?.altered === false);

const mapped = mapLegacyLogSuffixToObservabilityEvent("EVENT_PUBLISHED");
assert("map EVENT_PUBLISHED", mapped === S7_MOTOR_OBS_EVENT.EVENT_CREATED);

const mappedDedupe = mapLegacyLogSuffixToObservabilityEvent("EVENT_DEDUPE_WINDOW_HIT");
assert("map dedupe", mappedDedupe === S7_MOTOR_OBS_EVENT.EVENT_DEDUPLICATED);

const timeline = evaluateOfficialMotorTimeline({
  event: { id: "e1", seller_id: "s1", category_code: "BILLING", type_key: "FAILED", created_at: "2026-01-01T00:00:00Z" },
  dispatches: [{ id: "d1", channel: "email", status: "SENT", created_at: "2026-01-01T00:00:01Z" }],
  delivery_logs: [{ dispatch_id: "d1", status: "sent", created_at: "2026-01-01T00:00:02Z" }],
  dispatcher_summary: { final_result: "success" },
});
assert("timeline event_id", timeline.event_id === "e1");
assert("timeline stages", timeline.stages?.length >= 3);
assert("timeline dispatch count", timeline.dispatch_count === 1);

const metrics = planMotorOperationalMetrics({
  events_published: 100,
  dispatches_executed: 80,
  deliveries_completed: 70,
  deliveries_failed: 10,
});
assert("success rate", metrics.success_rate_percent === 87.5);

const health = evaluateOfficialMotorHealth({
  events_published: 100,
  deliveries_completed: 90,
  deliveries_failed: 2,
});
assert("health healthy", health.health?.status === S7_MOTOR_HEALTH_STATUS.HEALTHY);

const critical = evaluateOfficialMotorHealth({
  events_published: 10,
  deliveries_completed: 5,
  deliveries_failed: 5,
});
assert("health critical high error", critical.health?.status === S7_MOTOR_HEALTH_STATUS.CRITICAL);

const diag = buildMotorDiagnosisCorrelation({ event_id: "e1", dispatch_id: "d1" });
assert("diagnosis joins", diag.tables?.joins?.length >= 2);

assert("registry has S7_NOTIFICATION", Boolean(S7_MOTOR_OBS_LOG_PREFIX_REGISTRY["[S7_NOTIFICATION]"]));

if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`, failures);
  process.exit(1);
}
console.log(`✅ S5.10 Observabilidade do Motor Central — ${passed} asserts OK.`);
