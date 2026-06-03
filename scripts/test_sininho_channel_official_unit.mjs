#!/usr/bin/env node
/**
 * S5.8 — Central Sininho Oficial — testes de unidade (sem rede).
 */

const {
  S7_SININHO_CHANNEL_CODE,
  S7_SININHO_OFFICIAL_PROVIDER,
  S7_SININHO_INBOX_TABLE,
  S7_SININHO_INBOX_API,
  getOfficialSininhoChannelSnapshot,
  evaluateOfficialSininhoTimeline,
  previewSininhoTemplate,
  buildSininhoDeliveryTraceSummary,
  S7_SININHO_TRACE_FIELDS,
  resolveSininhoReadState,
  resolveSininhoArchiveState,
  describeSininhoUiReuse,
} = await import("../src/domain/notifications/central/sininho/index.js");

const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

assert("channel code in_app", S7_SININHO_CHANNEL_CODE === "in_app");
assert("provider s7_in_app", S7_SININHO_OFFICIAL_PROVIDER === "s7_in_app");
assert("inbox table dispatches", S7_SININHO_INBOX_TABLE === "s7_notification_dispatches");

const snap = getOfficialSininhoChannelSnapshot();
assert("snapshot display name", snap.display_name === "Central Sininho");
assert("snapshot registry ativo", snap.channel_registry?.available === true);
assert("snapshot provider registered", snap.dispatcher_integration?.provider_registered === true);
assert("snapshot provider class", snap.dispatcher_integration?.provider_class === "InAppNotificationProvider");
assert("snapshot list API", snap.seller_api?.LIST === S7_SININHO_INBOX_API.LIST);
assert("snapshot archive prepared", snap.history?.archive_prepared === true);
assert("snapshot archive not implemented", snap.history?.archive_implemented === false);
assert("snapshot templates preview", snap.templates_integration?.preview_sininho === "previewSininhoTemplate");

const timeline = evaluateOfficialSininhoTimeline({
  id: "disp-1",
  event_id: "evt-1",
  is_read: false,
  title: "Teste",
  severity: "warning",
});
assert("timeline unread", timeline.read_state === "unread");
assert("timeline severity", timeline.severity === "warning");

const read = resolveSininhoReadState({ is_read: true, read_at: new Date().toISOString() });
assert("read state read", read === "read");

const archived = resolveSininhoArchiveState({ archived_at: new Date().toISOString() });
assert("archive state archived", archived === "archived");

const preview = previewSininhoTemplate({
  subject_template: "Olá {{seller_name}}",
  body_template: "Corpo",
  severity: "info",
});
assert("preview channel", preview.channel === "in_app");
assert("preview surfaces", preview.preview_surfaces?.includes("sininho_dropdown"));

const trace = buildSininhoDeliveryTraceSummary({ dispatch_id: "d1", event_id: "e1" });
assert("trace audit table", trace.audit_table === S7_SININHO_INBOX_TABLE);
assert("trace fields", S7_SININHO_TRACE_FIELDS.EVENT_ID === "event_id");

const reuse = describeSininhoUiReuse();
assert("reuse sininho component", Boolean(reuse.sininho_dropdown?.component));

if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`, failures);
  process.exit(1);
}
console.log(`✅ S5.8 Central Sininho Oficial — ${passed} asserts OK.`);
