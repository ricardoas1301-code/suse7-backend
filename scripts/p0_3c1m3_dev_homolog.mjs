#!/usr/bin/env node
/**
 * P0.3-C.1M3 — homologação DEV: snapshot → apply → grant → tests → post assertions.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXPECTED_REF = "alkelcaoexxbamqddaqv";
const MIGRATION_VERSION = "20260821200000";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "scripts/output");
const migrationFile = path.join(
  root,
  `supabase/migrations/${MIGRATION_VERSION}_s7_billing_manual_review_unresolved_cycle_p0_3c1m3.sql`,
);

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

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: root, encoding: "utf8", stdio: opts.stdio ?? "pipe", ...opts });
}

function dbQuery(sql) {
  const out = sh(`npx supabase db query --linked ${JSON.stringify(sql)}`);
  const jsonStart = out.indexOf("{");
  if (jsonStart < 0) throw new Error(`db query parse fail: ${out.slice(0, 400)}`);
  const parsed = JSON.parse(out.slice(jsonStart));
  if (parsed._tag === "Error") throw new Error(parsed.error?.message ?? out);
  return parsed.rows ?? [];
}

function dbFile(filePath) {
  sh(`npx supabase db query --linked -f ${JSON.stringify(filePath)}`);
}

const env = parseEnvFile(path.join(root, ".env.local"));
const ref = refFromUrl(env.SUPABASE_URL || "");
if (ref !== EXPECTED_REF) {
  console.error(JSON.stringify({ ok: false, step: "preflight", ref, expected: EXPECTED_REF }));
  process.exit(2);
}

const artifact = {
  ok: false,
  project_ref: ref,
  migration_version: MIGRATION_VERSION,
  timestamp: new Date().toISOString(),
  pre_snapshot: {},
  post_snapshot: {},
  tests: {},
};

try {
  execSync("node scripts/test_p0_3c1m3_migration_static_unit.mjs", { cwd: root, stdio: "inherit" });
  artifact.tests.static = "PASS";

  artifact.pre_snapshot.admission_distribution = dbQuery(
    "SELECT admission_result, COUNT(*)::int AS cnt FROM billing_billable_sale_admissions GROUP BY admission_result ORDER BY admission_result;",
  );
  artifact.pre_snapshot.rf_pending = dbQuery(
    "SELECT id, external_order_id, cycle_key FROM billing_billable_sale_admissions WHERE marketplace_account_id='359327e4-9902-4213-a1c3-1de702ef92ee'::uuid AND admission_result='PENDING_MANUAL_REVIEW' ORDER BY created_at;",
  );
  artifact.pre_snapshot.rf_pending_count = artifact.pre_snapshot.rf_pending.length;
  artifact.pre_snapshot.cycle_key_nullable = dbQuery(
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='billing_billable_sale_admissions' AND column_name='cycle_key';",
  )[0]?.is_nullable;
  artifact.pre_snapshot.migration_applied = dbQuery(
    `SELECT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='${MIGRATION_VERSION}') AS applied;`,
  )[0]?.applied;

  if (!artifact.pre_snapshot.migration_applied) {
    dbFile(migrationFile);
    sh(`npx supabase migration repair ${MIGRATION_VERSION} --status applied --linked`);
    dbFile(path.join(root, "scripts/sql/p0_3c1m3_grant_dev_billing_unresolved_cycle.sql"));
  } else {
    artifact.skipped_apply = true;
  }

  dbFile(path.join(root, "scripts/sql/p0_3c1m3_post_migration_assertions.sql"));
  artifact.tests.sql_assertions = "PASS";

  execSync("node scripts/p0_3c1m3_concurrency_harness.mjs", { cwd: root, stdio: "inherit" });
  artifact.tests.concurrency = "PASS";

  artifact.post_snapshot.cycle_key_nullable = dbQuery(
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='billing_billable_sale_admissions' AND column_name='cycle_key';",
  )[0]?.is_nullable;
  artifact.post_snapshot.rf_pending_count = dbQuery(
    "SELECT COUNT(*)::int AS cnt FROM billing_billable_sale_admissions WHERE marketplace_account_id='359327e4-9902-4213-a1c3-1de702ef92ee'::uuid AND admission_result='PENDING_MANUAL_REVIEW';",
  )[0]?.cnt;
  artifact.post_snapshot.rf_witness = dbQuery(
    "SELECT COUNT(*)::int AS sales FROM sales_orders WHERE external_order_id='2000018031307152';",
  )[0];
  artifact.post_snapshot.rf_witness_pending = dbQuery(
    "SELECT COUNT(*)::int AS pending FROM billing_billable_sale_admissions WHERE external_order_id='2000018031307152' AND admission_result='PENDING_MANUAL_REVIEW';",
  )[0];
  artifact.post_snapshot.reserved_rf = dbQuery(
    "SELECT COUNT(*)::int AS reserved FROM billing_billable_sale_admissions WHERE marketplace_account_id='359327e4-9902-4213-a1c3-1de702ef92ee'::uuid AND admission_result='RESERVED';",
  )[0]?.reserved;
  artifact.post_snapshot.watermark = dbQuery(
    "SELECT ml_sales_last_synced_order_created_to AS watermark FROM marketplace_accounts WHERE id='359327e4-9902-4213-a1c3-1de702ef92ee'::uuid LIMIT 1;",
  )[0]?.watermark ?? null;
  artifact.post_snapshot.migration_applied = dbQuery(
    `SELECT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='${MIGRATION_VERSION}') AS applied;`,
  )[0]?.applied;

  const rfUnchanged =
    artifact.pre_snapshot.rf_pending_count === artifact.post_snapshot.rf_pending_count &&
    artifact.post_snapshot.rf_witness_pending?.pending === 1;

  artifact.ok =
    artifact.post_snapshot.cycle_key_nullable === "YES" &&
    artifact.post_snapshot.migration_applied === true &&
    rfUnchanged &&
    Number(artifact.post_snapshot.reserved_rf) === 0;

  if (!artifact.ok) {
    console.error("[P0.3-C.1M3 DEV homolog] FAIL", JSON.stringify(artifact, null, 2));
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "P0_3C1M3_DEV_HOMOLOGATION.json");
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log("[P0.3-C.1M3 DEV homolog] OK", outPath);
} catch (err) {
  artifact.error = err instanceof Error ? err.message : String(err);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "P0_3C1M3_DEV_HOMOLOGATION.json"), JSON.stringify(artifact, null, 2));
  console.error("[P0.3-C.1M3 DEV homolog] ERROR", artifact.error);
  process.exit(1);
}
