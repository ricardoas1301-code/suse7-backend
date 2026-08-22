#!/usr/bin/env node
/**
 * P0.3-C.1B-R3 — RF 9 pending remediation (T20 cycle → NULL).
 * DEV only. Explicit admission IDs. Dry-run default.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXPECTED_REF = "alkelcaoexxbamqddaqv";
const RF_ACCOUNT = "359327e4-9902-4213-a1c3-1de702ef92ee";
const RF_SUB = "56a32441-b4ec-4de2-8657-0b237b8e4c15";
const WITNESS = "2000018031307152";
const WITNESS_ADMISSION = "17802411-c323-407e-ab8d-159a0ea740b7";
const T20_CYCLE_PREFIX = "p0_3c1b-t20-";

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
  `SELECT id, external_order_id, cycle_key, idempotency_key, official_order_at, classification_reason, snapshot_origin, admission_result FROM billing_billable_sale_admissions WHERE marketplace_account_id = '${RF_ACCOUNT}' AND admission_result = 'PENDING_MANUAL_REVIEW' AND cycle_key LIKE '${T20_CYCLE_PREFIX}%' ORDER BY official_order_at ASC NULLS LAST;`,
);

const artifact = {
  ok: false,
  mode: execute ? "execute" : "dry_run",
  generated_at: new Date().toISOString(),
  expected_count: 9,
  candidate_count: candidates.length,
  candidates,
  witness_admission_id: WITNESS_ADMISSION,
};

if (candidates.length !== 9) {
  if (!execute && candidates.length === 0) {
    artifact.ok = true;
    artifact.already_remediated = true;
    const outPath = path.join(root, "scripts/output/P0_3C1B_R3_RF_REMEDIATION.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    console.log(JSON.stringify(artifact, null, 2));
    process.exit(0);
  }
  artifact.ok = false;
  artifact.stop_reason = "candidate_count_not_9";
  const outPath = path.join(root, "scripts/output/P0_3C1B_R3_RF_REMEDIATION.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.error(JSON.stringify(artifact, null, 2));
  process.exit(3);
}

const ids = candidates.map((r) => `'${r.id}'`).join(",");

if (!execute) {
  artifact.ok = true;
  artifact.would_update = candidates.map((r) => ({
    admission_id: r.id,
    external_order_id: r.external_order_id,
    cycle_key: `${r.cycle_key} → NULL`,
    idempotency_key: "→ pending_manual_review:…",
  }));
  const outPath = path.join(root, "scripts/output/P0_3C1B_R3_RF_REMEDIATION.json");
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact, null, 2));
  process.exit(0);
}

const sqlPath = path.join(root, "scripts/sql/p0_3c1b_r3_rf_pending_remediation_exec.sql");
const sql = `-- P0.3-C.1B-R3 RF remediation (generated ${new Date().toISOString()})
BEGIN;

DO $$
DECLARE
  v_count integer;
  v_updated integer;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM billing_billable_sale_admissions
  WHERE id IN (${ids})
    AND admission_result = 'PENDING_MANUAL_REVIEW'
    AND cycle_key LIKE '${T20_CYCLE_PREFIX}%';

  IF v_count <> 9 THEN
    RAISE EXCEPTION 'p0_3c1b_r3: expected 9 candidates, got %', v_count;
  END IF;

  UPDATE billing_billable_sale_admissions a
  SET cycle_key = NULL,
      idempotency_key = public.billing_internal_build_pending_manual_review_idempotency_key(
        a.subscription_id, a.marketplace, a.marketplace_account_id, a.external_order_id
      ),
      pending_cycle_resolved_at = NULL,
      pending_cycle_resolution_reason = NULL,
      updated_at = now()
  WHERE a.id IN (${ids})
    AND a.admission_result = 'PENDING_MANUAL_REVIEW'
    AND a.cycle_key LIKE '${T20_CYCLE_PREFIX}%';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 9 THEN
    RAISE EXCEPTION 'p0_3c1b_r3: updated % rows, expected 9', v_updated;
  END IF;
END $$;

COMMIT;
`;

fs.writeFileSync(sqlPath, sql);
execSync(`npx supabase db query --linked -f ${JSON.stringify(sqlPath)}`, {
  cwd: root,
  stdio: "inherit",
});

const post = {
  pending_total: dbQuery(
    `SELECT COUNT(*)::int AS n FROM billing_billable_sale_admissions WHERE marketplace_account_id='${RF_ACCOUNT}' AND admission_result='PENDING_MANUAL_REVIEW';`,
  )[0]?.n,
  pending_null_cycle: dbQuery(
    `SELECT COUNT(*)::int AS n FROM billing_billable_sale_admissions WHERE marketplace_account_id='${RF_ACCOUNT}' AND admission_result='PENDING_MANUAL_REVIEW' AND cycle_key IS NULL;`,
  )[0]?.n,
  reserved: dbQuery(
    `SELECT COUNT(*)::int AS n FROM billing_billable_sale_admissions WHERE marketplace_account_id='${RF_ACCOUNT}' AND admission_result='RESERVED';`,
  )[0]?.n,
  witness: dbQuery(
    `SELECT id, cycle_key, admission_result FROM billing_billable_sale_admissions WHERE id='${WITNESS_ADMISSION}';`,
  )[0],
  witness_sale: dbQuery(
    `SELECT COUNT(*)::int AS n FROM sales_orders WHERE marketplace_account_id='${RF_ACCOUNT}' AND external_order_id='${WITNESS}';`,
  )[0]?.n,
  remaining_t20: dbQuery(
    `SELECT COUNT(*)::int AS n FROM billing_billable_sale_admissions WHERE marketplace_account_id='${RF_ACCOUNT}' AND admission_result='PENDING_MANUAL_REVIEW' AND cycle_key LIKE '${T20_CYCLE_PREFIX}%';`,
  )[0]?.n,
  watermark: dbQuery(
    `SELECT ml_sales_last_synced_order_created_to AS w FROM marketplace_accounts WHERE id='${RF_ACCOUNT}';`,
  )[0]?.w,
};

artifact.ok =
  post.pending_total === 9 &&
  post.pending_null_cycle === 9 &&
  post.reserved === 0 &&
  post.remaining_t20 === 0 &&
  post.witness?.id === WITNESS_ADMISSION &&
  post.witness?.cycle_key == null &&
  Number(post.witness_sale) === 1;

artifact.post = post;
artifact.remaining_candidates = dbQuery(
  `SELECT id FROM billing_billable_sale_admissions WHERE marketplace_account_id='${RF_ACCOUNT}' AND admission_result='PENDING_MANUAL_REVIEW' AND cycle_key LIKE '${T20_CYCLE_PREFIX}%';`,
);

const outPath = path.join(root, "scripts/output/P0_3C1B_R3_RF_REMEDIATION.json");
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));

if (!artifact.ok) {
  console.error(JSON.stringify(artifact, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(artifact, null, 2));
