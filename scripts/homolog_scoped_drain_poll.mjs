#!/usr/bin/env node
/**
 * Drain scoped com polling paralelo — heartbeat t1/t2, progresso, cursor.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { runScopedMarketplaceSyncJobDrain } from "../src/services/marketplace/marketplaceAccountSyncWorker.js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";

const JOB_ID = process.argv[2];
const budgetArg = process.argv.find((a) => a.startsWith("--budget-ms="));
const pollArg = process.argv.find((a) => a.startsWith("--poll-ms="));
const budgetMs = budgetArg ? parseInt(budgetArg.split("=")[1], 10) : 180000;
const pollMs = pollArg ? parseInt(pollArg.split("=")[1], 10) : 8000;

if (!JOB_ID) {
  console.error("usage: homolog_scoped_drain_poll.mjs <job_id> [--budget-ms=180000] [--poll-ms=8000]");
  process.exit(1);
}

process.env.ML_SYNC_EXECUTOR_ID = process.env.ML_SYNC_EXECUTOR_ID || "local:homolog-p0.2:manual";

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

const env = { ...parseEnvFile(path.join(root, ".env.local")), ...process.env };
for (const [k, v] of Object.entries(parseEnvFile(path.join(root, ".env.local")))) {
  if (v != null && String(v).trim() !== "") process.env[k] = v;
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
    progress_total: data?.progress_total ?? null,
    last_cursor: data?.last_cursor ?? null,
    updated_at: data?.updated_at,
    lease_owner: m.lease_owner ?? null,
    lease_claimed_at: m.lease_claimed_at ?? null,
    lease_expires_at: m.lease_expires_at ?? null,
    heartbeat_at: m.heartbeat_at ?? null,
    lease_version: m.lease_version ?? null,
    recovery_count: m.recovery_count ?? 0,
    metadata_keys: Object.keys(m).sort(),
  };
}

async function salesIdempotency(accountId) {
  const { data: rows } = await sb
    .from("sales_orders")
    .select("external_order_id")
    .eq("marketplace_account_id", accountId);
  const ids = (rows || []).map((r) => String(r.external_order_id || "").trim()).filter(Boolean);
  const unique = new Set(ids);
  const dupGroups = {};
  for (const id of ids) dupGroups[id] = (dupGroups[id] || 0) + 1;
  const logicalDups = Object.values(dupGroups).filter((c) => c > 1).length;
  return { total: ids.length, unique: unique.size, duplicate_logical_groups: logicalDups };
}

const { data: jobRow } = await sb.from("marketplace_account_sync_jobs").select("marketplace_account_id").eq("id", JOB_ID).maybeSingle();
const accountId = String(jobRow?.marketplace_account_id || "");

const before = await snap(JOB_ID);
const salesBefore = accountId ? await salesIdempotency(accountId) : null;

/** @type {Awaited<ReturnType<typeof snap>>[]} */
const polls = [];
let pollTimer = null;
const pollLoop = setInterval(async () => {
  try {
    polls.push(await snap(JOB_ID));
  } catch {
    /* ignore transient poll errors */
  }
}, pollMs);

const drainPromise = runScopedMarketplaceSyncJobDrain(sb, JOB_ID, { budgetMs });

let result;
try {
  result = await drainPromise;
} finally {
  clearInterval(pollLoop);
  if (pollTimer) clearTimeout(pollTimer);
}

const after = await snap(JOB_ID);
const salesAfter = accountId ? await salesIdempotency(accountId) : null;

const heartbeats = [before, ...polls, after]
  .filter((s) => s.heartbeat_at)
  .map((s) => ({ at: s.at, heartbeat_at: s.heartbeat_at, lease_owner: s.lease_owner, lease_version: s.lease_version }));

const hbUnique = [];
for (const h of heartbeats) {
  if (!hbUnique.length || hbUnique[hbUnique.length - 1].heartbeat_at !== h.heartbeat_at) hbUnique.push(h);
}

const report = {
  generated_at: new Date().toISOString(),
  executor_id: process.env.ML_SYNC_EXECUTOR_ID,
  job_id: JOB_ID,
  marketplace_account_id: accountId,
  budget_ms: budgetMs,
  poll_ms: pollMs,
  before,
  polls,
  after,
  drain_result: result,
  heartbeat_sequence: hbUnique,
  sales_before: salesBefore,
  sales_after: salesAfter,
};

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `SCOPED_DRAIN_POLL_${JOB_ID.slice(0, 8)}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

const progressAdvanced = (after.progress_current ?? 0) > (before.progress_current ?? 0);
const heartbeatAdvanced =
  hbUnique.length >= 2 &&
  Date.parse(hbUnique[hbUnique.length - 1].heartbeat_at) > Date.parse(hbUnique[0].heartbeat_at);
const leaseOk =
  result?.ok === true &&
  result?.claim?.lease_owner === process.env.ML_SYNC_EXECUTOR_ID &&
  (after.lease_owner === process.env.ML_SYNC_EXECUTOR_ID ||
    (after.status === "done" && result?.lease_final?.lease_version != null));
const idempotent =
  salesBefore &&
  salesAfter &&
  salesAfter.duplicate_logical_groups === 0 &&
  salesAfter.total >= salesBefore.total;

const pass = leaseOk && (progressAdvanced || after.status === "running") && heartbeatAdvanced && idempotent;

console.log(JSON.stringify({ ok: pass, output: outFile, progressAdvanced, heartbeatAdvanced, leaseOk, idempotent }, null, 2));
process.exit(pass ? 0 : 2);
