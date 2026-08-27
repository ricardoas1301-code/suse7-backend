#!/usr/bin/env node
/**
 * CPJ2 T16 — matriz auth+flag do Daily Sales (auth antes da policy; motor so se execute).
 * Espelha a ordem do handler sem tocar banco/notificacao.
 */
import assert from "node:assert/strict";
import {
  evaluateDailySalesWakeExecution,
  resolveDailySalesWakeSource,
} from "../src/domain/notifications/central/sales/dailySalesSummaryWakePolicy.js";

const JOB_SECRET = "test-job-secret-daily";
const CRON_SECRET = "test-cron-secret-daily";

/**
 * Auth espelhando evaluateDailySalesSummaryJobAuth (secrets injetados).
 * @param {{ headers?: Record<string, string>; query?: Record<string, string> }} req
 * @param {{ jobSecret: string; cronSecret: string }} secrets
 */
function evaluateAuth(req, secrets) {
  const headerSecret =
    req.headers?.["x-job-secret"] != null ? String(req.headers["x-job-secret"]).trim() : "";
  const authHeader = req.headers?.authorization != null ? String(req.headers.authorization) : "";
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const cronSecretQuery =
    req.query?.cron_secret != null ? String(req.query.cron_secret).trim() : "";

  const jobSecretConfigured = secrets.jobSecret !== "";
  const cronSecretConfigured = secrets.cronSecret !== "";
  const hasJobSecretAuth = jobSecretConfigured && headerSecret === secrets.jobSecret;
  const hasCronAuth =
    cronSecretConfigured &&
    (bearerToken === secrets.cronSecret || cronSecretQuery === secrets.cronSecret);

  if (!jobSecretConfigured && !cronSecretConfigured) return { allow: true, mode: "none" };
  if (hasJobSecretAuth) return { allow: true, mode: "x-job-secret" };
  if (hasCronAuth) return { allow: true, mode: "cron-secret" };
  return { allow: false, mode: null };
}

/**
 * @param {{ headers?: Record<string, string>; query?: Record<string, string>; env?: Record<string, string> }} input
 */
function simulateHandlerGate(input) {
  const secrets = { jobSecret: JOB_SECRET, cronSecret: CRON_SECRET };
  const auth = evaluateAuth(
    { headers: input.headers ?? {}, query: input.query ?? {} },
    secrets
  );

  if (!auth.allow) {
    return { status: 401, skipped: false, motor: false, auth };
  }

  const wakeSource = resolveDailySalesWakeSource(
    { headers: input.headers ?? {} },
    { authMode: auth.mode }
  );
  const wake = evaluateDailySalesWakeExecution({
    wakeSource,
    env: input.env ?? {},
  });

  if (!wake.execute) {
    return {
      status: 200,
      skipped: true,
      reason: wake.skip_reason,
      wake_source: wakeSource,
      motor: false,
      auth,
    };
  }

  return { status: 200, skipped: false, wake_source: wakeSource, motor: true, auth };
}

const cases = [
  {
    name: "vercel_valid_flag_off_skip",
    headers: { authorization: `Bearer ${CRON_SECRET}`, "x-vercel-cron": "1" },
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "0" },
    expect: { status: 200, skipped: true, motor: false },
  },
  {
    name: "vercel_valid_flag_on_process",
    headers: { authorization: `Bearer ${CRON_SECRET}`, "x-vercel-cron": "1" },
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "1" },
    expect: { status: 200, skipped: false, motor: true },
  },
  {
    name: "vercel_invalid_flag_off_401",
    headers: { authorization: "Bearer wrong", "x-vercel-cron": "1" },
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "0" },
    expect: { status: 401, skipped: false, motor: false },
  },
  {
    name: "vercel_invalid_flag_on_401",
    headers: { authorization: "Bearer wrong", "x-vercel-cron": "1" },
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "1" },
    expect: { status: 401, skipped: false, motor: false },
  },
  {
    name: "spoof_vercel_header_no_secret_401",
    headers: { "x-vercel-cron": "1" },
    env: {},
    expect: { status: 401, skipped: false, motor: false },
  },
  {
    name: "gh_valid_flag_off_process",
    headers: { "x-job-secret": JOB_SECRET },
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "0" },
    expect: { status: 200, skipped: false, motor: true },
  },
  {
    name: "gh_valid_flag_on_process",
    headers: { "x-job-secret": JOB_SECRET },
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "1" },
    expect: { status: 200, skipped: false, motor: true },
  },
  {
    name: "gh_invalid_any_flag_401",
    headers: { "x-job-secret": "nope" },
    env: { DAILY_SALES_VERCEL_WAKE_ENABLED: "1" },
    expect: { status: 401, skipped: false, motor: false },
  },
  {
    name: "missing_secret_401",
    headers: {},
    env: {},
    expect: { status: 401, skipped: false, motor: false },
  },
];

for (const c of cases) {
  const out = simulateHandlerGate(c);
  assert.equal(out.status, c.expect.status, c.name);
  assert.equal(Boolean(out.skipped), c.expect.skipped, `${c.name} skipped`);
  assert.equal(out.motor, c.expect.motor, `${c.name} motor`);
}

{
  const gh = simulateHandlerGate({
    headers: { "x-job-secret": JOB_SECRET },
    env: {},
  });
  const vz = simulateHandlerGate({
    headers: { authorization: `Bearer ${CRON_SECRET}`, "x-vercel-cron": "1" },
    env: {},
  });
  assert.equal(gh.motor, true, "GH owner com flag OFF");
  assert.equal(vz.skipped, true, "Vercel skip com flag OFF");
  assert.equal(vz.motor, false);
}

console.log(
  JSON.stringify({
    ok: true,
    test: "daily_sales_vercel_wake_auth_matrix_unit",
    cases: cases.map((c) => c.name),
    double_wake_off_single_owner: true,
  })
);
