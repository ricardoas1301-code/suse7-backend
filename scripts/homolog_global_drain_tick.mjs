#!/usr/bin/env node
/**
 * P0.2-M — UM tick global controlado: POST /api/jobs/marketplace-account-sync?limit=1
 * Requer dry-run PASS e JOB_SECRET em .env.local.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";
import { simulateGlobalSchedulerSelection } from "../src/services/marketplace/marketplaceAccountSyncWorker.js";

const WINDOW3_ID = "8f08e2c5-52ab-4e0d-b804-babf9feef6ef";
const INSPRAZZO_ACCOUNT = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
const limit = parseInt(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || "1", 10);
const backendBase =
  process.argv.find((a) => a.startsWith("--backend="))?.split("=")[1] || "https://suse7-backend-dev.vercel.app";
const pollMs = parseInt(process.argv.find((a) => a.startsWith("--poll-ms="))?.split("=")[1] || "5000", 10);
const pollDurationMs = parseInt(
  process.argv.find((a) => a.startsWith("--poll-duration-ms="))?.split("=")[1] || "35000",
  10
);
const force = process.argv.includes("--force");

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
  console.error(JSON.stringify({ ok: false, error: "job_secret_missing" }));
  process.exit(3);
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function snapJob(id) {
  const { data } = await sb.from("marketplace_account_sync_jobs").select("*").eq("id", id).maybeSingle();
  if (!data) return null;
  const m = readJobMetadataObject(data);
  return {
    at: new Date().toISOString(),
    job_id: data.id,
    status: data.status,
    progress: `${data.progress_current ?? 0}/${data.progress_total ?? "?"}`,
    progress_current: data.progress_current ?? 0,
    progress_total: data.progress_total ?? null,
    last_cursor: data.last_cursor ?? null,
    updated_at: data.updated_at,
    window_index: m.window_index ?? null,
    lease_owner: m.lease_owner ?? null,
    lease_version: m.lease_version ?? null,
    lease_claimed_at: m.lease_claimed_at ?? null,
    lease_expires_at: m.lease_expires_at ?? null,
    heartbeat_at: m.heartbeat_at ?? null,
    recovery_count: m.recovery_count ?? 0,
    runtime_env: m.runtime_env ?? null,
  };
}

const dryRun = await simulateGlobalSchedulerSelection(sb, { limit });
const predicted = dryRun.picks[0] ?? null;

if (!predicted) {
  console.error(JSON.stringify({ ok: false, error: "no_eligible_candidate", dry_run: dryRun }));
  process.exit(4);
}

if (limit === 1 && predicted.job_id !== WINDOW3_ID && !force) {
  console.error(
    JSON.stringify({
      ok: false,
      error: "gate_blocked_unexpected_candidate",
      predicted_job_id: predicted.job_id,
      expected: WINDOW3_ID,
      hint: "Use --force to override (not recommended)",
    })
  );
  process.exit(5);
}

const tickLabel = process.argv.find((a) => a.startsWith("--label="))?.split("=")[1] || "tick";

const watchIds = [
  predicted.job_id,
  WINDOW3_ID,
  ...(dryRun.picks.slice(1).map((p) => p.job_id) ?? []),
].filter(Boolean);
const uniqueWatch = [...new Set(watchIds)];

const before = {};
for (const id of uniqueWatch) before[id] = await snapJob(id);

const polls = [];
const pollTimer = setInterval(async () => {
  try {
    const row = await snapJob(predicted.job_id);
    if (row) polls.push(row);
  } catch {
    /* ignore */
  }
}, pollMs);

const url = `${backendBase.replace(/\/+$/, "")}/api/jobs/marketplace-account-sync?limit=${limit}`;
const t0 = Date.now();
let httpStatus = 0;
/** @type {unknown} */
let responseBody = null;
try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Job-Secret": jobSecret,
    },
    body: JSON.stringify({ limit }),
  });
  httpStatus = res.status;
  const text = await res.text();
  try {
    responseBody = JSON.parse(text);
  } catch {
    responseBody = { raw: text.slice(0, 2000) };
  }
} catch (e) {
  clearInterval(pollTimer);
  console.error(JSON.stringify({ ok: false, error: "fetch_failed", message: e?.message ?? String(e) }));
  process.exit(6);
}

await new Promise((r) => setTimeout(r, pollDurationMs));
clearInterval(pollTimer);
polls.push(await snapJob(predicted.job_id));

const after = {};
for (const id of uniqueWatch) after[id] = await snapJob(id);

const postTickSim = await simulateGlobalSchedulerSelection(sb, { limit: 1 });

const actualChunk = Array.isArray(responseBody?.chunks) ? responseBody.chunks[0] : null;
const actualJobId = actualChunk?.job_id ?? responseBody?.job_id ?? null;

const report = {
  generated_at: new Date().toISOString(),
  mission: "P0.2-M.1",
  tick_label: tickLabel,
  backend: backendBase,
  limit,
  http_status: httpStatus,
  elapsed_ms: Date.now() - t0,
  dry_run_predicted: predicted,
  actual_response_summary: {
    ok: responseBody?.ok ?? null,
    chunks_processed: responseBody?.chunks_processed ?? null,
    chunks_len: Array.isArray(responseBody?.chunks) ? responseBody.chunks.length : null,
    first_chunk_job_id: actualJobId,
    worker_opts: responseBody?.worker_opts ?? null,
  },
  match_predicted_vs_actual: predicted.job_id === actualJobId,
  before,
  after,
  heartbeat_polls: polls,
  post_tick_dry_run_limit_1: postTickSim.picks[0] ?? null,
  insprazzo_account: INSPRAZZO_ACCOUNT,
};

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outPath = path.join(outDir, `HOMOLOG_GLOBAL_DRAIN_${tickLabel}_${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(
  JSON.stringify(
    {
      ok: httpStatus >= 200 && httpStatus < 300,
      out_path: outPath,
      predicted_job_id: predicted.job_id,
      actual_job_id: actualJobId,
      match: predicted.job_id === actualJobId,
      http_status: httpStatus,
    },
    null,
    2
  )
);

if (predicted.job_id !== actualJobId) process.exit(7);
if (httpStatus < 200 || httpStatus >= 300) process.exit(8);
