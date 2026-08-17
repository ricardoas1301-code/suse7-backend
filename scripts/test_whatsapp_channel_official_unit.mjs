#!/usr/bin/env node
/**
 * S5.6 — Canal WhatsApp Oficial — testes de unidade (sem rede).
 */

const {
  S7_WHATSAPP_OFFICIAL_PROVIDER_DEFAULT,
  S7_WHATSAPP_MANUAL_RAYX_API_PATH,
  getOfficialWhatsAppChannelSnapshot,
  evaluateOfficialWhatsAppPolicy,
  describeWhatsAppMultiRecipientPolicy,
  dedupeOfficialWhatsAppRecipients,
  normalizeBrazilWhatsAppPhone,
  buildWhatsAppDeliveryTraceSummary,
  S7_WHATSAPP_TRACE_FIELDS,
} = await import("../src/domain/notifications/central/whatsapp/index.js");

const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

assert("provider default zapi", S7_WHATSAPP_OFFICIAL_PROVIDER_DEFAULT === "zapi");
assert("rayx api path", S7_WHATSAPP_MANUAL_RAYX_API_PATH === "/api/notifications/manual/sale-rayx");

const snap = getOfficialWhatsAppChannelSnapshot();
assert("snapshot canal whatsapp", snap.channel_code === "whatsapp");
assert("snapshot registry async", snap.channel_registry?.delivery_mode === "async");
assert("snapshot zapi homologado", snap.manual_sale_rayx?.provider_homologated === "zapi");
assert("snapshot raio-x preservado", snap.manual_sale_rayx?.preserved === true);
assert("snapshot outbox worker", snap.outbox_worker_path === "/api/internal/notifications/whatsapp/process");
assert("snapshot multi-provider registry", snap.multi_provider?.registry_order?.includes("zapi"));
assert("snapshot dispatcher tables", snap.dispatcher_integration?.queue_table === "s7_notification_whatsapp_outbox");

const policy = describeWhatsAppMultiRecipientPolicy();
assert("multi: single+multiple", policy.supports_single && policy.supports_multiple);

const deduped = dedupeOfficialWhatsAppRecipients(
  [
    { recipientPhone: "(11) 99999-0001" },
    { recipientPhone: "11999990001" },
    { recipientPhone: "invalid" },
  ],
  { channel: "whatsapp" }
);
assert("dedupe: 1 telefone valido", deduped.final_recipient_targets.length === 1);
assert("normalize BR", normalizeBrazilWhatsAppPhone("11999990001").startsWith("55"));

const trace = buildWhatsAppDeliveryTraceSummary({
  event_id: "evt-1",
  dispatch_id: "disp-1",
  status: "sent",
  provider: "zapi",
});
assert("trace: event_id", trace.event_id === "evt-1");
assert("trace: audit tables", trace.audit_tables?.outbox === "s7_notification_whatsapp_outbox");
assert("trace fields constant", S7_WHATSAPP_TRACE_FIELDS.DISPATCH_ID === "dispatch_id");

assert("policy: estrutura", typeof evaluateOfficialWhatsAppPolicy("5511999999999").allowed === "boolean");

if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`, failures);
  process.exit(1);
}
console.log(`✅ S5.6 Canal WhatsApp Oficial — ${passed} asserts OK.`);
