#!/usr/bin/env node
/**
 * TIME-01..TIME-10 — soft deadline serverless marketplace sync.
 */
import {
  computeEffectiveBudgetMs,
  createInvocationDeadline,
  resolveMinExternalWorkMs,
  resolvePlatformMaxDurationMs,
  resolveShutdownMarginMs,
} from "../src/services/marketplace/marketplaceSyncInvocationDeadline.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

let nowMs = 0;
const nowFn = () => nowMs;

// TIME-02 — budget menor vence
{
  const eff = computeEffectiveBudgetMs(20_000, { platformMaxDurationMs: 60_000, shutdownMarginMs: 18_000 });
  assert("TIME-02 effective 20s", eff === 20_000);
}

// TIME-03 — budget maior capado pelo platform-safe (60-18=42)
{
  const eff = computeEffectiveBudgetMs(180_000, { platformMaxDurationMs: 60_000, shutdownMarginMs: 18_000 });
  assert("TIME-03 effective capped 42s", eff === 42_000);
}

// TIME-01 — ao atingir soft deadline, não inicia nova external work
{
  nowMs = 0;
  const deadline = createInvocationDeadline({
    requestedBudgetMs: 40_000,
    startedAtMs: 0,
    platformMaxDurationMs: 60_000,
    shutdownMarginMs: 20_000,
    nowFn,
  });
  nowMs = 40_000;
  assert("TIME-01 soft expired", deadline.isSoftExpired());
  assert("TIME-01 block external at soft", deadline.shouldStopBeforeNextExternalWork(8000));
}

// TIME-04 — remaining insuficiente bloqueia external
{
  nowMs = 0;
  const deadline = createInvocationDeadline({
    requestedBudgetMs: 45_000,
    startedAtMs: 0,
    platformMaxDurationMs: 60_000,
    shutdownMarginMs: 18_000,
    nowFn,
  });
  nowMs = 38_000; // remaining soft 4s (< min external 8s default)
  assert("TIME-04 block external near end", deadline.shouldStopBeforeNextExternalWork(resolveMinExternalWorkMs()));
}

// TIME-05 — backoff maior que remaining → não dormir
{
  nowMs = 0;
  const deadline = createInvocationDeadline({
    requestedBudgetMs: 40_000,
    startedAtMs: 0,
    platformMaxDurationMs: 60_000,
    shutdownMarginMs: 20_000,
    nowFn,
  });
  nowMs = 35_000; // remaining soft 5s
  assert("TIME-05 disallow 10s backoff", !deadline.shouldAllowBackoffSleep(10_000));
  assert("TIME-05 allow 3s backoff", deadline.shouldAllowBackoffSleep(3_000));
}

// TIME-06 — operação em andamento: guard de início bloqueia nova work
{
  nowMs = 0;
  const deadline = createInvocationDeadline({
    requestedBudgetMs: 42_000,
    startedAtMs: 0,
    platformMaxDurationMs: 60_000,
    shutdownMarginMs: 18_000,
    nowFn,
  });
  nowMs = 41_500;
  assert("TIME-06 block new 12s work", deadline.shouldStopBeforeNextExternalWork(12_000));
}

// TIME-07 — snapshot preserva campos de deadline
{
  nowMs = 10_000;
  const deadline = createInvocationDeadline({
    requestedBudgetMs: 45_000,
    startedAtMs: 0,
    platformMaxDurationMs: 60_000,
    shutdownMarginMs: 18_000,
    nowFn,
  });
  const snap = deadline.snapshot();
  assert("TIME-07 snapshot soft deadline", snap.soft_deadline_at === new Date(42_000).toISOString());
  assert("TIME-07 snapshot remaining", snap.remaining_soft_ms === 32_000);
}

// TIME-08 — retomada: effective budget estável entre invocations
{
  const a = computeEffectiveBudgetMs(45_000, { platformMaxDurationMs: 60_000, shutdownMarginMs: 18_000 });
  const b = computeEffectiveBudgetMs(45_000, { platformMaxDurationMs: 60_000, shutdownMarginMs: 18_000 });
  assert("TIME-08 stable effective budget", a === b && a === 42_000);
}

// TIME-09 — defaults sane
{
  assert("TIME-09 min external default sane", resolveMinExternalWorkMs() >= 1000);
  assert("TIME-09 platform max default 60s", resolvePlatformMaxDurationMs() === 60_000);
  assert("TIME-09 shutdown margin default 18s", resolveShutdownMarginMs() === 18_000);
}

// TIME-10 — soft yield antes do hard deadline
{
  nowMs = 0;
  const deadline = createInvocationDeadline({
    requestedBudgetMs: 45_000,
    startedAtMs: 0,
    platformMaxDurationMs: 60_000,
    shutdownMarginMs: 18_000,
    nowFn,
  });
  nowMs = 42_000;
  assert("TIME-10 soft expired before hard", deadline.isSoftExpired() && !deadline.isHardExpired());
  assert("TIME-10 hard still has margin", deadline.getRemainingHardMs() === 18_000);
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, tests: 10, failures: [] }, null, 2));
