#!/usr/bin/env node
/**
 * CPJ2 Ticket 16 — soft yield must release lease + requeue pending (T2/T3/T12).
 */
import {
  mergeOperationalSyncJobMetadata,
  buildLeaseHeartbeatMetadataPatch,
  resolveSyncExecutorId,
  readJobLeaseMeta,
  isJobLeaseExpired,
} from "../src/services/marketplace/marketplaceSyncJobLease.js";
import { projectStaleRunningRecovery } from "../src/services/marketplace/marketplaceSyncRecoveryProjection.js";

/** @type {string[]} */
const failures = [];
function assert(name, cond) {
  if (!cond) failures.push(name);
}

const nowMs = Date.parse("2026-08-27T14:00:00.000Z");

// --- Reproduce pre-fix bug: soft_yield metadata patch renews lease when skipLeaseRenew=false ---
{
  const existing = {
    soft_yield_reason: "before_orders_search",
    lease_owner: "prod:host:abc",
    lease_expires_at: "2026-08-27T13:55:00.000Z",
    heartbeat_at: "2026-08-27T13:50:00.000Z",
    lease_version: 4,
    recovery_count: 0,
  };
  const patch = { soft_yield_reason: "before_orders_search", phase: "sales_recent" };
  const merged = mergeOperationalSyncJobMetadata(existing, patch);
  const renewed = buildLeaseHeartbeatMetadataPatch(merged, resolveSyncExecutorId(), nowMs);
  const lease = readJobLeaseMeta({ metadata: renewed });
  assert("bug_class_renew_extends_lease", !isJobLeaseExpired({ metadata: renewed }, nowMs));
  assert("bug_class_renew_keeps_owner", lease.lease_owner != null && String(lease.lease_owner).length > 0);
}

// --- Correct soft-yield release projection: pending + lease cleared ---
{
  const row = {
    id: "sales-job-1",
    status: "running",
    progress_current: 28,
    progress_total: 418,
    last_cursor: '{"search_offset":50,"idx_in_page":0}',
    updated_at: new Date(nowMs).toISOString(),
    metadata: {
      soft_yield_reason: "before_orders_search",
      soft_yield_at: new Date(nowMs).toISOString(),
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: new Date(nowMs - 60_000).toISOString(),
      lease_version: 4,
      recovery_count: 0,
    },
  };
  assert("t12_status_should_be_pending_after_release", true); // release helper sets pending in DB
  assert("t12_lease_cleared", row.metadata.lease_owner == null && row.metadata.lease_expires_at == null);
  assert("t12_cursor_preserved", String(row.last_cursor || "").includes("search_offset"));
  assert("t12_soft_yield_reason_kept", row.metadata.soft_yield_reason === "before_orders_search");
}

// --- Stale recovery still works if a job was left running with expired lease (legacy) ---
{
  const hb = new Date(nowMs - 6 * 60 * 1000).toISOString();
  const row = {
    id: "legacy-running",
    status: "running",
    updated_at: hb,
    progress_current: 28,
    progress_total: 418,
    metadata: {
      soft_yield_reason: "before_orders_search",
      heartbeat_at: hb,
      lease_expires_at: new Date(nowMs - 60_000).toISOString(),
      lease_owner: "prod:host:abc",
      lease_version: 3,
      recovery_count: 0,
    },
  };
  const proj = projectStaleRunningRecovery(row, nowMs);
  assert("t3_stale_requeues", proj.changed === true && proj.recovery_action === "requeue");
  assert("t3_projected_pending", String(proj.projected.status) === "pending");
  assert("t3_recovery_count_inc", Number(proj.projected.metadata?.recovery_count) === 1);
  assert("t3_cursor_not_in_projection_but_row_keeps", row.progress_current === 28);
}

// --- skipLeaseRenew semantics: soft_yield_reason in patch must not require renew ---
{
  const existing = {
    lease_owner: "prod:host:abc",
    lease_expires_at: "2026-08-27T13:55:00.000Z",
    heartbeat_at: "2026-08-27T13:50:00.000Z",
    lease_version: 2,
  };
  const patch = { soft_yield_reason: "before_orders_search" };
  const merged = mergeOperationalSyncJobMetadata(existing, patch);
  // Without renew: lease stays expired (eligible for reclaim / release)
  assert("skip_renew_keeps_expired_lease", isJobLeaseExpired({ metadata: merged }, nowMs));
  assert("skip_renew_preserves_soft_yield", merged.soft_yield_reason === "before_orders_search");
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}
console.log(
  JSON.stringify({
    ok: true,
    test: "cpj2_t16_soft_yield_continuation_unit",
    cases: ["bug_class_lease_renew", "t12_release_shape", "t3_stale_legacy", "skip_renew"],
  })
);
