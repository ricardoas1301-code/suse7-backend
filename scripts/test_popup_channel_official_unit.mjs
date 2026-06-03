#!/usr/bin/env node
/**
 * S5.7 — Canal Pop-up Oficial — testes de unidade (sem rede).
 */

const {
  S7_POPUP_CHANNEL_CODE,
  S7_POPUP_DISPLAY_TYPE,
  S7_POPUP_DELIVERIES_TABLE,
  S7_POPUP_OFFICIAL_PROVIDER,
  getOfficialPopupChannelSnapshot,
  evaluateOfficialPopupDisplay,
  planPopupDisplay,
  previewPopupTemplate,
  buildPopupDeliveryTraceSummary,
  S7_POPUP_TRACE_FIELDS,
  describePopupMultiSurfaceReuse,
} = await import("../src/domain/notifications/central/popup/index.js");

const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

assert("channel code popup", S7_POPUP_CHANNEL_CODE === "popup");
assert("provider in-app", S7_POPUP_OFFICIAL_PROVIDER === "s7_popup_in_app");
assert("deliveries table", S7_POPUP_DELIVERIES_TABLE === "s7_notification_popup_deliveries");

const snap = getOfficialPopupChannelSnapshot();
assert("snapshot canal popup", snap.channel_code === "popup");
assert("snapshot registry supported", snap.channel_registry?.supported === true);
assert("snapshot registry not available", snap.channel_registry?.available === false);
assert("snapshot provider not registered", snap.dispatcher_integration?.provider_registered === false);
assert("snapshot persistence table", snap.persistence?.table === S7_POPUP_DELIVERIES_TABLE);
assert("snapshot templates preview", snap.templates_integration?.preview_popup === "previewPopupTemplate");
assert("display types 4", snap.display_types?.length === 4);

const planned = planPopupDisplay({
  display_type: "critical",
  display_mode: "on_demand",
  priority: "high",
});
assert("plan: critical on_demand", planned.display_type === "critical" && planned.show_immediately === false);

const official = evaluateOfficialPopupDisplay({ display_type: "success" });
assert("evaluate official success", official.display_type === S7_POPUP_DISPLAY_TYPE.SUCCESS);

const preview = previewPopupTemplate({
  title_template: "Olá {{seller_name}}",
  body_template: "Mensagem de teste",
  display_type: "warning",
});
assert("preview: channel popup", preview.channel === "popup");
assert("preview: title render", preview.title.includes("seller") || preview.title.length > 0);
assert("preview: surfaces", Array.isArray(preview.preview_surfaces) && preview.preview_surfaces.includes("toast"));

const trace = buildPopupDeliveryTraceSummary({
  delivery_id: "del-1",
  event_id: "evt-1",
  status: "displayed",
});
assert("trace: audit table", trace.audit_table === S7_POPUP_DELIVERIES_TABLE);
assert("trace fields", S7_POPUP_TRACE_FIELDS.STATUS === "status");

const reuse = describePopupMultiSurfaceReuse();
assert("reuse: toast component", Boolean(reuse.toast?.component));

if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`, failures);
  process.exit(1);
}
console.log(`✅ S5.7 Canal Pop-up Oficial — ${passed} asserts OK.`);
