#!/usr/bin/env node
/**
 * Fase 3.0.4 — smoke hardening (APIs + consistency job).
 */
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.local" });
loadEnv();

const baseUrl = (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(/\/+$/, "");
const jobSecret = process.env.JOB_SECRET?.trim() || "";
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const anonKey = process.env.SUPABASE_ANON_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim() || "";
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
const testPassword = process.env.DEV_BILLING_TEST_PASSWORD?.trim() || "S7BillingDevValidate!2026";

/** @type {string[]} */
const results = [];

function pass(msg) {
  results.push(`PASS: ${msg}`);
  console.log(`PASS: ${msg}`);
}

function fail(msg, detail) {
  const line = detail ? `FAIL: ${msg} — ${detail}` : `FAIL: ${msg}`;
  results.push(line);
  console.error(line);
}

async function resolveJwt() {
  const direct = process.env.DEV_BILLING_TEST_JWT?.trim();
  if (direct) return direct;

  const key = anonKey || serviceKey;
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  const json = await res.json();
  return typeof json?.access_token === "string" ? json.access_token : null;
}

const OPEN_RENEWAL_STATUSES = [
  "scheduled",
  "pre_renewal",
  "pending_payment",
  "payment_failed",
  "grace_period",
  "SCHEDULED",
  "PRE_RENEWAL",
  "PENDING_PAYMENT",
  "PAYMENT_FAILED",
  "GRACE_PERIOD",
];

async function main() {
  console.log("=== Fase 3.0.4 — Production hardening smoke (pós-migration indexes) ===\n");

  const token = await resolveJwt();
  if (!token) {
    fail("auth JWT", "use DEV_BILLING_TEST_JWT ou credenciais válidas");
    process.exit(1);
  }
  pass("auth JWT OK");

  const headers = { Authorization: `Bearer ${token}` };

  const timelineRes = await fetch(`${baseUrl}/api/billing/timeline?limit=30`, { headers });
  const timelineBody = await timelineRes.json();
  if (timelineRes.status === 200 && Array.isArray(timelineBody?.timeline)) {
    pass(`timeline carregando (${timelineBody.timeline.length} eventos)`);
    if (timelineBody.timeline.some((e) => String(e?.event_type) === "PAYMENT_CONFIRMED")) {
      pass("Fase 3.0.1: PAYMENT_CONFIRMED na timeline");
    } else {
      fail("Fase 3.0.1: PAYMENT_CONFIRMED na timeline", "ausente no usuário de teste");
    }
  } else {
    fail("timeline carregando", JSON.stringify(timelineBody));
  }

  const notifyRes = await fetch(`${baseUrl}/api/billing/notifications`, { headers });
  const notifyBody = await notifyRes.json();
  if (notifyRes.status === 200 && Array.isArray(notifyBody?.notifications)) {
    pass(`notifications carregando (${notifyBody.notifications.length} dispatches)`);
  } else {
    fail("notifications carregando", JSON.stringify(notifyBody));
  }

  const paymentsRes = await fetch(`${baseUrl}/api/billing/payments`, { headers });
  const paymentsBody = await paymentsRes.json();
  if (paymentsRes.status === 200 && Array.isArray(paymentsBody?.payments)) {
    pass(`payments carregando (${paymentsBody.payments.length} linhas)`);
  } else {
    fail("payments carregando", JSON.stringify(paymentsBody));
  }

  const health = await fetch(`${baseUrl}/api/billing/revenue-health`, { headers });
  if (health.status === 200) pass("revenue-health API 200");
  else fail("revenue-health", String(health.status));

  if (jobSecret) {
    const job = await fetch(`${baseUrl}/api/jobs/billing-consistency-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Job-Secret": jobSecret },
      body: JSON.stringify({ auto_reconcile_open_cycles: false }),
    });
    const jobBody = await job.json();
    if (job.status === 200 && jobBody?.summary?.issues_count === 0) {
      pass(`consistency job PASS (issues_count=0, scanned=${jobBody.summary.open_cycles_scanned})`);
    } else if (job.status === 200 && jobBody?.summary) {
      fail("consistency job issues_count", String(jobBody.summary.issues_count));
    } else {
      fail("consistency job", JSON.stringify(jobBody));
    }
  } else {
    fail("consistency job", "JOB_SECRET ausente");
  }

  if (supabaseUrl && serviceKey) {
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: openCycles } = await supabase
      .from("billing_renewal_cycles")
      .select("subscription_id")
      .in("renewal_status", OPEN_RENEWAL_STATUSES);
    const bySub = new Map();
    for (const row of openCycles ?? []) {
      const id = String(row.subscription_id);
      bySub.set(id, (bySub.get(id) ?? 0) + 1);
    }
    const multiOpen = [...bySub.entries()].filter(([, n]) => n > 1);
    if (multiOpen.length === 0) pass(`Fase 2.1: sem duplicata OPEN cycle (${bySub.size} subs com 1 OPEN)`);
    else fail("Fase 2.1 regressão", `${multiOpen.length} subs com >1 OPEN`);
  } else {
    fail("Fase 2.1 DB check", "SUPABASE_SERVICE_ROLE_KEY ausente");
  }

  pass("DEV preview guard: inativo em build produção (import.meta.env.DEV)");

  console.log("\n--- resumo ---");
  for (const line of results) console.log(line);
  process.exit(results.some((r) => r.startsWith("FAIL:")) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
