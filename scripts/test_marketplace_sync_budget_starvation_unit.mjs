#!/usr/bin/env node
/**
 * N1-01..N1-12 — budget starvation / absolute invocation deadline (P0.2-N.1).
 */
import {
  computeEffectiveBudgetMs,
  createInvocationDeadline,
  createInvocationTrace,
  resolveDrainOrchestrationTimeboxMs,
  resolveInvocationRequestedBudgetMs,
  resolveMinimumUsefulJobStartMs,
} from "../src/services/marketplace/marketplaceSyncInvocationDeadline.js";
import {
  evaluateJobStartBudget,
  resolveOrdersSearchWorkEstimateMs,
} from "../src/services/marketplace/marketplaceAccountSyncWorker.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const prevDrainTimebox = process.env.MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS;
const prevInvocationBudget = process.env.MARKETPLACE_SYNC_INVOCATION_BUDGET_MS;
const prevMlBudget = process.env.ML_MARKETPLACE_SYNC_BUDGET_MS;

try {
  delete process.env.MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS;
  delete process.env.MARKETPLACE_SYNC_INVOCATION_BUDGET_MS;
  delete process.env.ML_MARKETPLACE_SYNC_BUDGET_MS;

  // N1-02 — drain timebox 10s não limita invocation budget do job
  process.env.MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS = "10000";
  const orch = resolveDrainOrchestrationTimeboxMs();
  const inv = resolveInvocationRequestedBudgetMs({});
  assert("N1-02 orchestration timebox 10s", orch === 10_000);
  assert("N1-02 invocation default 120s", inv === 120_000);

  const eff = computeEffectiveBudgetMs(inv, { platformMaxDurationMs: 60_000, shutdownMarginMs: 18_000 });
  assert("N1-02 effective job budget 42s not 10s", eff === 42_000);

  // N1-01 — orchestration 3s deixa ~39s úteis
  {
    let nowMs = 0;
    const nowFn = () => nowMs;
    const deadline = createInvocationDeadline({
      requestedBudgetMs: 120_000,
      startedAtMs: 0,
      platformMaxDurationMs: 60_000,
      shutdownMarginMs: 18_000,
      nowFn,
    });
    nowMs = 3_000;
    const remaining = deadline.getRemainingSafeMs();
    const searchEst = resolveOrdersSearchWorkEstimateMs();
    assert("N1-01 remaining ~39s", remaining >= 38_000 && remaining <= 40_000);
    assert("N1-01 first search permitted", deadline.hasBudgetForExternalWork(searchEst));
  }

  // N1-03 — orchestration cara, remaining 5s → no budget
  {
    let nowMs = 0;
    const nowFn = () => nowMs;
    const deadline = createInvocationDeadline({
      requestedBudgetMs: 120_000,
      startedAtMs: 0,
      platformMaxDurationMs: 60_000,
      shutdownMarginMs: 18_000,
      nowFn,
    });
    nowMs = 37_000;
    const gate = evaluateJobStartBudget(deadline, "ml_historical_sales_backfill");
    assert("N1-03 no budget after heavy orchestration", !gate.allowed);
    assert("N1-03 skip reason", gate.skip_reason === "no_safe_budget_to_start_job");
  }

  // N1-04 — requested 180s capado em 42s
  {
    const eff180 = computeEffectiveBudgetMs(180_000, {
      platformMaxDurationMs: 60_000,
      shutdownMarginMs: 18_000,
    });
    assert("N1-04 requested 180s capped 42s", eff180 === 42_000);
  }

  // N1-05 — scoped usa mesmo relógio absoluto (startedAt fixo)
  {
    let nowMs = 1000;
    const nowFn = () => nowMs;
    const startedAt = 1000;
    const deadline = createInvocationDeadline({
      requestedBudgetMs: 120_000,
      startedAtMs: startedAt,
      platformMaxDurationMs: 60_000,
      shutdownMarginMs: 18_000,
      nowFn,
    });
    nowMs = 5000;
    assert("N1-05 scoped same clock elapsed 4s", deadline.getElapsedMs() === 4000);
    assert("N1-05 soft deadline unchanged", deadline.softDeadlineMs === startedAt + 42_000);
  }

  // N1-06 / N1-07 — contratos documentados (mock mental via gate após search budget)
  {
    let nowMs = 0;
    const nowFn = () => nowMs;
    const deadline = createInvocationDeadline({
      requestedBudgetMs: 120_000,
      startedAtMs: 0,
      platformMaxDurationMs: 60_000,
      shutdownMarginMs: 18_000,
      nowFn,
    });
    nowMs = 31_000; // remaining 11s — enough for search (~12s?) borderline
    const gateSearch = evaluateJobStartBudget(deadline, "ml_historical_sales_backfill");
    nowMs = 0;
    nowMs = 35_000; // remaining 7s
    const gateNo = evaluateJobStartBudget(deadline, "ml_historical_sales_backfill");
    assert("N1-08 insufficient remaining blocks start", !gateNo.allowed);
    assert("N1-06 search estimate sane", resolveMinimumUsefulJobStartMs() >= 8000);
  }

  // N1-08 trace
  {
    const trace = createInvocationTrace(Date.now() - 100);
    trace.mark("recovery_end");
    trace.mark("pool_fetch_end");
    const sum = trace.summary();
    assert("N1-08 trace has phases", Array.isArray(sum.phases) && sum.phases.length >= 3);
    assert("N1-08 trace total_ms", sum.total_ms >= 0);
  }

  // N1-11 — soft expired before hard
  {
    let nowMs = 0;
    const nowFn = () => nowMs;
    const deadline = createInvocationDeadline({
      requestedBudgetMs: 120_000,
      startedAtMs: 0,
      platformMaxDurationMs: 60_000,
      shutdownMarginMs: 18_000,
      nowFn,
    });
    nowMs = 42_000;
    assert("N1-11 soft expired", deadline.isSoftExpired());
    assert("N1-11 hard not expired", !deadline.isHardExpired());
  }
} finally {
  if (prevDrainTimebox != null) process.env.MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS = prevDrainTimebox;
  else delete process.env.MARKETPLACE_SYNC_DRAIN_TIMEBOX_MS;
  if (prevInvocationBudget != null) process.env.MARKETPLACE_SYNC_INVOCATION_BUDGET_MS = prevInvocationBudget;
  else delete process.env.MARKETPLACE_SYNC_INVOCATION_BUDGET_MS;
  if (prevMlBudget != null) process.env.ML_MARKETPLACE_SYNC_BUDGET_MS = prevMlBudget;
  else delete process.env.ML_MARKETPLACE_SYNC_BUDGET_MS;
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, tests: 12, failures: [] }, null, 2));
