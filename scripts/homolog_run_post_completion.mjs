#!/usr/bin/env node
/**
 * Pós-conclusão oficial para job hot já `done` (ex.: recent-sales Insprazzo).
 * Uso: homolog_run_post_completion.mjs <job_id> [--repeat]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";
import { runMlSalesHotJobPostCompletionForDoneJob } from "../src/services/marketplace/mlSalesHotJobPostCompletion.js";

const JOB_ID = process.argv[2];
const repeat = process.argv.includes("--repeat");

if (!JOB_ID) {
  console.error("usage: homolog_run_post_completion.mjs <job_id> [--repeat]");
  process.exit(1);
}

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
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function countHistorical(accId) {
  const { data } = await sb
    .from("marketplace_account_sync_jobs")
    .select("id,status,metadata,progress_current,progress_total,created_at")
    .eq("marketplace_account_id", accId)
    .eq("job_type", "ml_historical_sales_backfill")
    .order("created_at", { ascending: true });
  return data ?? [];
}

const { data: job, error } = await sb.from("marketplace_account_sync_jobs").select("*").eq("id", JOB_ID).maybeSingle();
if (error || !job?.id) {
  console.error(JSON.stringify({ ok: false, error: error?.message ?? "job_not_found" }));
  process.exit(1);
}

const accId = String(job.marketplace_account_id);
const beforeHist = await countHistorical(accId);

const result1 = await runMlSalesHotJobPostCompletionForDoneJob(sb, job);
const after1 = await countHistorical(accId);

let result2 = null;
let after2 = after1;
if (repeat) {
  const { data: jobRefresh } = await sb.from("marketplace_account_sync_jobs").select("*").eq("id", JOB_ID).maybeSingle();
  result2 = await runMlSalesHotJobPostCompletionForDoneJob(sb, jobRefresh ?? job);
  after2 = await countHistorical(accId);
}

const report = {
  generated_at: new Date().toISOString(),
  job_id: JOB_ID,
  marketplace_account_id: accId,
  job_type: job.job_type,
  job_status: job.status,
  historical_before: beforeHist.length,
  historical_after_first: after1.length,
  historical_after_second: repeat ? after2.length : null,
  result_first: result1,
  result_second: result2,
  historical_jobs: after2.map((row) => {
    const m = readJobMetadataObject(row);
    return {
      id: row.id,
      status: row.status,
      progress: `${row.progress_current ?? 0}/${row.progress_total ?? "?"}`,
      date_from: m.date_from ?? null,
      date_to: m.date_to ?? null,
      window_index: m.window_index ?? null,
      window_label: m.window_label ?? null,
      created_at: row.created_at,
    };
  }),
};

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `POST_COMPLETION_${JOB_ID.slice(0, 8)}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

const pass =
  result1.ran === true &&
  after1.length >= beforeHist.length &&
  (after1.length > beforeHist.length || result1.enqueue?.skipped === true);

console.log(JSON.stringify({ ok: pass, output: outFile, ...report }, null, 2));
process.exit(pass ? 0 : 2);
