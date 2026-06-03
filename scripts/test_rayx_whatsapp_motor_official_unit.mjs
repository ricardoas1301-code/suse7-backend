#!/usr/bin/env node
/**
 * S5.12 — Raio-X WhatsApp no Motor Central — testes de unidade (sem rede).
 */

const {
  S7_RAYX_WHATSAPP_MOTOR_PHASE,
  S7_RAYX_WHATSAPP_MOTOR_API_PATH,
  S7_RAYX_WHATSAPP_MOTOR_FLOW,
  getOfficialRayxWhatsAppMotorSnapshot,
  evaluateOfficialRayxWhatsAppMotorIntegration,
  describeRayxWhatsAppMotorRedundancyCandidates,
  buildRayxWhatsAppMotorTimeline,
  dedupeOfficialWhatsAppRecipients,
} = await import("../src/domain/notifications/central/index.js");

const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

assert("phase S5.12", S7_RAYX_WHATSAPP_MOTOR_PHASE === "S5.12");
assert("api path sale-rayx", S7_RAYX_WHATSAPP_MOTOR_API_PATH === "/api/notifications/manual/sale-rayx");
assert("flow type MANUAL_SALE_RAYX", S7_RAYX_WHATSAPP_MOTOR_FLOW.TYPE_KEY === "MANUAL_SALE_RAYX");
assert("source module modal", S7_RAYX_WHATSAPP_MOTOR_FLOW.SOURCE_MODULE === "sale_rayx_modal");

const snap = getOfficialRayxWhatsAppMotorSnapshot();
assert("single motor source", snap.motor_central_single_source === true);
assert("no parallel motor", snap.parallel_motor === false);
assert("ux unchanged flag", snap.seller_ux_unchanged === true);
assert("pipeline includes dispatcher", snap.pipeline_stages.includes("central_dispatcher"));
assert("pipeline includes zapi", snap.pipeline_stages.includes("zapi_provider"));
assert("multi recipient preserved", snap.preserved_capabilities?.multi_recipient === true);
assert("dedupe preserved", snap.preserved_capabilities?.deduplication === true);
assert("obs S5.10 integrated", snap.observability?.integrated_phase === "S5.10");

const evalSnap = evaluateOfficialRayxWhatsAppMotorIntegration();
assert("integration evaluate ok", evalSnap.ok === true);

const redundancy = describeRayxWhatsAppMotorRedundancyCandidates();
assert("redundancy list non-empty", Array.isArray(redundancy) && redundancy.length >= 2);

const timeline = buildRayxWhatsAppMotorTimeline({
  event_id: "evt-rayx",
  dispatch_id: "disp-rayx",
  seller_id: "seller-1",
  status: "sent",
  real_send_executed: true,
  channel: "whatsapp",
});
assert("timeline event_id", timeline.event_id === "evt-rayx");
assert("timeline stages", Array.isArray(timeline.stages) && timeline.stages.length >= 2);

const deduped = dedupeOfficialWhatsAppRecipients(
  [{ recipientPhone: "11999990001" }, { recipientPhone: "5511999990001" }],
  { channel: "whatsapp", saleId: "sale-1" }
);
assert("dedupe via motor export", deduped.final_recipient_targets.length === 1);

if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`, failures);
  process.exit(1);
}
console.log(`✅ S5.12 Raio-X WhatsApp Motor Central — ${passed} asserts OK.`);
