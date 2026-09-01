#!/usr/bin/env node
/**
 * CPJ-2 T1 OBS2 — resolveInitialSyncUniverseStable usa isEffectiveSyncSuccess.
 */
import assert from "node:assert/strict";
import { DEV_GLOBAL_MAINTENANCE_REASON } from "../src/domain/dev/devGlobalMaintenanceMode.js";
import { evaluateInitialSyncUniverseStableFromJobs } from "../src/domain/dashboard/initialSyncUniverseStable.js";

const GO = "ab85841e-fa8f-44a1-8db1-853560170241";
const RP = "9ee145d1-b6ff-4a44-a0ca-3bab5d7e9ef0";

function stub(jobType, accountId) {
  return {
    marketplace_account_id: accountId,
    job_type: jobType,
    status: "done",
    metadata: { skipped: true, reason: DEV_GLOBAL_MAINTENANCE_REASON },
  };
}

function real(jobType, accountId, status = "done") {
  return {
    marketplace_account_id: accountId,
    job_type: jobType,
    status,
    metadata: {},
  };
}

const masters = (accountId, listingsStatus, productsStatus) => [
  real("ml_initial_listings_current", accountId, listingsStatus),
  real("ml_initial_products", accountId, productsStatus),
];

// CASE 8 — maintenance stub done NÃO estabiliza
{
  const r = evaluateInitialSyncUniverseStableFromJobs(
    [GO],
    [stub("ml_initial_listings_current", GO), stub("ml_initial_products", GO)],
  );
  assert.equal(r.stable, false);
  assert.equal(r.reason, "initial_sync_masters_in_progress");
  console.log("CASE8_MAINTENANCE_STUB_DOES_NOT_STABILIZE=PASS");
}

// CASE 3 — products pending
{
  const r = evaluateInitialSyncUniverseStableFromJobs(
    [GO],
    [...masters(GO, "done", "pending")],
  );
  assert.equal(r.stable, false);
  console.log("CASE3_PRODUCTS_PENDING_UNSTABLE=PASS");
}

// CASE 4 — products running
{
  const r = evaluateInitialSyncUniverseStableFromJobs(
    [GO],
    [...masters(GO, "done", "running")],
  );
  assert.equal(r.stable, false);
  console.log("CASE4_PRODUCTS_RUNNING_UNSTABLE=PASS");
}

// CASE 2 — sync em andamento (listings pending)
{
  const r = evaluateInitialSyncUniverseStableFromJobs(
    [GO],
    [...masters(GO, "pending", "pending")],
  );
  assert.equal(r.stable, false);
  console.log("CASE2_INITIAL_SYNC_PENDING_UNSTABLE=PASS");
}

// CASE 9 — real effective success estabiliza
{
  const r = evaluateInitialSyncUniverseStableFromJobs(
    [GO],
    [...masters(GO, "done", "done")],
  );
  assert.equal(r.stable, true);
  assert.equal(r.reason, null);
  console.log("CASE9_REAL_EFFECTIVE_SUCCESS_STABLE=PASS");
}

// Stub + real pending products → ainda instável (stub não conta)
{
  const r = evaluateInitialSyncUniverseStableFromJobs(
    [GO],
    [
      stub("ml_initial_listings_current", GO),
      stub("ml_initial_products", GO),
      real("ml_initial_listings_current", GO, "done"),
      real("ml_initial_products", GO, "pending"),
    ],
  );
  assert.equal(r.stable, false);
  console.log("STUB_PLUS_REAL_PRODUCTS_PENDING_UNSTABLE=PASS");
}

// CASE 10 — RP real done preserva stable; GO incompleto deixa user instável
{
  const rpOnly = evaluateInitialSyncUniverseStableFromJobs(
    [RP],
    [...masters(RP, "done", "done")],
  );
  assert.equal(rpOnly.stable, true);

  const both = evaluateInitialSyncUniverseStableFromJobs(
    [RP, GO],
    [
      ...masters(RP, "done", "done"),
      ...masters(GO, "done", "pending"),
    ],
  );
  assert.equal(both.stable, false);
  console.log("CASE10_ACCOUNT_A_PRESERVED_WHILE_B_PENDING=PASS");
}

// Ambos reais done → stable
{
  const r = evaluateInitialSyncUniverseStableFromJobs(
    [RP, GO],
    [...masters(RP, "done", "done"), ...masters(GO, "done", "done")],
  );
  assert.equal(r.stable, true);
  console.log("MULTI_ACCOUNT_BOTH_REAL_DONE_STABLE=PASS");
}

console.log("[test_cpj2_t1_obs2_universe_stable_effective_success_unit] OK");
