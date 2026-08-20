#!/usr/bin/env node
/**
 * Requeue cirúrgico de UM job (homologação P0.2) — não sweep global.
 * Uso: node scripts/homolog_scoped_job_recovery.mjs <job_id> [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";

const JOB_ID = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!JOB_ID || !/^[0-9a-f-]{36}$/i.test(JOB_ID)) {
  console.error(JSON.stringify({ ok: false, error: "usage: homolog_scoped_job_recovery.mjs <job_id> [--dry-run]" }));
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

async function snapshotJob(id) {
  const { data, error } = await sb.from("marketplace_account_sync_jobs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data?.id) return null;
  const meta = readJobMetadataObject(data);
  return {
    id: data.id,
    job_type: data.job_type,
    status: data.status,
    progress_current: data.progress_current,
    progress_total: data.progress_total,
    last_cursor: data.last_cursor,
    updated_at: data.updated_at,
    error_message: data.error_message,
    marketplace_account_id: data.marketplace_account_id,
    lease_owner: meta.lease_owner ?? null,
    heartbeat_at: meta.heartbeat_at ?? null,
    lease_expires_at: meta.lease_expires_at ?? null,
    lease_version: meta.lease_version ?? null,
    recovery_count: meta.recovery_count ?? 0,
  };
}

const before = await snapshotJob(JOB_ID);
if (!before) {
  console.error(JSON.stringify({ ok: false, error: "job_not_found", job_id: JOB_ID }));
  process.exit(1);
}

/** @type {Record<string, unknown>} */
const report = {
  generated_at: new Date().toISOString(),
  job_id: JOB_ID,
  dry_run: dryRun,
  before,
  after: null,
  action: null,
};

const status = String(before.status || "").toLowerCase();
if (status !== "running" && status !== "error") {
  report.action = "skipped_status_not_requeue_eligible";
  report.reason = `status=${status}`;
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
  process.exit(0);
}

if (before.lease_owner != null && String(before.lease_owner).trim() !== "") {
  report.action = "blocked_active_lease";
  report.reason = "lease_owner_present";
  console.error(JSON.stringify({ ok: false, ...report }, null, 2));
  process.exit(2);
}

const nowIso = new Date().toISOString();
const meta = {
  ...readJobMetadataObject(
    (await sb.from("marketplace_account_sync_jobs").select("metadata").eq("id", JOB_ID).maybeSingle()).data
  ),
  stale_recovery_reason: "homolog_scoped_requeue_legacy_running",
  homolog_scoped_requeue_at: nowIso,
  lease_owner: null,
  lease_expires_at: null,
};

if (!dryRun) {
  const { error: updErr } = await sb
    .from("marketplace_account_sync_jobs")
    .update({
      status: "pending",
      finished_at: null,
      error_message: null,
      updated_at: nowIso,
      metadata: meta,
    })
    .eq("id", JOB_ID)
    .eq("status", before.status);

  if (updErr) {
    console.error(JSON.stringify({ ok: false, error: updErr.message, before }));
    process.exit(1);
  }
}

report.after = dryRun ? { ...before, status: "pending", would_requeue: true } : await snapshotJob(JOB_ID);
report.action = dryRun ? "dry_run_would_requeue" : "scoped_requeue_done";

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `SCOPED_REQUEUE_${JOB_ID.slice(0, 8)}_${nowIso.slice(0, 19).replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, output: outFile, before: report.before, after: report.after, action: report.action }, null, 2));
