#!/usr/bin/env node
/**
 * Regression guard — merge seguro de metadata (lease não apagado por patch operacional).
 */
import {
  mergeOperationalSyncJobMetadata,
  validateLeaseMetadataPreserved,
  buildLeaseHeartbeatMetadataPatch,
  buildLeaseClaimMetadataPatch,
  assertHeartbeatLeaseTimingInvariant,
} from "../src/services/marketplace/marketplaceSyncJobLease.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const executor = "local:homolog:no-deploy";
const nowMs = Date.parse("2026-08-20T19:30:00.000Z");

const leaseBefore = {
  heartbeat_at: "2026-08-20T19:00:00.000Z",
  lease_expires_at: "2026-08-20T19:05:00.000Z",
  lease_owner: executor,
  lease_version: 4,
  recovery_count: 2,
  phase: "sales_recent",
  sync_job_kind: "ml_initial_sales_recent",
};

{
  const operationalPatch = { phase: "sales_recent", last_order_id: "MLB123", errors_count: 0 };
  const merged = mergeOperationalSyncJobMetadata(leaseBefore, operationalPatch);
  const check = validateLeaseMetadataPreserved(leaseBefore, merged);
  assert("merge preserves lease_owner", merged.lease_owner === executor);
  assert("merge preserves lease_version", merged.lease_version === 4);
  assert("merge preserves recovery_count", merged.recovery_count === 2);
  assert("merge applies operational field", merged.last_order_id === "MLB123");
  assert("validateLeaseMetadataPreserved ok", check.ok === true);
}

{
  const partialPatch = { metadata: { phase: "x" } };
  void partialPatch;
  const merged = mergeOperationalSyncJobMetadata(leaseBefore, { phase: "x" });
  assert("partial patch does not wipe recovery_count", merged.recovery_count === 2);
}

{
  const afterHb = buildLeaseHeartbeatMetadataPatch(
    mergeOperationalSyncJobMetadata(leaseBefore, { last_order_index: 901 }),
    executor,
    nowMs
  );
  assert("heartbeat keeps lease_version", afterHb.lease_version === 4);
  assert("heartbeat updates heartbeat_at", afterHb.heartbeat_at !== leaseBefore.heartbeat_at);
  assert("heartbeat keeps recovery_count", afterHb.recovery_count === 2);
  const checkHb = validateLeaseMetadataPreserved(leaseBefore, afterHb);
  assert("heartbeat validate ok", checkHb.ok === true);
}

{
  const afterClaim = buildLeaseClaimMetadataPatch(leaseBefore, "hosted:vercel:deploy1", nowMs, {
    handoffFrom: executor,
  });
  assert("claim bumps lease_version", afterClaim.lease_version === 5);
  assert("claim sets handoff_from", afterClaim.lease_handoff_from === executor);
}

{
  const timing = assertHeartbeatLeaseTimingInvariant();
  assert("timing hb < lease", timing.heartbeat_interval_ms < timing.lease_duration_ms);
  assert("timing lease < stale", timing.lease_duration_ms < timing.stale_recovery_threshold_ms);
}

{
  const bad = { ...leaseBefore, lease_version: 2, recovery_count: 0 };
  const check = validateLeaseMetadataPreserved(leaseBefore, bad);
  assert("detect version regression", check.ok === false && check.issues.includes("lease_version_regressed"));
  assert("detect recovery regression", check.issues.includes("recovery_count_regressed"));
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, tests_passed: 14, policy: "metadata_merge_safe" }, null, 2));
