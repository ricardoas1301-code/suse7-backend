#!/usr/bin/env node
/**
 * DEV.V2.RUNTIME-IDENTITY-GATES-V2.15 — testes unitários GLOBAL DEV MAINTENANCE MODE.
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
  resolveDevGlobalMaintenanceState,
} from "../src/domain/dev/devGlobalMaintenanceMode.js";
import { classifyMlWebhookApplyResult } from "../src/handlers/ml/_helpers/mlWebhookOrderProcessorOutcome.js";
import { S7_SUPABASE_PROJECT_REF } from "../src/billing/services/billingRuntimeEnvironmentService.js";

const V2_REF = "alkelcaoexxbamqddaqv";

function devEnv(ref, extra = {}) {
  return {
    S7_APP_ENV: "development",
    SUPABASE_URL: `https://${ref}.supabase.co`,
    S7_EXPECTED_SUPABASE_PROJECT_REF: ref,
    DEV_GLOBAL_MAINTENANCE_MODE: "1",
    ...extra,
  };
}

const DEV_V1_ON = devEnv(S7_SUPABASE_PROJECT_REF.DEV);
const DEV_V2_ON = devEnv(V2_REF);
const DEV_ENV_OFF = { ...DEV_V2_ON, DEV_GLOBAL_MAINTENANCE_MODE: "0" };

const PROD_ENV = {
  S7_APP_ENV: "production",
  SUPABASE_URL: `https://${S7_SUPABASE_PROJECT_REF.PROD}.supabase.co`,
  S7_EXPECTED_SUPABASE_PROJECT_REF: S7_SUPABASE_PROJECT_REF.PROD,
  DEV_GLOBAL_MAINTENANCE_MODE: "1",
};

function testProdInactive() {
  assert.equal(isDevGlobalMaintenanceModeActive(PROD_ENV), false);
  assert.equal(resolveDevGlobalMaintenanceState(PROD_ENV).configurationError, true);
}

function testV2Active() {
  assert.equal(isDevGlobalMaintenanceModeActive(DEV_V2_ON), true);
}

function testV1RollbackActive() {
  assert.equal(isDevGlobalMaintenanceModeActive(DEV_V1_ON), true);
}

function testV2ExpectedV1ActualInactive() {
  assert.equal(
    isDevGlobalMaintenanceModeActive({
      ...DEV_V2_ON,
      SUPABASE_URL: `https://${S7_SUPABASE_PROJECT_REF.DEV}.supabase.co`,
    }),
    false,
  );
}

function testV1ExpectedV2ActualInactive() {
  assert.equal(
    isDevGlobalMaintenanceModeActive({
      ...DEV_V1_ON,
      SUPABASE_URL: `https://${V2_REF}.supabase.co`,
    }),
    false,
  );
}

function testExpectedAbsentInactive() {
  assert.equal(
    isDevGlobalMaintenanceModeActive({
      S7_APP_ENV: "development",
      SUPABASE_URL: `https://${V2_REF}.supabase.co`,
      DEV_GLOBAL_MAINTENANCE_MODE: "1",
    }),
    false,
  );
}

function testMalformedUrlInactive() {
  assert.equal(
    isDevGlobalMaintenanceModeActive({
      S7_APP_ENV: "development",
      SUPABASE_URL: "not-a-valid-url",
      S7_EXPECTED_SUPABASE_PROJECT_REF: V2_REF,
      DEV_GLOBAL_MAINTENANCE_MODE: "1",
    }),
    false,
  );
}

function testDevRequiresExplicitOptIn() {
  assert.equal(isDevGlobalMaintenanceModeActive(DEV_V2_ON), true);
  assert.equal(isDevGlobalMaintenanceModeActive(DEV_ENV_OFF), false);
}

function testWebhookIgnored() {
  const gate = evaluateDevGlobalMaintenanceWebhookEvent({}, DEV_V2_ON);
  assert.equal(gate.ignore, true);
  assert.equal(gate.reason, DEV_GLOBAL_MAINTENANCE_REASON);
  assert.equal(gate.outcome, DEV_GLOBAL_MAINTENANCE_OUTCOME);
}

function testSyncBlocked() {
  const blocked = buildDevGlobalMaintenanceBlockedApplyResult({ scope: "sync", env: DEV_V2_ON });
  assert.ok(blocked?.maintenance_blocked);
  assert.equal(classifyMlWebhookApplyResult(blocked).outcome, "IGNORED_MAINTENANCE");
}

function testPollBlocked() {
  assert.equal(evaluateDevGlobalMaintenanceGate({ env: DEV_V2_ON }).blocked, true);
}

function testReconciliationBlocked() {
  const skip = buildDevGlobalMaintenanceJobSkipResult({
    jobType: "billing-renewal-engine",
    env: DEV_V2_ON,
  });
  assert.ok(skip?.maintenance_blocked);
}

function testListingSyncBlockedViaJob() {
  const skip = buildDevGlobalMaintenanceJobSkipResult({
    jobType: "competition-daily-snapshot",
    env: DEV_V2_ON,
  });
  assert.ok(skip?.maintenance_blocked);
}

function testHealthWhenOff() {
  assert.equal(evaluateDevGlobalMaintenanceGate({ env: DEV_ENV_OFF }).blocked, false);
}

const tests = [
  ["prod maintenance inactive / config error", testProdInactive],
  ["V2 expected+actual maintenance active", testV2Active],
  ["V1 rollback maintenance active", testV1RollbackActive],
  ["V2 expected V1 actual inactive", testV2ExpectedV1ActualInactive],
  ["V1 expected V2 actual inactive", testV1ExpectedV2ActualInactive],
  ["expected absent inactive", testExpectedAbsentInactive],
  ["malformed url inactive", testMalformedUrlInactive],
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
