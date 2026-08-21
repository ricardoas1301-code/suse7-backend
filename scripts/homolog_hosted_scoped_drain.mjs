#!/usr/bin/env node
/**
 * Trigger scoped drain no DEV Hosted via POST /api/jobs/marketplace-account-sync?job_id=...
 * Requer JOB_SECRET / DEV_JOB_SECRET em .env.local (não logar).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";

const JOB_ID = process.argv[2];
const budgetMs = parseInt(process.argv.find((a) => a.startsWith("--budget-ms="))?.split("=")[1] || "180000", 10);
const pollMs = parseInt(process.argv.find((a) => a.startsWith("--poll-ms="))?.split("=")[1] || "8000", 10);
const backendBase = process.argv.find((a) => a.startsWith("--backend="))?.split("=")[1] || "https://suse7-backend-dev.vercel.app";

if (!JOB_ID) {
  console.error("usage: homolog_hosted_scoped_drain.mjs <job_id> [--budget-ms=180000] [--backend=URL]");
  process.exit(1);
}

const INSPRAZZO_ACCOUNT = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
const WINDOW2_ID = "fc2ee91d-1700-4aaa-87f2-91a8e12a9cdf";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "..", "scripts", "output");

function parseEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const env = { ...parseEnvFile(path.join(root, ".env.local")), ...parseEnvFile(path.join(root, ".env.vercel")), ...process.env };
const jobSecret = env.JOB_SECRET || env.DEV_JOB_SECRET || env.S7_DEV_JOB_SECRET || "";
if (!jobSecret) {
  console.error(JSON.stringify({ ok: false, error: "job_secret_missing_in_env" }));
  process.exit(3);
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function snap(id) {
  const { data } = await sb.from("marketplace_account_sync_jobs").select("*").eq("id", id).maybeSingle();
  const m = readJobMetadataObject(data);
  return {
    at: new Date().toISOString(),
    status: data?.status,
    progress: `${data?.progress_current ?? 0}/${data?.progress_total ?? "?"}`,
    progress_current: data?.progress_current ?? 0,
    last_cursor: data?.last_cursor ?? null,
    updated_at: data?.updated_at,
    window_index: m.window_index ?? null,
    date_from: m.date_from ?? null,
    date_to: m.date_to ?? null,
    lease_owner: m.lease_owner ?? null,
    lease_claimed_at: m.lease_claimed_at ?? null,
    lease_expires_at: m.lease_expires_at ?? null,
    heartbeat_at: m.heartbeat_at ?? null,
    lease_version: m.lease_version ?? null,
    recovery_count: m.recovery_count ?? 0,
    runtime_env: m.runtime_env ?? null,
  };
}

async function salesSnap(accountId) {
  const { data: rows } = await sb
    .from("sales_orders")
    .select("external_order_id")
    .eq("marketplace_account_id", accountId);
  const ids = (rows || []).map((r) => String(r.external_order_id || "").trim()).filter(Boolean);
  const dup = {};
  for (const id of ids) dup[id] = (dup[id] || 0) + 1;
  return { total: ids.length, unique: new Set(ids).size, duplicate_logical_groups: Object.values(dup).filter((c) => c > 1).length };
}

const before = await snap(JOB_ID);
const salesBefore = await salesSnap(INSPRAZZO_ACCOUNT);
const window2Before = await snap(WINDOW2_ID);

/** @type {Awaited<ReturnType<typeof snap>>[]} */
const polls = [];
const pollTimer = setInterval(async () => {
  try {
    polls.push(await snap(JOB_ID));
  } catch {
    /* ignore */
  }
}, pollMs);

const url = `${backendBase.replace(/\/$/, "")}/api/jobs/marketplace-account-sync?job_id=${encodeURIComponent(JOB_ID)}&budget_ms=${budgetMs}`;
const started = Date.now();
let httpRes;
let httpBody;
try {
  httpRes = await fetch(url, {
    method: "POST",
    headers: { "X-Job-Secret": jobSecret, "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: JOB_ID, budget_ms: budgetMs }),
  });
  httpBody = await httpRes.json().catch(() => ({}));
} catch (e) {
  clearInterval(pollTimer);
  console.error(JSON.stringify({ ok: false, error: e?.message ?? String(e) }, null, 2));
  process.exit(2);
}
clearInterval(pollTimer);

const after = await snap(JOB_ID);
const salesAfter = await salesSnap(INSPRAZZO_ACCOUNT);
const window2After = await snap(WINDOW2_ID);

const hb = [before, ...polls, after].filter((p) => p.heartbeat_at).map((p) => ({
  at: p.at,
  heartbeat_at: p.heartbeat_at,
  lease_owner: p.lease_owner,
  lease_version: p.lease_version,
}));
const hbUnique = [];
for (const h of hb) {
  if (!hbUnique.length || hbUnique[hbUnique.length - 1].heartbeat_at !== h.heartbeat_at) hbUnique.push(h);
}

const report = {
  generated_at: new Date().toISOString(),
  backend_base: backendBase,
  job_id: JOB_ID,
  http_status: httpRes.status,
  http_ok: httpRes.ok,
  http_body_summary: {
    ok: httpBody?.ok,
    executor_id: httpBody?.executor_id ?? null,
    claim_lease_owner: httpBody?.claim?.lease_owner ?? null,
    progress_current: httpBody?.progress_current ?? null,
    drain_done: httpBody?.drain_out?.done ?? null,
    yielded: httpBody?.yielded ?? null,
    yield_reason: httpBody?.yield_reason ?? null,
    effective_budget_ms: httpBody?.invocation_deadline?.effective_budget_ms ?? null,
    remaining_soft_ms: httpBody?.invocation_deadline?.remaining_soft_ms ?? null,
  },
  duration_ms: Date.now() - started,
  before,
  polls,
  after,
  heartbeat_sequence: hbUnique,
  sales_before: salesBefore,
  sales_after: salesAfter,
  window2_before: window2Before,
  window2_after: window2After,
};

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `HOSTED_SCOPED_DRAIN_${JOB_ID.slice(0, 8)}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

const leaseHosted =
  (after.lease_owner && !String(after.lease_owner).startsWith("local:")) ||
  (httpBody?.claim?.lease_owner && !String(httpBody.claim.lease_owner).startsWith("local:")) ||
  (before.status === "pending" && after.progress_current > before.progress_current);
const pass =
  httpRes.ok &&
  after.progress_current >= before.progress_current &&
  window2After.updated_at === window2Before.updated_at &&
  window2After.status === window2Before.status &&
  salesAfter.duplicate_logical_groups === 0;

console.log(JSON.stringify({ ok: pass, leaseHosted, output: outFile, before, after, http_status: httpRes.status }, null, 2));
process.exit(pass ? 0 : 2);
