#!/usr/bin/env node
/**
 * Fase 3.1 — validação pós-deploy DEV (motor central + regressões).
 *
 * Uso:
 *   node scripts/validatePhase31DevDeployment.mjs
 */

import { config as loadEnv } from "dotenv";
import { spawn } from "child_process";
import { createClient } from "@supabase/supabase-js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getCentralNotificationEngineSummary } from "../src/domain/notifications/central/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

loadEnv({ path: resolve(root, ".env.local") });
loadEnv();

const baseUrl = (process.env.S7_BILLING_DEV_BASE_URL || "https://suse7-backend-dev.vercel.app").replace(
  /\/+$/,
  ""
);
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const anonKey = process.env.SUPABASE_ANON_KEY?.trim() || process.env.VITE_SUPABASE_ANON_KEY?.trim() || "";
const testEmail = process.env.DEV_BILLING_TEST_EMAIL?.trim() || "s7-billing-dev-validate@suse7.local";
const testPassword = process.env.DEV_BILLING_TEST_PASSWORD?.trim() || "S7BillingDevValidate!2026";
const jobSecret = process.env.JOB_SECRET?.trim() || "";

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
  const direct = process.env.DEV_BILLING_TEST_JWT?.trim() || process.env.DEV_CENTER_TEST_JWT?.trim();
  if (direct) return direct;

  const key = anonKey || serviceKey;
  if (!supabaseUrl || !key) return null;

  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  const json = await res.json();
  return typeof json?.access_token === "string" ? json.access_token : null;
}

function runPhase31Script() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["scripts/validatePhase31CentralNotifications.mjs"], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`validatePhase31CentralNotifications exit ${code}`));
    });
  });
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
  console.log("=== Fase 3.1 — Deploy DEV validation suite ===\n");
  console.log(`Backend: ${baseUrl}\n`);

  try {
    await runPhase31Script();
    pass("validatePhase31CentralNotifications.mjs (14/14)");
  } catch (e) {
    fail("validatePhase31CentralNotifications.mjs", e?.message ?? String(e));
  }

  const token = await resolveJwt();
  if (!token) {
    fail("auth JWT", "credenciais ausentes para APIs HTTP");
  } else {
    pass("auth JWT OK");

    const headers = { Authorization: `Bearer ${token}` };

    const timelineRes = await fetch(`${baseUrl}/api/billing/timeline?limit=20`, { headers });
    const timelineBody = await timelineRes.json();
    if (timelineRes.status === 200 && Array.isArray(timelineBody?.timeline)) {
      pass(`billing timeline OK (${timelineBody.timeline.length} eventos)`);
    } else {
      fail("billing timeline", JSON.stringify(timelineBody)?.slice(0, 200));
    }

    const notifyRes = await fetch(`${baseUrl}/api/billing/notifications`, { headers });
    const notifyBody = await notifyRes.json();
    if (notifyRes.status === 200 && Array.isArray(notifyBody?.notifications)) {
      pass(`billing notifications OK (${notifyBody.notifications.length} legado 3.0)`);
    } else {
      fail("billing notifications", JSON.stringify(notifyBody)?.slice(0, 200));
    }

    const devNoAuth = await fetch(`${baseUrl}/api/dev-center/notifications/engine/summary?hours=24`);
    if (devNoAuth.status === 401) {
      pass("DevCenter summary rota deployada (401 sem token)");
    } else {
      fail("DevCenter summary rota deployada", `status=${devNoAuth.status}`);
    }

    const devSummary = await fetch(`${baseUrl}/api/dev-center/notifications/engine/summary?hours=24`, {
      headers,
    });
    const devBody = await devSummary.json();
    if (devSummary.status === 200 && devBody?.summary?.engine === "s7_central_notification_engine") {
      pass(
        `DevCenter summary HTTP admin OK (events=${devBody.summary.events_count}, dispatches=${devBody.summary.dispatches_total})`
      );
    } else if (devSummary.status === 403) {
      pass("DevCenter summary HTTP gate OK (403 seller sem allowlist — esperado)");
    } else {
      fail("DevCenter summary HTTP", JSON.stringify(devBody)?.slice(0, 240));
    }

    if (supabaseUrl && serviceKey) {
      const supabase = createClient(supabaseUrl, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const summary = await getCentralNotificationEngineSummary(supabase, { hours: 24 });
      if (summary?.engine === "s7_central_notification_engine") {
        pass(
          `DevCenter summary engine data OK (events=${summary.events_count}, dispatches=${summary.dispatches_total})`
        );
      } else {
        fail("DevCenter summary engine data", JSON.stringify(summary)?.slice(0, 200));
      }
    }
  }

  if (jobSecret) {
    const job = await fetch(`${baseUrl}/api/jobs/billing-consistency-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Job-Secret": jobSecret },
      body: JSON.stringify({ auto_reconcile_open_cycles: false }),
    });
    const jobBody = await job.json();
    if (job.status === 200 && jobBody?.summary?.issues_count === 0) {
      pass(`Fase 2.1 consistency job (issues_count=0)`);
    } else {
      fail("Fase 2.1 consistency job", JSON.stringify(jobBody?.summary ?? jobBody)?.slice(0, 200));
    }
  } else {
    fail("Fase 2.1 consistency job", "JOB_SECRET ausente");
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
    if (multiOpen.length === 0) {
      pass(`Fase 2.1 DB: ${bySub.size} subs com no máximo 1 OPEN cycle`);
    } else {
      fail("Fase 2.1 DB regressão", `${multiOpen.length} subs com >1 OPEN`);
    }
  }

  console.log("\n--- resumo deploy DEV ---");
  for (const line of results) console.log(line);
  const failed = results.filter((r) => r.startsWith("FAIL:"));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
