#!/usr/bin/env node
/**
 * CPJ2 T16 — anti-dual Daily Sales Vercel wake (matriz auth + flag).
 * Prova: deploy != cutover; GH (X-Job-Secret) nunca bloqueado pela flag Vercel.
 */
import assert from "node:assert/strict";
import {
  evaluateDailySalesWakeExecution,
  isDailySalesVercelWakeEnabled,
  resolveDailySalesWakeSource,
} from "../src/domain/notifications/central/sales/dailySalesSummaryWakePolicy.js";

// --- flag default OFF ---
assert.equal(isDailySalesVercelWakeEnabled({}), false);
assert.equal(isDailySalesVercelWakeEnabled({ DAILY_SALES_VERCEL_WAKE_ENABLED: "" }), false);
assert.equal(isDailySalesVercelWakeEnabled({ DAILY_SALES_VERCEL_WAKE_ENABLED: "0" }), false);
assert.equal(isDailySalesVercelWakeEnabled({ DAILY_SALES_VERCEL_WAKE_ENABLED: "no" }), false);
assert.equal(isDailySalesVercelWakeEnabled({ DAILY_SALES_VERCEL_WAKE_ENABLED: "1" }), true);
assert.equal(isDailySalesVercelWakeEnabled({ DAILY_SALES_VERCEL_WAKE_ENABLED: "true" }), true);

// --- wake_source ---
assert.equal(
  resolveDailySalesWakeSource({ headers: { "x-vercel-cron": "1" } }, { authMode: "cron-secret" }),
  "vercel_cron"
);
assert.equal(
  resolveDailySalesWakeSource({ headers: {} }, { authMode: "x-job-secret" }),
  "job_secret"
);
assert.equal(
  resolveDailySalesWakeSource({ headers: {} }, { authMode: "cron-secret" }),
  "cron_secret"
);

/** Matriz policy (pos-auth): origem x flag → execute */
const matrix = [
  {
    name: "vercel_valid_flag_off",
    wakeSource: "vercel_cron",
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "0" },
    execute: false,
    reason: "vercel_wake_disabled",
  },
  {
    name: "vercel_valid_flag_on",
    wakeSource: "vercel_cron",
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "1" },
    execute: true,
    reason: null,
  },
  {
    name: "cron_secret_flag_off",
    wakeSource: "cron_secret",
    env: {},
    execute: false,
    reason: "vercel_wake_disabled",
  },
  {
    name: "cron_secret_flag_on",
    wakeSource: "cron_secret",
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "1" },
    execute: true,
    reason: null,
  },
  {
    name: "gh_job_secret_flag_off",
    wakeSource: "job_secret",
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "0" },
    execute: true,
    reason: null,
  },
  {
    name: "gh_job_secret_flag_on",
    wakeSource: "job_secret",
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "1" },
    execute: true,
    reason: null,
  },
  {
    name: "gh_job_secret_flag_absent",
    wakeSource: "job_secret",
    env: {},
    execute: true,
    reason: null,
  },
];

for (const row of matrix) {
  const d = evaluateDailySalesWakeExecution({ wakeSource: row.wakeSource, env: row.env });
  assert.equal(d.execute, row.execute, row.name);
  assert.equal(d.skip_reason, row.reason, `${row.name} reason`);
}

// Double wake flag OFF: Vercel skip + GH execute → um owner efetivo
{
  const vercel = evaluateDailySalesWakeExecution({
    wakeSource: "vercel_cron",
    env: {},
  });
  const gh = evaluateDailySalesWakeExecution({
    wakeSource: "job_secret",
    env: {},
  });
  assert.equal(vercel.execute, false);
  assert.equal(gh.execute, true);
}

// Double wake flag ON: ambos execute (idempotencia do motor protege duplicidade)
{
  const env = { DAILY_SALES_VERCEL_WAKE_ENABLED: "1" };
  assert.equal(evaluateDailySalesWakeExecution({ wakeSource: "vercel_cron", env }).execute, true);
  assert.equal(evaluateDailySalesWakeExecution({ wakeSource: "job_secret", env }).execute, true);
}

console.log(
  JSON.stringify({
    ok: true,
    test: "daily_sales_vercel_wake_unit",
    cases: [
      "flag_default_off",
      "wake_source",
      "matrix_vercel_off_skip",
      "matrix_vercel_on_execute",
      "matrix_gh_always_execute",
      "double_wake_off_single_owner",
      "double_wake_on_both_allowed",
    ],
  })
);
