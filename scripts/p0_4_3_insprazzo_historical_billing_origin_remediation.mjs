#!/usr/bin/env node
/**
 * P0.4.3 — remediação das 10 admissions Insprazzo com snapshot_origin operacional incorreto.
 * Contrato: FINAL_NOT_BILLABLE + onboarding_import, quota/reserved = 0.
 * DEV only (alkelcaoexxbamqddaqv). Dry-run default.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXPECTED_REF = "alkelcaoexxbamqddaqv";
const INSPRAZZO = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
const RECOVERY_WINDOW_START = "2026-08-22T19:12:50.000Z";
const RECOVERY_WINDOW_END = "2026-08-22T19:13:00.000Z";
const EXPECTED_ORDER_IDS = [
  "2000014601353976",
  "2000014598728636",
  "2000014595159852",
  "2000014585104464",
  "2000014582388070",
  "2000014581302982",
  "2000014570789540",
  "2000014568000884",
  "2000014565967582",
  "2000014561346990",
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execute = process.argv.includes("--execute");

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

function dbQuery(sql) {
  const out = execSync(`npx supabase db query --linked ${JSON.stringify(sql)}`, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const jsonStart = out.indexOf("{");
  if (jsonStart < 0) throw new Error(`db query parse fail: ${out.slice(0, 300)}`);
  const parsed = JSON.parse(out.slice(jsonStart));
  if (parsed._tag === "Error") throw new Error(parsed.error?.message ?? out);
  return parsed.rows ?? [];
}

const env = parseEnvFile(path.join(root, ".env.local"));
if (refFromUrl(env.SUPABASE_URL || "") !== EXPECTED_REF) {
  console.error(JSON.stringify({ ok: false, error: "wrong_project" }));
  process.exit(2);
}

const candidates = dbQuery(
  `SELECT id, external_order_id, admission_result, snapshot_origin, period_class, classification_reason, cycle_key, reserved_at, created_at FROM billing_billable_sale_admissions WHERE marketplace_account_id = '${INSPRAZZO}' AND admission_result = 'PENDING_MANUAL_REVIEW' AND snapshot_origin = 'operational_sync' AND created_at >= '${RECOVERY_WINDOW_START}' AND created_at <= '${RECOVERY_WINDOW_END}' ORDER BY external_order_id ASC;`,
);

const artifact = {
  ok: false,
  mode: execute ? "execute" : "dry_run",
  generated_at: new Date().toISOString(),
  expected_count: 10,
  candidate_count: candidates.length,
  expected_order_ids: EXPECTED_ORDER_IDS,
  candidates,
};

if (candidates.length !== 10) {
  artifact.stop_reason = "candidate_count_not_10";
  const outPath = path.join(root, "scripts/output/P0_4_3_INSPRAZZO_BILLING_ORIGIN_REMEDIATION.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.error(JSON.stringify(artifact, null, 2));
  process.exit(3);
}

const foundIds = candidates.map((r) => String(r.external_order_id)).sort();
const expectedSorted = [...EXPECTED_ORDER_IDS].sort();
if (JSON.stringify(foundIds) !== JSON.stringify(expectedSorted)) {
  artifact.stop_reason = "order_id_mismatch";
  artifact.found_order_ids = foundIds;
  const outPath = path.join(root, "scripts/output/P0_4_3_INSPRAZZO_BILLING_ORIGIN_REMEDIATION.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.error(JSON.stringify(artifact, null, 2));
  process.exit(4);
}

const ids = candidates.map((r) => `'${r.id}'`).join(",");

if (!execute) {
  artifact.ok = true;
  artifact.would_update = candidates.map((r) => ({
    id: r.id,
    external_order_id: r.external_order_id,
    from: { admission_result: r.admission_result, snapshot_origin: r.snapshot_origin },
    to: { admission_result: "FINAL_NOT_BILLABLE", snapshot_origin: "onboarding_import" },
  }));
  const outPath = path.join(root, "scripts/output/P0_4_3_INSPRAZZO_BILLING_ORIGIN_REMEDIATION.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact, null, 2));
  process.exit(0);
}

dbQuery(`UPDATE billing_billable_sale_admissions SET admission_result = 'FINAL_NOT_BILLABLE', snapshot_origin = 'onboarding_import', period_class = COALESCE(period_class, 'importacao_historica'), classification_reason = COALESCE(classification_reason, 'onboarding_import_remediation_p0_4_3'), updated_at = NOW() WHERE id IN (${ids}) AND admission_result = 'PENDING_MANUAL_REVIEW' AND snapshot_origin = 'operational_sync';`);

const after = dbQuery(
  `SELECT id, external_order_id, admission_result, snapshot_origin, period_class FROM billing_billable_sale_admissions WHERE id IN (${ids}) ORDER BY external_order_id;`,
);

const pendingLeft = dbQuery(
  `SELECT COUNT(*)::int AS n FROM billing_billable_sale_admissions WHERE marketplace_account_id = '${INSPRAZZO}' AND admission_result = 'PENDING_MANUAL_REVIEW' AND snapshot_origin = 'operational_sync' AND created_at >= '${RECOVERY_WINDOW_START}' AND created_at <= '${RECOVERY_WINDOW_END}';`,
);

artifact.ok = after.every((r) => r.admission_result === "FINAL_NOT_BILLABLE" && r.snapshot_origin === "onboarding_import");
artifact.after = after;
artifact.pending_operational_sync_in_window = pendingLeft[0]?.n ?? null;
artifact.zero_retrocharge = true;

const outPath = path.join(root, "scripts/output/P0_4_3_INSPRAZZO_BILLING_ORIGIN_REMEDIATION.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(JSON.stringify(artifact, null, 2));
process.exit(artifact.ok ? 0 : 5);
