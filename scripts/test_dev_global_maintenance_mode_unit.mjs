#!/usr/bin/env node
/**
 * DEV.CLEAN-RESET.FULL.V2.PREEXEC.01 — testes unitários GLOBAL DEV MAINTENANCE MODE.
 */

import assert from "node:assert/strict";
import {
  DEV_GLOBAL_MAINTENANCE_OUTCOME,
  DEV_GLOBAL_MAINTENANCE_REASON,
  buildDevGlobalMaintenanceBlockedApplyResult,
  buildDevGlobalMaintenanceJobSkipResult,
  evaluateDevGlobalMaintenanceGate,
  evaluateDevGlobalMaintenanceWebhookEvent,
  isDevGlobalMaintenanceModeActive,
} from "../src/domain/dev/devGlobalMaintenanceMode.js";
import { classifyMlWebhookApplyResult } from "../src/handlers/ml/_helpers/mlWebhookOrderProcessorOutcome.js";
import { S7_SUPABASE_PROJECT_REF } from "../src/billing/services/billingRuntimeEnvironmentService.js";

const DEV_ENV_ON = {
  S7_APP_ENV: "development",
  SUPABASE_URL: `https://${S7_SUPABASE_PROJECT_REF.DEV}.supabase.co`,
  DEV_GLOBAL_MAINTENANCE_MODE: "1",
};

const DEV_ENV_OFF = {
  ...DEV_ENV_ON,
  DEV_GLOBAL_MAINTENANCE_MODE: "0",
};

const PROD_ENV = {
  S7_APP_ENV: "production",
  SUPABASE_URL: `https://${S7_SUPABASE_PROJECT_REF.PROD}.supabase.co`,
  DEV_GLOBAL_MAINTENANCE_MODE: "1",
};

function testProdInactive() {
  assert.equal(isDevGlobalMaintenanceModeActive(PROD_ENV), false);
}

function testDevRequiresExplicitOptIn() {
  assert.equal(isDevGlobalMaintenanceModeActive(DEV_ENV_ON), true);
  assert.equal(isDevGlobalMaintenanceModeActive(DEV_ENV_OFF), false);
}

function testWebhookIgnored() {
  const gate = evaluateDevGlobalMaintenanceWebhookEvent({}, DEV_ENV_ON);
  assert.equal(gate.ignore, true);
  assert.equal(gate.reason, DEV_GLOBAL_MAINTENANCE_REASON);
  assert.equal(gate.outcome, DEV_GLOBAL_MAINTENANCE_OUTCOME);
}

function testSyncBlocked() {
  const blocked = buildDevGlobalMaintenanceBlockedApplyResult({ scope: "sync", env: DEV_ENV_ON });
  assert.ok(blocked?.maintenance_blocked);
  assert.equal(classifyMlWebhookApplyResult(blocked).outcome, "IGNORED_MAINTENANCE");
}

function testPollBlocked() {
  assert.equal(evaluateDevGlobalMaintenanceGate({ env: DEV_ENV_ON }).blocked, true);
}

function testReconciliationBlocked() {
  const skip = buildDevGlobalMaintenanceJobSkipResult({ jobType: "billing-renewal-engine", env: DEV_ENV_ON });
  assert.ok(skip?.maintenance_blocked);
}

function testListingSyncBlockedViaJob() {
  const skip = buildDevGlobalMaintenanceJobSkipResult({ jobType: "competition-daily-snapshot", env: DEV_ENV_ON });
  assert.ok(skip?.maintenance_blocked);
}

function testHealthWhenOff() {
  assert.equal(evaluateDevGlobalMaintenanceGate({ env: DEV_ENV_OFF }).blocked, false);
}

const tests = [
  ["prod maintenance inactive", testProdInactive],
  ["dev requires DEV_GLOBAL_MAINTENANCE_MODE=1", testDevRequiresExplicitOptIn],
  ["webhook ignored maintenance", testWebhookIgnored],
  ["sync blocked", testSyncBlocked],
  ["poll blocked", testPollBlocked],
  ["reconciliation/billing job blocked", testReconciliationBlocked],
  ["competition/listing job blocked", testListingSyncBlockedViaJob],
  ["inactive when flag off", testHealthWhenOff],
];

for (const [name, fn] of tests) {
  fn();
  console.log(`PASS ${name}`);
}
console.log(`\n${tests.length}/${tests.length} global maintenance tests passed`);
