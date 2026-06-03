#!/usr/bin/env node
/**
 * S5.11 — Catálogo de Notificações — testes de unidade (sem rede).
 */

const {
  S7_NOTIFICATION_CATALOG_DOMAIN_GROUP,
  S7_NOTIFICATION_CATALOG_PRIORITY,
  listCatalogSupportedCategories,
  listCatalogSupportedPriorities,
  listCatalogSupportedChannels,
  listCatalogMandatoryTiers,
  isValidCatalogPriority,
  getOfficialNotificationCatalogSnapshot,
  getNotificationCatalogPublicContract,
  describeFutureNotificationDefinitionSchema,
  validateFutureNotificationDefinitionShape,
  countRuntimeCatalogTypeEntries,
} = await import("../src/domain/notifications/central/catalog/index.js");

const failures = [];
let passed = 0;
function assert(name, cond) {
  if (cond) passed += 1;
  else failures.push(name);
}

assert("domain groups 6", Object.keys(S7_NOTIFICATION_CATALOG_DOMAIN_GROUP).length === 6);

const categories = listCatalogSupportedCategories();
assert("categories include BILLING", categories.some((c) => c.code === "BILLING"));
assert("BILLING financeiro", categories.find((c) => c.code === "BILLING")?.domain_group === "financeiro");

const priorities = listCatalogSupportedPriorities();
assert("priorities 4", priorities.length === 4);
assert("valid high", isValidCatalogPriority("high"));
assert("high maps communication", priorities.find((p) => p.code === "high")?.communication_priority === "high");

const channels = listCatalogSupportedChannels();
assert("channels include email", channels.some((c) => c.code === "email"));
assert("channels include popup", channels.some((c) => c.code === "popup"));

const mandatory = listCatalogMandatoryTiers();
assert("mandatory tiers", mandatory.includes("mandatory") && mandatory.includes("optional"));

const snap = getOfficialNotificationCatalogSnapshot();
assert("snapshot S5.11", snap.phase === "S5.11");
assert("skeleton only", snap.skeleton_only === true);
assert("zero notifications", snap.notifications_registered === 0);
assert("runtime count > 0", snap.runtime_type_entries_count > 0);

const contract = getNotificationCatalogPublicContract();
assert("public categories", contract.categories?.includes("BILLING"));
assert("public priorities", contract.priorities?.includes(S7_NOTIFICATION_CATALOG_PRIORITY.CRITICAL));

const schema = describeFutureNotificationDefinitionSchema();
assert("future schema code", Boolean(schema.code?.required));

const valid = validateFutureNotificationDefinitionShape({
  code: "test.code",
  category_code: "BILLING",
  type_key: "TEST",
});
assert("future shape ok", valid.ok === true);

const invalid = validateFutureNotificationDefinitionShape({});
assert("future shape invalid", invalid.ok === false);

assert("runtime entries", countRuntimeCatalogTypeEntries() > 0);

if (failures.length) {
  console.error(`\n❌ FALHAS (${failures.length}):`, failures);
  process.exit(1);
}
console.log(`✅ S5.11 Catálogo de Notificações — ${passed} asserts OK.`);
