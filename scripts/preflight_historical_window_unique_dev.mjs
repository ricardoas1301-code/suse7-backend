#!/usr/bin/env node
/**
 * Preflight read-only — duplicidades semânticas + metadata histórica (DEV).
 * STOP gates: duplicatas, metadata malformada, target != DEV.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_DEV_REF = "alkelcaoexxbamqddaqv";
const INSPRAZZO_ACCOUNT = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
const WINDOW1_ID = "195cb223-44c8-4d9d-b277-88647cc701d7";

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
    const h = new URL(url).hostname;
    const m = h.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return m ? m[1] : h;
  } catch {
    return null;
  }
}

function isoLike(s) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(String(s || "").trim());
}

function semanticKey(row) {
  const m = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const wi = m.window_index;
  const df = m.date_from != null ? String(m.date_from).trim() : "";
  const dt = m.date_to != null ? String(m.date_to).trim() : "";
  return `${row.marketplace_account_id}|${row.job_type}|${wi}|${df}|${dt}`;
}

const env = { ...parseEnvFile(path.join(root, ".env.local")), ...process.env };
const supabaseUrl = env.SUPABASE_URL || "";
const projectRef = refFromUrl(supabaseUrl);

if (projectRef !== EXPECTED_DEV_REF) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        stop: "wrong_target",
        expected_dev_ref: EXPECTED_DEV_REF,
        actual_ref: projectRef,
      },
      null,
      2
    )
  );
  process.exit(3);
}

const sb = createClient(supabaseUrl, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: rows, error } = await sb
  .from("marketplace_account_sync_jobs")
  .select("id,marketplace_account_id,job_type,status,progress_current,progress_total,metadata,created_at,updated_at")
  .eq("job_type", "ml_historical_sales_backfill");

if (error) {
  console.error(JSON.stringify({ ok: false, stop: "query_failed", message: error.message }, null, 2));
  process.exit(2);
}

const all = rows ?? [];
/** @type {Record<string, typeof all>} */
const groups = {};
for (const row of all) {
  const k = semanticKey(row);
  if (!groups[k]) groups[k] = [];
  groups[k].push(row);
}

const duplicateGroups = Object.entries(groups).filter(([, g]) => g.length > 1);

/** @type {Record<string, unknown>[]} */
const malformed = [];
/** @type {Record<string, unknown>[]} */
const noncanonicalDates = [];

for (const row of all) {
  const m = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const issues = [];
  if (m.window_index == null || String(m.window_index).trim() === "") issues.push("missing_window_index");
  else if (!Number.isFinite(Number(m.window_index)) || Number(m.window_index) < 0) issues.push("invalid_window_index");
  if (m.date_from == null || String(m.date_from).trim() === "") issues.push("missing_date_from");
  if (m.date_to == null || String(m.date_to).trim() === "") issues.push("missing_date_to");
  if (m.date_from && !isoLike(m.date_from)) issues.push("noncanonical_date_from");
  if (m.date_to && !isoLike(m.date_to)) issues.push("noncanonical_date_to");
  if (issues.length) malformed.push({ id: row.id, marketplace_account_id: row.marketplace_account_id, issues, metadata: m });
  if (issues.some((i) => i.startsWith("noncanonical"))) noncanonicalDates.push({ id: row.id, metadata: m });
}

const inspHistorical = all.filter((r) => r.marketplace_account_id === INSPRAZZO_ACCOUNT);
const window1 = inspHistorical.find((r) => r.id === WINDOW1_ID);

const report = {
  generated_at: new Date().toISOString(),
  target: { project_ref: projectRef, confirmed_dev: true },
  historical_jobs_total: all.length,
  duplicate_semantic_groups: duplicateGroups.length,
  duplicate_rows_affected: duplicateGroups.reduce((n, [, g]) => n + g.length, 0),
  duplicate_details: duplicateGroups.map(([k, g]) => ({
    semantic_key: k,
    count: g.length,
    job_ids: g.map((r) => r.id),
    accounts: [...new Set(g.map((r) => r.marketplace_account_id))],
  })),
  missing_window_index: malformed.filter((r) => r.issues.includes("missing_window_index")).length,
  missing_date_from: malformed.filter((r) => r.issues.includes("missing_date_from")).length,
  missing_date_to: malformed.filter((r) => r.issues.includes("missing_date_to")).length,
  invalid_window_index: malformed.filter((r) => r.issues.includes("invalid_window_index")).length,
  noncanonical_dates: noncanonicalDates.length,
  malformed_sample: malformed.slice(0, 20),
  insprazzo: {
    total: inspHistorical.length,
    done: inspHistorical.filter((r) => r.status === "done").length,
    pending: inspHistorical.filter((r) => r.status === "pending").length,
  },
  window1: window1
    ? {
        id: window1.id,
        status: window1.status,
        progress: `${window1.progress_current ?? 0}/${window1.progress_total ?? "?"}`,
        updated_at: window1.updated_at,
        window_index: window1.metadata?.window_index ?? null,
      }
    : null,
};

const pass =
  duplicateGroups.length === 0 &&
  malformed.length === 0 &&
  report.missing_window_index === 0 &&
  report.missing_date_from === 0 &&
  report.missing_date_to === 0 &&
  report.invalid_window_index === 0 &&
  report.noncanonical_dates === 0;

report.preflight_pass = pass;

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `PREFLIGHT_HISTORICAL_WINDOW_UNIQUE_${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log(JSON.stringify({ ok: pass, output: outFile, ...report }, null, 2));
process.exit(pass ? 0 : pass === false && duplicateGroups.length > 0 ? 4 : 5);
