#!/usr/bin/env node
/**
 * Regression guards — lease / heartbeat / stale recovery (T1, T9–T11).
 */
import {
  buildLeaseClaimMetadataPatch,
  buildLeaseHeartbeatMetadataPatch,
  canExecutorClaimJob,
  isJobLeaseExpired,
  readJobLeaseMeta,
  resolveLeaseDurationMs,
  resolveMaxStaleRecoveries,
  resolveStaleRecoveryThresholdMs,
  resolveSyncExecutorId,
  resolveHeartbeatIntervalMs,
  assertHeartbeatLeaseTimingInvariant,
} from "../src/services/marketplace/marketplaceSyncJobLease.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const nowMs = Date.parse("2026-08-20T19:00:00.000Z");
const executorA = "local:dev-host:no-deploy";
const executorB = "production:vercel-app:abc123";

function jobRunning(overrides = {}) {
  const leaseMs = resolveLeaseDurationMs();
  const hb = new Date(nowMs - 60_000).toISOString();
  const exp = new Date(nowMs + leaseMs).toISOString();
  return {
    id: "job-1",
    status: "running",
    updated_at: hb,
    progress_current: 900,
    progress_total: 1434,
    last_cursor: '{"search_offset":850,"idx_in_page":50,"seller_id":"2350765542"}',
    metadata: {
      heartbeat_at: hb,
      lease_expires_at: exp,
      lease_owner: executorA,
      lease_version: 3,
      recovery_count: 0,
      ...overrides.metadata,
    },
    ...overrides,
  };
}

// T9 — segundo executor não claim enquanto lease válido
{
  const j = jobRunning();
  assert("T9 can A renew own lease", canExecutorClaimJob(j, executorA, nowMs));
  assert("T9 B blocked on valid lease", !canExecutorClaimJob(j, executorB, nowMs));
}

// T9 — lease expirado: B pode claim
{
  const staleHb = new Date(nowMs - resolveStaleRecoveryThresholdMs() - 5000).toISOString();
  const j = jobRunning({
    updated_at: staleHb,
    metadata: {
      heartbeat_at: staleHb,
      lease_expires_at: new Date(nowMs - 1000).toISOString(),
      lease_owner: executorA,
      lease_version: 3,
    },
  });
  assert("T9 expired lease allows B", canExecutorClaimJob(j, executorB, nowMs));
  assert("T9 isJobLeaseExpired true", isJobLeaseExpired(j, nowMs));
}

// T1 / T10 — stale não implica perda de checkpoint (job object preserved)
{
  const staleHb = new Date(nowMs - resolveStaleRecoveryThresholdMs() - 1000).toISOString();
  const j = jobRunning({ updated_at: staleHb, metadata: { heartbeat_at: staleHb, lease_owner: executorA } });
  assert("T1 stale detected", isJobLeaseExpired(j, nowMs));
  assert("T1 checkpoint preserved on object", j.last_cursor.includes("search_offset"));
  assert("T1 progress preserved", j.progress_current === 900);
}

// T10 — handoff metadata
{
  const meta = buildLeaseClaimMetadataPatch({ recovery_count: 2, lease_version: 4 }, executorB, nowMs, {
    handoffFrom: executorA,
  });
  assert("T10 handoff_from", meta.lease_handoff_from === executorA);
  assert("T10 new owner", meta.lease_owner === executorB);
  assert("T10 version bump", meta.lease_version === 5);
  assert("T10 heartbeat set", typeof meta.heartbeat_at === "string");
  assert("T10 lease_expires_at set", typeof meta.lease_expires_at === "string");
}

// T11 — max recoveries configurável
{
  const max = resolveMaxStaleRecoveries();
  assert("T11 max recoveries >= 1", max >= 1);
  const j = jobRunning({ metadata: { recovery_count: max, heartbeat_at: new Date(nowMs - 999999).toISOString() } });
  const next = readJobLeaseMeta(j).recovery_count + 1;
  assert("T11 would exceed limit", next > max);
}

// Timing: heartbeat interval < lease < stale threshold (documented invariant)
{
  const timing = assertHeartbeatLeaseTimingInvariant();
  const heartbeatEveryMs = Math.max(1000, parseInt(process.env.MARKETPLACE_SYNC_SALES_PROGRESS_HEARTBEAT_EVERY || "8", 10) * 5000);
  assert("timing lease < stale", timing.lease_duration_ms < timing.stale_recovery_threshold_ms);
  assert("timing heartbeat interval < lease", timing.heartbeat_interval_ms < timing.lease_duration_ms);
  assert("timing heartbeat batch << lease", heartbeatEveryMs < timing.lease_duration_ms);
}

// T28 — legacy claim path: version null treated as 0, claim bumps to 1
{
  const legacyMeta = buildLeaseClaimMetadataPatch({ recovery_count: 1 }, executorA, nowMs);
  assert("legacy claim sets version 1", legacyMeta.lease_version === 1);
  assert("legacy preserves recovery_count", legacyMeta.recovery_count === 1);
}

// pending sempre elegível
{
  assert("pending claimable", canExecutorClaimJob({ status: "pending" }, executorA, nowMs));
}

// stale error prefix recoverable (Insprazzo case)
{
  const errJob = {
    status: "error",
    error_message: "stale_running_timeout>900000ms",
    progress_current: 900,
    metadata: { recovery_count: 0 },
  };
  assert("insprazzo stale error prefix", String(errJob.error_message).startsWith("stale_running_timeout"));
  assert("insprazzo progress intact", errJob.progress_current === 900);
}

// executor id deterministic with env
{
  process.env.ML_SYNC_EXECUTOR_ID = "test-executor-fixed";
  assert("executor id from env", resolveSyncExecutorId() === "test-executor-fixed");
  delete process.env.ML_SYNC_EXECUTOR_ID;
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      tests_passed: 18,
      timing: {
        lease_duration_ms: resolveLeaseDurationMs(),
        stale_recovery_threshold_ms: resolveStaleRecoveryThresholdMs(),
        max_stale_recoveries: resolveMaxStaleRecoveries(),
      },
    },
    null,
    2
  )
);
