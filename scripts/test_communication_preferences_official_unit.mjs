#!/usr/bin/env node
/**
 * S5.9 — Preferências de Comunicação — testes de unidade (sem rede).
 */

const {
  S7_COMMUNICATION_PREFERENCES_TABLE,
  S7_COMMUNICATION_PREF_RESOLVER,
  getOfficialCommunicationPreferencesSnapshot,
  evaluateOfficialMandatoryTier,
  describeCommunicationDispatcherPipeline,
  describeCommunicationRecipientsGovernance,
  planCommunicationDeliveryPolicy,
  buildCommunicationPreferencesTraceSummary,
  describePreferenceDimensions,
} = await import("../src/domain/notifications/central/preferences/index.js");

const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

assert("preferences table", S7_COMMUNICATION_PREFERENCES_TABLE === "s7_notification_preferences");
assert("resolver name", S7_COMMUNICATION_PREF_RESOLVER === "resolveNotificationPreferences");

const snap = getOfficialCommunicationPreferencesSnapshot();
assert("snapshot S5.9", snap.phase === "S5.9");
assert("single source", snap.single_source_of_truth === true);
assert("no parallel motor", snap.parallel_motor === false);
assert("dispatcher pipeline steps", snap.dispatcher_integration?.steps?.length >= 5);
assert("prefs resolver in pipeline", snap.dispatcher_integration?.steps?.[0]?.layer === "preferences");
assert("mandatory future examples", Array.isArray(snap.mandatory_communication?.future_examples));
assert("delivery policy not applied", snap.delivery_policy_prepared?.applied_in_dispatcher === false);
assert("seller API preferences", snap.seller_api?.PREFERENCES_GET === "/api/notifications/preferences");

const pipeline = describeCommunicationDispatcherPipeline();
assert("pipeline invariant", typeof pipeline.invariant === "string");

const recipients = describeCommunicationRecipientsGovernance();
assert("recipients in_app owner", recipients.in_app_owner?.role === "owner_in_app");
assert("future channels", recipients.future_channels?.includes("popup"));

const mandatory = evaluateOfficialMandatoryTier(true);
assert("mandatory tier", mandatory.tier === "mandatory");

const policy = planCommunicationDeliveryPolicy({ frequency: "daily" });
assert("policy daily prepared", policy.frequency === "daily" && policy.applied === false);

const dims = describePreferenceDimensions({ category_code: "BILLING", type_key: null, channel: "email" });
assert("dims by category", dims.by_category === true && dims.by_type === false);

const trace = buildCommunicationPreferencesTraceSummary({
  seller_id: "s1",
  category: "BILLING",
  enabled_channels: ["in_app"],
});
assert("trace tables", trace.tables?.preferences === "s7_notification_preferences");

if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`, failures);
  process.exit(1);
}
console.log(`✅ S5.9 Preferências de Comunicação — ${passed} asserts OK.`);
