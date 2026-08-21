#!/usr/bin/env node
/**
 * P0.2-M.2 — ordem canônica window_index + paridade dry-run × recovery projection.
 * Testes M2-01 … M2-12.
 */
import {
  projectPoolAfterStaleRecovery,
  projectStaleRunningRecovery,
} from "../src/services/marketplace/marketplaceSyncRecoveryProjection.js";
import {
  ML_HISTORICAL_SALES_BACKFILL_JOB_TYPE,
  compareHistoricalWindowIndex,
  pickJobsDistinctAccounts,
  readHistoricalWindowIndex,
  selectJobsFromProjectedPool,
  sortEligibleJobs,
} from "../src/services/marketplace/marketplaceSyncJobSelector.js";
import {
  canExecutorClaimJob,
  isJobLeaseExpired,
  resolveLeaseDurationMs,
  resolveStaleRecoveryThresholdMs,
} from "../src/services/marketplace/marketplaceSyncJobLease.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const NOW = Date.parse("2026-08-21T08:10:00.000Z");
const ACCOUNT_A = "acc-insprazzo";
const ACCOUNT_B = "acc-other";
const W3_ID = "8f08e2c5-52ab-4e0d-b804-babf9feef6ef";
const W4_ID = "acf757c5-ed89-432e-9f56-fb13e7cc8986";

/** @param {Record<string, unknown>} overrides */
function histJob(accountId, windowIndex, status, overrides = {}) {
  const id = overrides.id ?? `win-${windowIndex}-${accountId}`;
  const updatedAt =
    overrides.updated_at ??
    (windowIndex === 3 ? "2026-08-21T08:03:12.415Z" : "2026-08-20T20:54:01.392Z");
  return {
    id,
    marketplace_account_id: accountId,
    seller_company_id: "seller-1",
    job_type: ML_HISTORICAL_SALES_BACKFILL_JOB_TYPE,
    status,
    priority: 100,
    progress_current: overrides.progress_current ?? 0,
    progress_total: overrides.progress_total ?? null,
    last_cursor: overrides.last_cursor ?? null,
    created_at: "2026-08-20T20:54:01.593Z",
    updated_at: updatedAt,
    metadata: {
      window_index: windowIndex,
      date_from: "2026-01-01T00:00:00.000Z",
      date_to: "2026-02-01T00:00:00.000Z",
      ...(overrides.metadata && typeof overrides.metadata === "object" ? overrides.metadata : {}),
    },
    ...overrides,
  };
}

/** @param {string} accountId */
function statusMapSalesHotDone(accountId) {
  return {
    [`${accountId}:ml_initial_listings_current`]: "done",
    [`${accountId}:ml_initial_fees`]: "done",
    [`${accountId}:ml_initial_products`]: "done",
    [`${accountId}:ml_initial_customers_recent`]: "done",
    [`${accountId}:ml_enable_webhook_monitoring`]: "done",
    [`${accountId}:ml_initial_sales_recent`]: "done",
  };
}

function firstPick(pool, statusMap, nowMs = NOW) {
  const projected = projectPoolAfterStaleRecovery(pool, nowMs).filter((r) => {
    const s = String(r.status || "").toLowerCase();
    return s === "pending" || s === "running";
  });
  return selectJobsFromProjectedPool(projected, statusMap, {}, 1, nowMs)[0] ?? null;
}

// M2-01 — W3 pending + W4 pending; updated_at W3 mais novo → W3
{
  const pool = [
    histJob(ACCOUNT_A, 4, "pending", { id: W4_ID }),
    histJob(ACCOUNT_A, 3, "pending", { id: W3_ID, updated_at: "2026-08-21T08:03:12.415Z" }),
  ];
  const pick = firstPick(pool, statusMapSalesHotDone(ACCOUNT_A));
  assert("M2-01 picks W3", pick?.id === W3_ID);
}

// M2-02 — W3 stale running + W4 pending; projeção → W3
{
  const leaseMs = resolveLeaseDurationMs();
  const hb = new Date(NOW - 120_000).toISOString();
  const exp = new Date(NOW - 1000).toISOString();
  const pool = [
    histJob(ACCOUNT_A, 4, "pending", { id: W4_ID }),
    histJob(ACCOUNT_A, 3, "running", {
      id: W3_ID,
      metadata: {
        window_index: 3,
        heartbeat_at: hb,
        lease_expires_at: exp,
        lease_owner: "hosted:vercel:abc",
        recovery_count: 0,
      },
    }),
  ];
  const pick = firstPick(pool, statusMapSalesHotDone(ACCOUNT_A));
  assert("M2-02 picks W3 after projection", pick?.id === W3_ID);
  const projectedW3 = projectStaleRunningRecovery(pool[1], NOW).projected;
  assert("M2-02 W3 projected pending", String(projectedW3.status) === "pending");
}

// M2-03 — parity projected selector == post-recovery sort
{
  const leaseMs = resolveLeaseDurationMs();
  const hb = new Date(NOW - 120_000).toISOString();
  const exp = new Date(NOW - 1000).toISOString();
  const pool = [
    histJob(ACCOUNT_A, 4, "pending", { id: W4_ID }),
    histJob(ACCOUNT_A, 3, "running", {
      id: W3_ID,
      metadata: {
        window_index: 3,
        heartbeat_at: hb,
        lease_expires_at: exp,
        lease_owner: "hosted:vercel:abc",
        recovery_count: 0,
      },
    }),
  ];
  const sm = statusMapSalesHotDone(ACCOUNT_A);
  const dryPick = firstPick(pool, sm, NOW);
  const projected = projectPoolAfterStaleRecovery(pool, NOW).filter((r) => {
    const s = String(r.status || "").toLowerCase();
    return s === "pending" || s === "running";
  });
  const realPick = pickJobsDistinctAccounts(sortEligibleJobs(projected, sm, {}, NOW), 1)[0] ?? null;
  assert("M2-03 dry == real candidate", dryPick?.id === realPick?.id);
  assert("M2-03 candidate W3", dryPick?.id === W3_ID);
}

// M2-04 — W3 running valid lease + W4 pending → W3
{
  const hb = new Date(NOW - 30_000).toISOString();
  const exp = new Date(NOW + resolveLeaseDurationMs()).toISOString();
  const pool = [
    histJob(ACCOUNT_A, 4, "pending", { id: W4_ID }),
    histJob(ACCOUNT_A, 3, "running", {
      id: W3_ID,
      metadata: {
        window_index: 3,
        heartbeat_at: hb,
        lease_expires_at: exp,
        lease_owner: "hosted:vercel:abc",
        recovery_count: 0,
      },
    }),
  ];
  const pick = firstPick(pool, statusMapSalesHotDone(ACCOUNT_A));
  assert("M2-04 picks W3 with valid lease", pick?.id === W3_ID);
  assert("M2-04 W3 not expired", !isJobLeaseExpired(pool[1], NOW));
}

// M2-05 — W3 pending + W4 running valid lease → W4 authority; after expiry → W3
{
  const hb = new Date(NOW - 30_000).toISOString();
  const exp = new Date(NOW + resolveLeaseDurationMs()).toISOString();
  const poolValid = [
    histJob(ACCOUNT_A, 3, "pending", { id: W3_ID }),
    histJob(ACCOUNT_A, 4, "running", {
      id: W4_ID,
      metadata: {
        window_index: 4,
        heartbeat_at: hb,
        lease_expires_at: exp,
        lease_owner: "hosted:vercel:abc",
        recovery_count: 0,
      },
    }),
  ];
  const pickValid = firstPick(poolValid, statusMapSalesHotDone(ACCOUNT_A));
  assert("M2-05a W4 valid lease wins", pickValid?.id === W4_ID);

  const hbStale = new Date(NOW - 120_000).toISOString();
  const expStale = new Date(NOW - 1000).toISOString();
  const poolExpired = [
    histJob(ACCOUNT_A, 3, "pending", { id: W3_ID }),
    histJob(ACCOUNT_A, 4, "running", {
      id: W4_ID,
      metadata: {
        window_index: 4,
        heartbeat_at: hbStale,
        lease_expires_at: expStale,
        lease_owner: "hosted:vercel:abc",
        recovery_count: 0,
      },
    }),
  ];
  const pickExpired = firstPick(poolExpired, statusMapSalesHotDone(ACCOUNT_A));
  assert("M2-05b after expiry W3 wins", pickExpired?.id === W3_ID);
}

// M2-06 — W3 done + W4 pending → W4
{
  const pool = [
    histJob(ACCOUNT_A, 3, "done", { id: W3_ID }),
    histJob(ACCOUNT_A, 4, "pending", { id: W4_ID }),
  ];
  const sm = statusMapSalesHotDone(ACCOUNT_A);
  const sorted = sortEligibleJobs(pool.filter((j) => j.status !== "done"), sm, {}, NOW);
  const pick = pickJobsDistinctAccounts(sorted, 1)[0] ?? null;
  assert("M2-06 picks W4 when W3 done", pick?.id === W4_ID);
}

// M2-07 — sequential W3 → W4 → W5
{
  const sm = statusMapSalesHotDone(ACCOUNT_A);
  const base = [
    histJob(ACCOUNT_A, 3, "pending", { id: W3_ID }),
    histJob(ACCOUNT_A, 4, "pending", { id: W4_ID }),
    histJob(ACCOUNT_A, 5, "pending", { id: "w5-id" }),
  ];
  assert("M2-07a W3 first", firstPick(base, sm)?.id === W3_ID);
  const afterW3 = [
    histJob(ACCOUNT_A, 3, "done", { id: W3_ID }),
    histJob(ACCOUNT_A, 4, "pending", { id: W4_ID }),
    histJob(ACCOUNT_A, 5, "pending", { id: "w5-id" }),
  ];
  const poolAfterW3 = afterW3.filter((j) => j.status !== "done");
  assert(
    "M2-07b W4 after W3 done",
    pickJobsDistinctAccounts(sortEligibleJobs(poolAfterW3, sm, {}, NOW), 1)[0]?.id === W4_ID
  );
}

// M2-08 — two accounts limit=2
{
  const sm = { ...statusMapSalesHotDone(ACCOUNT_A), ...statusMapSalesHotDone(ACCOUNT_B) };
  const pool = [
    histJob(ACCOUNT_A, 3, "pending", { id: W3_ID }),
    histJob(ACCOUNT_B, 0, "pending", { id: "b-w0" }),
  ];
  const picks = selectJobsFromProjectedPool(pool, sm, {}, 2, NOW);
  assert("M2-08 two picks", picks.length === 2);
  assert("M2-08 includes A", picks.some((p) => p.marketplace_account_id === ACCOUNT_A));
  assert("M2-08 includes B", picks.some((p) => p.marketplace_account_id === ACCOUNT_B));
}

// M2-09 — non-historical ordering unchanged (listings before fees by pipeline step)
{
  const sm = {};
  const pool = [
    {
      id: "fees",
      marketplace_account_id: ACCOUNT_A,
      job_type: "ml_initial_fees",
      status: "pending",
      created_at: "2026-08-20T11:00:00Z",
      updated_at: "2026-08-20T11:00:00Z",
      metadata: {},
    },
    {
      id: "listings",
      marketplace_account_id: ACCOUNT_A,
      job_type: "ml_initial_listings_current",
      status: "pending",
      created_at: "2026-08-20T12:00:00Z",
      updated_at: "2026-08-20T12:00:00Z",
      metadata: {},
    },
  ];
  const sorted = sortEligibleJobs(pool, sm, {}, NOW);
  assert("M2-09 listings before fees", sorted[0]?.id === "listings");
}

// M2-10 — dry-run parity fixture
{
  const hb = new Date(NOW - resolveStaleRecoveryThresholdMs() - 5000).toISOString();
  const pool = [
    histJob(ACCOUNT_A, 4, "pending", { id: W4_ID, updated_at: "2026-08-20T20:54:01.392Z" }),
    histJob(ACCOUNT_A, 3, "running", {
      id: W3_ID,
      metadata: { window_index: 3, heartbeat_at: hb, lease_owner: "x", recovery_count: 0 },
    }),
  ];
  const sm = statusMapSalesHotDone(ACCOUNT_A);
  const a = firstPick(pool, sm, NOW)?.id;
  const projected = projectPoolAfterStaleRecovery(pool, NOW).filter((r) => {
    const s = String(r.status || "").toLowerCase();
    return s === "pending" || s === "running";
  });
  const b = pickJobsDistinctAccounts(sortEligibleJobs(projected, sm, {}, NOW), 1)[0]?.id;
  assert("M2-10 parity same job_id", a === b);
  assert("M2-10 picks W3", a === W3_ID);
}

// M2-11 — recovery não muda ordem lógica W3 antes W4
{
  const before = [
    histJob(ACCOUNT_A, 3, "running", { id: W3_ID }),
    histJob(ACCOUNT_A, 4, "pending", { id: W4_ID }),
  ];
  const after = projectPoolAfterStaleRecovery(before, NOW);
  const orderBefore = before
    .map((j) => readHistoricalWindowIndex(j))
    .filter((n) => n != null)
    .sort((a, b) => a - b);
  const orderAfter = after
    .map((j) => readHistoricalWindowIndex(j))
    .filter((n) => n != null)
    .sort((a, b) => a - b);
  assert("M2-11 order preserved", JSON.stringify(orderBefore) === JSON.stringify(orderAfter));
  assert("M2-11 compareHistorical W3<W4", compareHistoricalWindowIndex(before[0], before[1]) < 0);
}

// M2-12 — one job per account with limit=5
{
  const sm = statusMapSalesHotDone(ACCOUNT_A);
  const pool = [
    histJob(ACCOUNT_A, 3, "pending", { id: W3_ID }),
    histJob(ACCOUNT_A, 4, "pending", { id: W4_ID }),
    histJob(ACCOUNT_A, 5, "pending", { id: "w5" }),
    histJob(ACCOUNT_A, 6, "pending", { id: "w6" }),
  ];
  const picks = selectJobsFromProjectedPool(pool, sm, {}, 5, NOW);
  assert("M2-12 only one pick Insprazzo", picks.length === 1);
  assert("M2-12 pick is W3", picks[0]?.id === W3_ID);
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, tests: "M2-01..M2-12 PASS" }, null, 2));
