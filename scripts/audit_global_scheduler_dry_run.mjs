#!/usr/bin/env node
/**
 * P0.2-M — Auditoria read-only do pool global + dry-run do selector (limit=1/5).
 * Não claim, não lease, não UPDATE, não worker.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  readJobLeaseMeta,
  readJobMetadataObject,
  isJobLeaseExpired,
  resolveStaleRecoveryThresholdMs,
} from "../src/services/marketplace/marketplaceSyncJobLease.js";
import { resolveMlInitialSyncPrerequisiteBlockReason } from "../src/services/marketplace/mlInitialSyncPrerequisites.js";
import { simulateGlobalSchedulerSelection } from "../src/services/marketplace/marketplaceAccountSyncWorker.js";

const EXPECTED_DEV_REF = "alkelcaoexxbamqddaqv";
const INSPRAZZO_ACCOUNT = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
const WINDOW3_ID = "8f08e2c5-52ab-4e0d-b804-babf9feef6ef";

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

function refFromUrl(url) {
  try {
    const m = new URL(url).hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function classifyJob(row, statusMap) {
  const status = String(row.status || "").toLowerCase();
  const lease = readJobLeaseMeta(row);
  const meta = readJobMetadataObject(row);
  const prereq = resolveMlInitialSyncPrerequisiteBlockReason(row, statusMap);

  if (status === "done") return "DONE";
  if (status === "pending" && prereq) return "BLOCKED_POR_PREREQUISITE";
  if (status === "pending") return "PENDING";
  if (status === "running") {
    if (!lease.lease_owner) return "RUNNING_LEGACY_SEM_LEASE";
    if (isJobLeaseExpired(row)) return "RUNNING_COM_LEASE_EXPIRADA";
    return "RUNNING_COM_LEASE_VALIDA";
  }
  if (status === "error") {
    const msg = String(row.error_message || "");
    if (msg.includes("stale_recovery") || msg.startsWith("stale_")) return "ERROR_RECOVERABLE";
    return "ERROR_TERMINAL";
  }
  return "OUTROS_ESTADOS";
}

function sanitizeJobRow(row) {
  const meta = readJobMetadataObject(row);
  const lease = readJobLeaseMeta(row);
  return {
    id: row.id,
    marketplace_account_id: row.marketplace_account_id,
    seller_company_id: row.seller_company_id ?? null,
    job_type: row.job_type,
    status: row.status,
    progress_current: row.progress_current ?? null,
    progress_total: row.progress_total ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    priority: row.priority ?? meta.priority ?? null,
    window_index: meta.window_index ?? null,
    date_from: meta.date_from ?? null,
    date_to: meta.date_to ?? null,
    lease_owner: lease.lease_owner,
    lease_version: lease.lease_version,
    lease_expires_at: lease.lease_expires_at,
    heartbeat_at: lease.heartbeat_at,
    recovery_count: lease.recovery_count,
    last_cursor: row.last_cursor ?? null,
    error_message: row.error_message ? String(row.error_message).slice(0, 120) : null,
  };
}

const env = { ...parseEnvFile(path.join(root, ".env.local")), ...parseEnvFile(path.join(root, ".env.vercel")), ...process.env };
const projectRef = refFromUrl(env.SUPABASE_URL || "");
if (projectRef !== EXPECTED_DEV_REF) {
  console.error(JSON.stringify({ ok: false, error: "wrong_supabase_project", projectRef, expected: EXPECTED_DEV_REF }));
  process.exit(2);
}

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: allJobs, error: allErr } = await sb
  .from("marketplace_account_sync_jobs")
  .select("*")
  .eq("marketplace", "mercado_livre")
  .order("created_at", { ascending: true })
  .limit(5000);

if (allErr) {
  console.error(JSON.stringify({ ok: false, error: allErr.message }));
  process.exit(1);
}

const accountIds = [...new Set((allJobs ?? []).map((r) => String(r.marketplace_account_id || "")).filter(Boolean))];
const { data: accounts } = await sb
  .from("marketplace_accounts")
  .select("id,account_alias,ml_nickname,seller_company_id")
  .in("id", accountIds.length ? accountIds : ["00000000-0000-0000-0000-000000000000"]);

const accountLabel = {};
for (const a of accounts ?? []) {
  accountLabel[String(a.id)] = a.account_alias || a.ml_nickname || String(a.id).slice(0, 8);
}

const sellerIds = [...new Set((accounts ?? []).map((a) => a.seller_company_id).filter(Boolean))];
const { data: sellers } = await sb
  .from("seller_companies")
  .select("id,trade_name,legal_name")
  .in("id", sellerIds.length ? sellerIds : ["00000000-0000-0000-0000-000000000000"]);

const sellerLabel = {};
for (const s of sellers ?? []) {
  sellerLabel[String(s.id)] = s.trade_name || s.legal_name || String(s.id).slice(0, 8);
}

/** @type {Record<string, string>} */
const statusMap = {};
for (const row of [...(allJobs ?? [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
  const aid = String(row.marketplace_account_id || "");
  const jt = String(row.job_type || "");
  if (!aid || !jt) continue;
  const key = `${aid}:${jt}`;
  if (!(key in statusMap)) statusMap[key] = String(row.status || "");
}

const classified = (allJobs ?? []).map((row) => ({
  ...sanitizeJobRow(row),
  account_label: accountLabel[String(row.marketplace_account_id)] ?? null,
  seller_label: sellerLabel[String(row.seller_company_id)] ?? null,
  bucket: classifyJob(row, statusMap),
  prerequisite_block: resolveMlInitialSyncPrerequisiteBlockReason(row, statusMap),
}));

const counts = {
  total: classified.length,
  pending: 0,
  running: 0,
  done: 0,
  error: 0,
  recoverable: 0,
  terminal: 0,
  leases_validas: 0,
  leases_expiradas: 0,
  legacy_running: 0,
  blocked_prerequisite: 0,
  outros: 0,
};

for (const j of classified) {
  if (j.bucket === "PENDING") counts.pending += 1;
  else if (j.bucket.startsWith("RUNNING")) counts.running += 1;
  else if (j.bucket === "DONE") counts.done += 1;
  else if (j.bucket === "ERROR_RECOVERABLE") {
    counts.error += 1;
    counts.recoverable += 1;
  } else if (j.bucket === "ERROR_TERMINAL") {
    counts.error += 1;
    counts.terminal += 1;
  } else if (j.bucket === "BLOCKED_POR_PREREQUISITE") counts.blocked_prerequisite += 1;
  else counts.outros += 1;

  if (j.bucket === "RUNNING_COM_LEASE_VALIDA") counts.leases_validas += 1;
  if (j.bucket === "RUNNING_COM_LEASE_EXPIRADA") counts.leases_expiradas += 1;
  if (j.bucket === "RUNNING_LEGACY_SEM_LEASE") counts.legacy_running += 1;
}

const byAccount = {};
const byJobType = {};
for (const j of classified) {
  const acc = j.account_label || j.marketplace_account_id;
  if (!byAccount[acc]) byAccount[acc] = { total: 0, pending: 0, running: 0, done: 0, error: 0, blocked: 0 };
  byAccount[acc].total += 1;
  if (j.bucket === "PENDING") byAccount[acc].pending += 1;
  else if (j.bucket.startsWith("RUNNING")) byAccount[acc].running += 1;
  else if (j.bucket === "DONE") byAccount[acc].done += 1;
  else if (j.bucket.startsWith("ERROR")) byAccount[acc].error += 1;
  else if (j.bucket === "BLOCKED_POR_PREREQUISITE") byAccount[acc].blocked += 1;

  const jt = j.job_type || "unknown";
  if (!byJobType[jt]) byJobType[jt] = { total: 0, pending: 0, running: 0, done: 0 };
  byJobType[jt].total += 1;
  if (j.bucket === "PENDING") byJobType[jt].pending += 1;
  else if (j.bucket.startsWith("RUNNING")) byJobType[jt].running += 1;
  else if (j.bucket === "DONE") byJobType[jt].done += 1;
}

const sim1 = await simulateGlobalSchedulerSelection(sb, { limit: 1 });
const sim5 = await simulateGlobalSchedulerSelection(sb, { limit: 5 });

const insprazzoHist = classified.filter(
  (j) => j.marketplace_account_id === INSPRAZZO_ACCOUNT && j.job_type === "ml_historical_sales_backfill"
);

const window3 = classified.find((j) => j.id === WINDOW3_ID);
const window4 = insprazzoHist.find((j) => j.window_index === 4);
const window4InSim = sim1.eligible_not_picked.find((j) => j.job_id === window4?.id);
const window4EligibleRank = sim1.global_eligibility_order.findIndex((j) => j.job_id === window4?.id) + 1;

const report = {
  generated_at: new Date().toISOString(),
  mission: "P0.2-M",
  supabase_project_ref: projectRef,
  stale_recovery_threshold_ms: resolveStaleRecoveryThresholdMs(),
  pool_global: {
    counts,
    by_account: byAccount,
    by_job_type: byJobType,
    jobs: classified,
  },
  insprazzo_historical_grid: insprazzoHist.map((j) => ({
    job_id: j.id,
    window_index: j.window_index,
    status: j.status,
    progress: `${j.progress_current ?? 0}/${j.progress_total ?? "?"}`,
    bucket: j.bucket,
    created_at: j.created_at,
    updated_at: j.updated_at,
  })),
  window3_baseline: window3 ?? null,
  dry_run_limit_1: sim1,
  dry_run_limit_5: sim5,
  historical_ordering_analysis: {
    prerequisite_between_windows: "NONE — mlInitialSyncPrerequisites only requires salesHotDone for ml_historical_sales_backfill",
    one_job_per_account_per_wave: true,
    window4_eligible_while_window3_pending: window4EligibleRank > 0,
    window4_would_be_picked_while_window3_pending: false,
    window4_not_picked_reason_if_window3_pending: "one_job_per_account_per_wave (Window 3 ranks first by created_at asc in pool fetch + same pipeline step)",
    window4_eligible_while_window3_running_with_valid_lease:
      window4EligibleRank > 0 && sim1.picks[0]?.job_id !== window4?.id,
    window4_would_be_picked_while_window3_running: sim1.picks[0]?.job_id === window4?.id,
    note: "Among pending historical windows with identical updated_at, fetchJobsPool order (created_at asc) + stable sort preserves Window 3 before 4–9.",
  },
  gate: {
    limit_1_candidate_job_id: sim1.picks[0]?.job_id ?? null,
    limit_1_is_window3: sim1.picks[0]?.job_id === WINDOW3_ID,
    limit_1_account: sim1.picks[0]?.marketplace_account_id ?? null,
    safe_for_controlled_tick:
      sim1.picks.length === 1 && sim1.picks[0]?.job_id === WINDOW3_ID && sim1.picks[0]?.status === "pending",
  },
};

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outPath = path.join(outDir, `AUDIT_GLOBAL_SCHEDULER_DRY_RUN_${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(JSON.stringify({ ok: true, out_path: outPath, gate: report.gate, counts: report.pool_global.counts }, null, 2));
