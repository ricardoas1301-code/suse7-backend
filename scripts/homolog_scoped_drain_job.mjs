#!/usr/bin/env node
/**
 * Drain scoped — exclusivamente um job_id via runScopedMarketplaceSyncJobDrain.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { runScopedMarketplaceSyncJobDrain } from "../src/services/marketplace/marketplaceAccountSyncWorker.js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";

const JOB_ID = process.argv[2];
const budgetArg = process.argv.find((a) => a.startsWith("--budget-ms="));
const budgetMs = budgetArg ? parseInt(budgetArg.split("=")[1], 10) : 120000;

if (!JOB_ID) {
  console.error("usage: homolog_scoped_drain_job.mjs <job_id> [--budget-ms=120000]");
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
    status: data?.status,
    progress: `${data?.progress_current}/${data?.progress_total}`,
    progress_current: data?.progress_current,
    last_cursor: data?.last_cursor,
    updated_at: data?.updated_at,
    lease_owner: m.lease_owner ?? null,
    heartbeat_at: m.heartbeat_at ?? null,
    lease_expires_at: m.lease_expires_at ?? null,
    lease_version: m.lease_version ?? null,
    recovery_count: m.recovery_count ?? 0,
  };
}

const before = await snap(JOB_ID);
const result = await runScopedMarketplaceSyncJobDrain(sb, JOB_ID, { budgetMs });
const after = await snap(JOB_ID);

const report = {
  generated_at: new Date().toISOString(),
  executor_id: process.env.ML_SYNC_EXECUTOR_ID,
  before,
  result,
  after,
};

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `SCOPED_DRAIN_${JOB_ID.slice(0, 8)}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

const pass =
  result.ok === true &&
  result.claim?.lease_owner === process.env.ML_SYNC_EXECUTOR_ID &&
  result.claim?.heartbeat_at != null &&
  after.lease_owner === process.env.ML_SYNC_EXECUTOR_ID;

console.log(JSON.stringify({ ok: pass, output: outFile, before, after, result }, null, 2));
process.exit(pass ? 0 : 2);
