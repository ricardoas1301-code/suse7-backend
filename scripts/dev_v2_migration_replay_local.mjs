#!/usr/bin/env node
/**
 * DEV.V2.MIGRATION-REPLAY-GAPS.01 — replay local descartável.
 * NÃO toca DEV/PROD remotos.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "..");
const FRONTEND_ROOT = path.join(BACKEND_ROOT, "..", "suse7-frontend");
const OUT = path.join(__dirname, "output");
const RUN_DATE = process.env.RUN_DATE || "2026-08-13";
const CONTAINER = "s7-dev-v2-replay-pg";
const PG_PORT = process.env.REPLAY_PG_PORT || "54329";
const PG_USER = "postgres";
const PG_PASS = "postgres";
const PG_DB = "s7_replay";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function listSql(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !f.startsWith("APPLY_MANUAL") && !f.startsWith("VALIDATE"))
    .sort();
}

function psql(sql, opts = {}) {
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${PG_PASS}`,
      CONTAINER,
      "psql",
      "-U",
      PG_USER,
      "-d",
      PG_DB,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, ...opts },
  );
  return r;
}

function psqlFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const r = spawnSync(
    "docker",
    ["exec", "-i", "-e", `PGPASSWORD=${PG_PASS}`, CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-v", "ON_ERROR_STOP=1"],
    { input: content, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  return { ...r, file: path.basename(filePath) };
}

function dockerOk() {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensureContainer() {
  try {
    execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
  } catch {}
  execSync(
    `docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=${PG_PASS} -p ${PG_PORT}:5432 postgres:16-alpine`,
    { stdio: "ignore" },
  );
  for (let i = 0; i < 30; i++) {
    const r = psql("SELECT 1");
    if (r.status === 0) return;
    execSync("timeout /t 2 /nobreak >nul 2>&1", { shell: "cmd.exe" });
  }
  throw new Error("Postgres container failed to start");
}

function bootstrapAuth() {
  const sql = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth.identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text,
  created_at timestamptz DEFAULT now()
);
`;
  const r = psql(sql);
  if (r.status !== 0) throw new Error(`bootstrap failed: ${r.stderr}`);
}

function applyChain(label, files) {
  /** @type {{ file: string; status: string; error?: string }[]} */
  const results = [];
  for (const f of files) {
    const r = psqlFile(f);
    if (r.status !== 0) {
      results.push({ file: r.file, status: "FAIL", error: (r.stderr || r.stdout || "").slice(0, 2000) });
      return { label, ok: false, failed_at: r.file, results };
    }
    results.push({ file: r.file, status: "PASS" });
  }
  return { label, ok: true, results };
}

function countRows(table) {
  const r = psql(`SELECT count(*)::int AS c FROM ${table}`);
  if (r.status !== 0) return null;
  const m = r.stdout.match(/\s(\d+)\s/);
  return m ? Number(m[1]) : null;
}

function tableExists(table) {
  const r = psql(`SELECT to_regclass('${table}') IS NOT NULL AS ok`);
  return r.status === 0 && r.stdout.includes("t");
}

function indexExists(name) {
  const r = psql(`SELECT to_regclass('public.${name}') IS NOT NULL AS ok`);
  return r.status === 0 && r.stdout.includes("t");
}

function auditDependencyHeuristics(migrationsDir, files) {
  /** @type {Record<string, unknown>[]} */
  const issues = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(migrationsDir, f), "utf8");
    const alters = content.match(/ALTER TABLE(?: IF EXISTS)? public\.(\w+)/gi) || [];
    const creates = content.match(/CREATE TABLE(?: IF NOT EXISTS)? public\.(\w+)/gi) || [];
    if (alters.length && !creates.length && !content.includes("IF EXISTS")) {
      const firstAlter = alters[0];
      if (!/IF EXISTS/i.test(content.slice(0, 500))) {
        issues.push({ file: f, type: "ALTER_WITHOUT_IF_EXISTS", sample: firstAlter });
      }
    }
    if (/REFERENCES auth\.users/i.test(content) && !content.includes("CREATE TABLE")) {
      issues.push({ file: f, type: "FK_AUTH_USERS", note: "requires auth bootstrap" });
    }
  }
  return issues;
}

function buildFingerprint(files, baseDir) {
  return {
    count: files.length,
    aggregate_sha256: sha256(files.map((f) => sha256(fs.readFileSync(path.join(baseDir, f), "utf8"))).join("\n")),
    files: files.map((f) => ({
      file: f,
      sha256: sha256(fs.readFileSync(path.join(baseDir, f), "utf8")),
    })),
  };
}

function scanGlobalInserts(migrationsDir, files) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(migrationsDir, f), "utf8");
    const inserts = content.match(/INSERT INTO\s+([^\s(]+)/gi) || [];
    if (inserts.length) {
      rows.push({ file: f, tables: [...new Set(inserts.map((i) => i.replace(/INSERT INTO\s+/i, "").trim()))], count: inserts.length });
    }
  }
  return rows;
}

async function main() {
  if (!dockerOk()) {
    console.error("Docker unavailable");
    process.exit(2);
  }

  const backendMigs = listSql(path.join(BACKEND_ROOT, "supabase", "migrations"));
  const frontendMigDir = path.join(FRONTEND_ROOT, "supabase", "migrations");
  const frontendMigs = listSql(frontendMigDir);
  const baselineFile = frontendMigs.find((f) => f.includes("baseline_public_from_prod"));
  const frontendPostBaseline = frontendMigs.filter((f) => baselineFile && f > baselineFile);

  const dependencyReport = {
    generated_at: new Date().toISOString(),
    backend_migration_count: backendMigs.length,
    frontend_migration_count: frontendMigs.length,
    backend_only_replay_viable: false,
    reason_backend_only:
      "Backend migrations are incremental ALTER/RPC on pre-existing schema; no CREATE for profiles/marketplace_accounts/sales_orders/plans in backend chain.",
    baseline_source: baselineFile ? path.join("suse7-frontend/supabase/migrations", baselineFile) : null,
    backend_heuristic_issues: auditDependencyHeuristics(path.join(BACKEND_ROOT, "supabase", "migrations"), backendMigs),
    global_inserts_in_backend: scanGlobalInserts(path.join(BACKEND_ROOT, "supabase", "migrations"), backendMigs),
  };

  /** @type {Record<string, unknown>} */
  const replayLog = { runs: [] };

  // Run A: backend-only (expect fail)
  ensureContainer();
  bootstrapAuth();
  const runA = applyChain(
    "backend_only",
    backendMigs.map((f) => path.join(BACKEND_ROOT, "supabase", "migrations", f)),
  );
  replayLog.runs.push(runA);

  // Run B: baseline + backend + frontend post-baseline
  try {
    execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
  } catch {}
  ensureContainer();
  bootstrapAuth();

  const chainB = [];
  if (baselineFile) chainB.push(path.join(frontendMigDir, baselineFile));
  chainB.push(...backendMigs.map((f) => path.join(BACKEND_ROOT, "supabase", "migrations", f)));
  chainB.push(...frontendPostBaseline.map((f) => path.join(frontendMigDir, f)));

  const runB = applyChain("baseline_plus_backend_plus_frontend_post", chainB);
  replayLog.runs.push(runB);

  // Run C: repeat B if B passed
  let runC = null;
  if (runB.ok) {
    try {
      execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
    } catch {}
    ensureContainer();
    bootstrapAuth();
    runC = applyChain("second_clean_replay", chainB);
    replayLog.runs.push(runC);
  }

  // Schema contract checks on last successful container
  /** @type {Record<string, unknown>} */
  const schemaContract = { ok: false, checks: [] };
  /** @type {Record<string, unknown>} */
  const runtimeZero = { ok: false, counts: {} };
  /** @type {Record<string, unknown>} */
  const globalBaseline = { tables: {} };
  /** @type {Record<string, unknown>} */
  const critical = { ok: false, checks: [] };

  if (runB.ok || runC?.ok) {
    const runtimeTables = [
      "profiles",
      "seller_companies",
      "marketplace_accounts",
      "ml_tokens",
      "products",
      "marketplace_listings",
      "sales_orders",
      "sales_order_items",
      "ml_webhook_events",
      "billing_subscriptions",
      "billing_customers",
    ];
    for (const t of runtimeTables) {
      schemaContract.checks.push({ table: t, exists: tableExists(`public.${t}`) });
    }
    schemaContract.ok = schemaContract.checks.every((c) => c.exists === true);

    for (const t of runtimeTables) {
      if (tableExists(`public.${t}`)) runtimeZero.counts[t] = countRows(`public.${t}`);
    }
    runtimeZero.ok = Object.values(runtimeZero.counts).every((c) => c === 0);

    const globalTables = ["plans", "notification_templates", "communication_templates", "notification_catalog_entries"];
    for (const t of globalTables) {
      if (tableExists(`public.${t}`)) globalBaseline.tables[t] = countRows(`public.${t}`);
    }

    critical.checks = [
      { name: "sales_order_items_canonical_uidx", ok: indexExists("sales_order_items_marketplace_order_line_uidx") },
      { name: "billing_payment_methods", ok: tableExists("public.billing_payment_methods") },
      { name: "legal_document_acceptances", ok: tableExists("public.legal_document_acceptances") },
      { name: "marketplace_account_sales_import_coverage", ok: tableExists("public.marketplace_account_sales_import_coverage") },
      { name: "ml_webhook_events", ok: tableExists("public.ml_webhook_events") },
    ];
    critical.ok = critical.checks.every((c) => c.ok);
  }

  const orphanClassification = {
    generated_at: new Date().toISOString(),
    items: [
      {
        path: "suse7-backend/scripts/migrations/20260508_marketplace_account_sales_import_coverage.sql",
        class: "A_REQUIRED_CANONICAL_MIGRATION",
        canonical_target: "supabase/migrations/20260510130000_marketplace_account_sales_import_coverage.sql",
        applied_in_dev: "likely yes (worker uses table; fails silently comment outdated)",
        equivalent_in_canonical_before: false,
      },
      {
        path: "suse7-backend/scripts/migrations/20260513_billing_payment_methods.sql",
        class: "A_REQUIRED_CANONICAL_MIGRATION",
        canonical_target: "supabase/migrations/20260513190000_billing_payment_methods.sql (merged with 20260518)",
        applied_in_dev: "likely yes (renewal_cycles comments reference table; billingPaymentMethodsService uses it)",
        equivalent_in_canonical_before: false,
      },
      {
        path: "suse7-backend/scripts/migrations/20260518_billing_payment_methods_card_type.sql",
        class: "B_DUPLICATE_ALREADY_CANONICAL",
        note: "Merged into 20260513190000 forward migration",
        canonical_target: null,
      },
      {
        path: "scripts/migrations/20260812_legal_document_acceptances.sql (repo root)",
        class: "A_REQUIRED_CANONICAL_MIGRATION",
        canonical_target: "supabase/migrations/20260812130000_legal_document_acceptances.sql",
        applied_in_dev: "unknown/partial (legalRoutes.js exists in working tree)",
        equivalent_in_canonical_before: false,
      },
    ],
  };

  const seedStrategy = {
    decision: "A",
    label: "MIGRATIONS_ALREADY_SUFFICIENT_FOR_GLOBAL_REFERENCE",
    rationale:
      "13 backend migrations contain INSERTs for templates/catalog/billing lifecycle. supabase/seed.sql not required if replay proves row counts. No separate seed.sql unless replay shows missing global rows.",
    migration_managed_inserts: dependencyReport.global_inserts_in_backend,
  };

  const fingerprint = buildFingerprint(backendMigs, path.join(BACKEND_ROOT, "supabase", "migrations"));

  const projectSettingsRunbook = {
    generated_at: new Date().toISOString(),
    not_recreated_by_migrations: [
      "Auth Site URL and redirect URLs",
      "Auth email templates and provider toggles",
      "Supabase project API keys and service role",
      "Realtime publication config",
      "Storage bucket policies beyond SQL migration stubs",
      "Vercel env vars (SUPABASE_URL, keys, JOB_SECRET, CRON_SECRET)",
      "ML OAuth app redirect URI registration",
      "Asaas sandbox webhook URL and token",
      "GitHub Actions DEV_* secrets",
    ],
    storage: {
      bucket_company_logos: {
        recreatable_via_migration: true,
        migration: "20260512120000_storage_company_logos_bucket.sql",
        tenant_objects_on_fresh_dev: 0,
      },
    },
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `DEV_V2_ORPHAN_MIGRATIONS_CLASSIFICATION_${RUN_DATE}.json`), JSON.stringify(orphanClassification, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_MIGRATION_DEPENDENCY_REPORT_${RUN_DATE}.json`), JSON.stringify(dependencyReport, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_GLOBAL_REFERENCE_BASELINE_${RUN_DATE}.json`), JSON.stringify(globalBaseline, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_PROJECT_SETTINGS_RUNBOOK_${RUN_DATE}.json`), JSON.stringify(projectSettingsRunbook, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_CANONICAL_MIGRATION_FINGERPRINT_${RUN_DATE}.json`), JSON.stringify(fingerprint, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_REPLAY_LOG_${RUN_DATE}.json`), JSON.stringify({ replayLog, schemaContract, runtimeZero, critical, seedStrategy }, null, 2));

  console.log(
    JSON.stringify(
      {
        runA: { ok: runA.ok, failed_at: runA.failed_at ?? null },
        runB: { ok: runB.ok, failed_at: runB.failed_at ?? null },
        runC: runC ? { ok: runC.ok, failed_at: runC.failed_at ?? null } : null,
        schemaContract: schemaContract.ok,
        runtimeZero: runtimeZero.ok,
        critical: critical.ok,
        backend_migrations: backendMigs.length,
      },
      null,
      2,
    ),
  );

  try {
    execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
  } catch {}
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
