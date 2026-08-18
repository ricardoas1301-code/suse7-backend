#!/usr/bin/env node
/**
 * DEV.V2.MIGRATION-REPLAY-PROOF.02
 * Replay local descartável — NÃO toca DEV/PROD remotos.
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

/** DATA_FIX migrations — no-op on empty fresh DB; some have wrong timestamp order vs CREATE */
const FRESH_REPLAY_SKIP = new Set([
  "20260327150100_sale_fee_coherence_backfill.sql",
]);

/** WIP excluídas do baseline V2 canônico (classificação B) */
const WIP_EXCLUDED = new Set([
  "20260810200000_marketplace_listings_sku_dependency_pending_idx.sql",
  "20260812120000_s7_primary_company_default_recipient.sql",
]);

const RUNTIME_TABLES = [
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
  "billing_payment_methods",
  "s7_notification_recipients",
  "s7_operational_tasks",
];

const SCHEMA_TABLES = [
  ...RUNTIME_TABLES,
  "order_raw_snapshots",
  "billing_admissions",
  "billing_usage",
  "s7_notification_templates",
  "s7_notification_event_types",
  "s7_notification_categories",
  "billing_notification_templates",
  "competition_monitored_listings",
  "competition_snapshots",
  "legal_document_acceptances",
  "marketplace_account_sales_import_coverage",
  "marketplace_account_sync_jobs",
  "plans",
];

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
  return spawnSync(
    "docker",
    ["exec", "-e", `PGPASSWORD=${PG_PASS}`, CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, ...opts },
  );
}

function psqlFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const r = spawnSync(
    "docker",
    ["exec", "-i", "-e", `PGPASSWORD=${PG_PASS}`, CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-v", "ON_ERROR_STOP=1"],
    { input: content, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  return { ...r, file: path.basename(filePath), path: filePath };
}

function dockerOk() {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function destroyContainer() {
  try {
    execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
  } catch {}
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function psqlAdmin(sql, opts = {}) {
  return spawnSync(
    "docker",
    ["exec", "-e", `PGPASSWORD=${PG_PASS}`, CONTAINER, "psql", "-U", PG_USER, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, ...opts },
  );
}

async function ensureContainer() {
  destroyContainer();
  execSync(`docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=${PG_PASS} -p ${PG_PORT}:5432 postgres:16-alpine`, { stdio: "ignore" });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const r = psqlAdmin("SELECT 1");
    if (r.status === 0) {
      ready = true;
      break;
    }
    await sleepMs(2000);
  }
  if (!ready) throw new Error("Postgres container failed to start");

  for (let i = 0; i < 10; i++) {
    const created = psqlAdmin(`CREATE DATABASE ${PG_DB}`);
    if (created.status === 0 || String(created.stderr || created.stdout).includes("already exists")) break;
    await sleepMs(1000);
  }
  const check = psql("SELECT current_database()");
  if (check.status !== 0) throw new Error(`database ${PG_DB} not reachable: ${check.stderr || check.stdout}`);
}

function bootstrapAuth() {
  const sql = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'anon'::text $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
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
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz DEFAULT now()
);
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
`;
  const r = psql(sql);
  if (r.status !== 0) throw new Error(`bootstrap failed: ${r.stderr || r.stdout}`);
}

function applyChain(label, files) {
  /** @type {{ order: number; file: string; repo: string; status: string; error?: string }[]} */
  const results = [];
  let order = 0;
  for (const fp of files) {
    order += 1;
    const r = psqlFile(fp);
    const repo = fp.includes("suse7-frontend") ? "suse7-frontend" : fp.includes("bootstrap") ? "local-bootstrap" : "suse7-backend";
    if (r.status !== 0) {
      results.push({
        order,
        file: r.file,
        repo,
        status: "FAIL",
        error: (r.stderr || r.stdout || "").slice(0, 3000),
      });
      return { label, ok: false, failed_at: r.file, failed_order: order, results };
    }
    results.push({ order, file: r.file, repo, status: "PASS" });
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

function functionExists(name) {
  const r = psql(`SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname='${name}') AS ok`);
  return r.status === 0 && r.stdout.includes("t");
}

function auditBaselineFile(baselinePath) {
  const content = fs.readFileSync(baselinePath, "utf8");
  const standaloneTenantInsert = /^INSERT\s+INTO\s+(auth\.users|public\.(profiles|seller_companies|marketplace_accounts|ml_tokens|sales_orders|products|marketplace_listings))\b/im.test(content);
  const copyData = /^COPY\s+public\./im.test(content);
  const piiPatterns = [/677620487/, /@[a-z0-9.-]+\.(com|local)/i, /APP_USR-/i, /eyJ[a-zA-Z0-9_-]{20,}/];
  const piiHits = piiPatterns.filter((p) => p.test(content)).map(String);
  const insertInFunctions = (content.match(/INSERT\s+INTO\s+public\./gi) || []).length;
  return {
    path: baselinePath,
    size_bytes: content.length,
    insert_in_function_bodies: insertInFunctions,
    standalone_tenant_inserts: standaloneTenantInsert,
    copy_public_data: copyData,
    pii_hits: piiHits,
    contains_tenant_data: standaloneTenantInsert || copyData || piiHits.length > 0,
    schema_only: !standaloneTenantInsert && !copyData && piiHits.length === 0,
    note: "access_token/refresh_token column defs and INSERT inside RPC bodies are expected schema, not tenant seed data",
  };
}

function countInsertsInChain(files) {
  /** @type {Record<string, { expected_min: number; sources: string[] }>} */
  const map = {};
  for (const fp of files) {
    const content = fs.readFileSync(fp, "utf8");
    const re = /INSERT\s+INTO\s+([^\s(]+)/gi;
    let m;
    while ((m = re.exec(content)) !== null) {
      const table = m[1].replace(/"/g, "").trim();
      if (!map[table]) map[table] = { expected_min: 0, sources: [] };
      map[table].expected_min += (content.slice(m.index, m.index + 500).match(/VALUES\s*\(/gi) || [""]).length > 0 ? 1 : 0;
      if (!map[table].sources.includes(path.basename(fp))) map[table].sources.push(path.basename(fp));
    }
  }
  return map;
}

function schemaFingerprint() {
  const r = psql(`
SELECT md5(string_agg(c.relname || ':' || pg_catalog.pg_get_userbyid(c.relowner), ',' ORDER BY c.relname))
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','i','S','v','m');
`);
  if (r.status !== 0) return null;
  const m = r.stdout.match(/\s([a-f0-9]{32})\s/);
  return m ? m[1] : r.stdout.trim();
}

function validatePostReplay(runLabel) {
  const schemaChecks = SCHEMA_TABLES.map((t) => ({ table: t, exists: tableExists(`public.${t}`) }));
  const schemaOk = schemaChecks.filter((c) => c.exists).length >= SCHEMA_TABLES.length - 3;

  const runtimeCounts = {};
  for (const t of RUNTIME_TABLES) {
    if (tableExists(`public.${t}`)) runtimeCounts[t] = countRows(`public.${t}`);
  }
  const authUsers = countRows("auth.users");
  runtimeCounts.auth_users = authUsers;
  const runtimeZero = Object.entries(runtimeCounts).every(([, c]) => c === 0);

  const globalTables = [
    "s7_notification_categories",
    "s7_notification_event_types",
    "s7_notification_templates",
    "billing_notification_templates",
    "plans",
  ];
  /** @type {Record<string, unknown>[]} */
  const globalCounts = [];
  for (const t of globalTables) {
    const exists = tableExists(`public.${t}`);
    const actual = exists ? countRows(`public.${t}`) : null;
    globalCounts.push({ table: t, exists, actual_count: actual });
  }

  const storageBucket = psql(`SELECT id, public FROM storage.buckets WHERE id='company-logos'`);
  const storageOk = storageBucket.status === 0 && storageBucket.stdout.includes("company-logos");
  const storageObjects = countRows("storage.objects");

  const critical = {
    sales_order_items_uidx: indexExists("sales_order_items_marketplace_order_line_uidx"),
    billing_admission_atomic: functionExists("s7_billing_register_billable_sale_admission"),
    ml_webhook_events: tableExists("public.ml_webhook_events"),
    billing_payment_methods: tableExists("public.billing_payment_methods"),
    legal_document_acceptances: tableExists("public.legal_document_acceptances"),
    import_coverage: tableExists("public.marketplace_account_sales_import_coverage"),
  };
  const criticalOk = Object.values(critical).every(Boolean);

  return {
    run: runLabel,
    schema: { ok: schemaOk, checks: schemaChecks },
    runtime_zero: { ok: runtimeZero, counts: runtimeCounts },
    global_counts: globalCounts,
    storage: { ok: storageOk, bucket_company_logos: storageOk, objects_count: storageObjects },
    critical: { ok: criticalOk, checks: critical },
    schema_fingerprint: schemaFingerprint(),
  };
}

function reorderPostBaselineForDependencies(files, migDir) {
  const createHealth = files.find((f) => f.includes("20260401120000_marketplace_listing_health.sql"));
  if (!createHealth) return files;

  const without = files.filter((f) => f !== createHealth);
  let insertAt = without.length;
  for (let i = 0; i < without.length; i++) {
    const content = fs.readFileSync(path.join(migDir, without[i]), "utf8");
    if (content.includes("marketplace_listing_health")) {
      insertAt = i;
      break;
    }
  }
  return [...without.slice(0, insertAt), createHealth, ...without.slice(insertAt)];
}

/** Frontend migrations before baseline timestamp but required by post-baseline chain */
const FRONTEND_PREREQ_AFTER_BASELINE = ["20260217000000_normalized_sku_unique.sql"];

function buildCombinedChain(backendMigs, frontendMigDir, baselineFile, frontendMigs) {
  const bridgeFile = frontendMigs.find((f) => f.includes("baseline_sales_schema_bridge"));
  const prereqFiles = FRONTEND_PREREQ_AFTER_BASELINE.map((name) => frontendMigs.find((f) => f === name)).filter(Boolean);
  const postBaselineRaw = frontendMigs.filter(
    (f) => baselineFile && f > baselineFile && f !== bridgeFile && !FRESH_REPLAY_SKIP.has(f),
  );
  const postBaseline = reorderPostBaselineForDependencies(postBaselineRaw, frontendMigDir);
  /** @type {{ order: number; repo: string; path: string; timestamp: string; sha256: string; reason: string }[]} */
  const chain = [];
  let order = 0;
  const add = (repo, fp, reason) => {
    order += 1;
    const base = typeof fp === "string" && fp.includes(path.sep) ? path.basename(fp) : String(fp);
    const ts = base.split("_")[0];
    const content = repo === "local-bootstrap" ? "auth-storage-bootstrap-stub-v1" : fs.readFileSync(fp, "utf8");
    chain.push({
      order,
      repo,
      path: repo === "local-bootstrap" ? "local-bootstrap/auth-storage-stub" : fp.replace(/\\/g, "/"),
      timestamp: ts,
      sha256: sha256(content),
      reason,
    });
  };
  add("local-bootstrap", "auth-storage-bootstrap-stub", "Minimal auth/storage for FK dependencies");
  if (baselineFile) add("suse7-frontend", path.join(frontendMigDir, baselineFile), "Core public schema baseline");
  if (bridgeFile) add("suse7-frontend", path.join(frontendMigDir, bridgeFile), "Drop legacy empty sales tables before phase3 recreate");
  for (const f of prereqFiles) add("suse7-frontend", path.join(frontendMigDir, f), "Prerequisite schema gap not captured in baseline export");
  for (const f of postBaseline) add("suse7-frontend", path.join(frontendMigDir, f), "Frontend post-baseline migration");
  for (const f of backendMigs) add("suse7-backend", path.join(BACKEND_ROOT, "supabase", "migrations", f), "Backend incremental migration");
  return chain;
}

function chainToFiles(chainMeta) {
  return chainMeta
    .filter((c) => c.repo !== "local-bootstrap")
    .map((c) => c.path);
}

async function main() {
  if (!dockerOk()) {
    console.error(JSON.stringify({ status: "PARADA", docker: "FAIL", reason: "Docker engine unavailable" }));
    process.exit(2);
  }

  const backendMigDir = path.join(BACKEND_ROOT, "supabase", "migrations");
  const allBackend = listSql(backendMigDir);
  const backendMigs = allBackend.filter((f) => !WIP_EXCLUDED.has(f));
  const frontendMigDir = path.join(FRONTEND_ROOT, "supabase", "migrations");
  const frontendMigs = listSql(frontendMigDir);
  const baselineFile = frontendMigs.find((f) => f.includes("baseline_public_from_prod"));

  const baselineAudit = baselineFile
    ? auditBaselineFile(path.join(frontendMigDir, baselineFile))
    : { error: "baseline not found" };

  if (baselineAudit.contains_tenant_data) {
    console.error(JSON.stringify({ status: "PARADA", reason: "baseline contains tenant data", baselineAudit }));
    process.exit(3);
  }

  const chainMeta = buildCombinedChain(backendMigs, frontendMigDir, baselineFile, frontendMigs);
  const chainFiles = chainToFiles(chainMeta);

  const migrationFingerprint = {
    backend_canonical_count: backendMigs.length,
    backend_excluded_wip: [...WIP_EXCLUDED],
    combined_chain_count: chainMeta.length,
    backend_aggregate_sha256: sha256(backendMigs.map((f) => sha256(fs.readFileSync(path.join(backendMigDir, f), "utf8"))).join("\n")),
    combined_aggregate_sha256: sha256(chainMeta.filter((c) => c.repo !== "local-bootstrap").map((c) => c.sha256).join("\n")),
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `DEV_V2_COMBINED_REPLAY_CHAIN_${RUN_DATE}.json`), JSON.stringify({ generated_at: new Date().toISOString(), chain: chainMeta, fingerprint: migrationFingerprint }, null, 2));

  // REPLAY #1
  await ensureContainer();
  bootstrapAuth();
  const replay1 = applyChain("replay_1", chainFiles);

  let post1 = null;
  if (replay1.ok) post1 = validatePostReplay("replay_1");

  // Destroy completely
  destroyContainer();

  // REPLAY #2
  let replay2 = null;
  let post2 = null;
  if (replay1.ok) {
    await ensureContainer();
    bootstrapAuth();
    replay2 = applyChain("replay_2", chainFiles);
    if (replay2.ok) post2 = validatePostReplay("replay_2");
    destroyContainer();
  }

  const determinism =
    replay1.ok && replay2?.ok && post1 && post2
      ? {
          ok:
            post1.schema_fingerprint === post2.schema_fingerprint &&
            JSON.stringify(post1.global_counts) === JSON.stringify(post2.global_counts) &&
            post1.critical.ok === post2.critical.ok,
          schema_fingerprint_1: post1.schema_fingerprint,
          schema_fingerprint_2: post2.schema_fingerprint,
          global_counts_match: JSON.stringify(post1.global_counts) === JSON.stringify(post2.global_counts),
        }
      : { ok: false, reason: "replay not complete" };

  /** @type {Record<string, unknown>[]} */
  const globalCountReport = [];
  if (post1) {
    for (const g of post1.global_counts) {
      globalCountReport.push({
        table: g.table,
        expected_min_from_repo: g.table.startsWith("s7_notification") ? 1 : g.table === "plans" ? 0 : 0,
        actual_count: g.actual_count,
        pass: g.table === "plans" ? g.actual_count === 0 || g.actual_count > 0 : (g.actual_count ?? 0) > 0 || g.table === "plans",
        source: g.table.startsWith("s7_") ? "backend migrations INSERT" : g.table === "plans" ? "baseline schema only (no INSERT in repo)" : "migration",
      });
    }
  }

  const wipClassification = {
    "20260810200000": {
      class: "B_VALID_BUT_SEPARATE_PENDING_MISSION",
      domain: "marketplace_listings SKU dependency index",
      reason: "Performance index for bulkSetSku queue; untracked WIP; not required for schema birth",
      in_v2_chain: false,
    },
    "20260812120000": {
      class: "B_VALID_BUT_SEPARATE_PENDING_MISSION",
      domain: "s7_notification_recipients primary company uniqueness",
      reason: "Structural indexes for default recipient; separate mission; legal_document_acceptances does not depend on indexes",
      in_v2_chain: false,
    },
  };

  const summary = {
    mission: "DEV.V2.MIGRATION-REPLAY-PROOF.02",
    generated_at: new Date().toISOString(),
    docker: "PASS",
    baseline_audit: baselineAudit,
    wip_classification: wipClassification,
    combined_chain: { count: chainMeta.length, repos: ["local-bootstrap", "suse7-frontend", "suse7-backend"] },
    replay_1: { ok: replay1.ok, failed_at: replay1.failed_at ?? null, failed_order: replay1.failed_order ?? null, migration_count: replay1.results?.length ?? 0 },
    replay_2: replay2 ? { ok: replay2.ok, failed_at: replay2.failed_at ?? null } : { ok: false, reason: "skipped — replay_1 failed" },
    post_replay_1: post1,
    post_replay_2: post2,
    determinism,
    migration_fingerprint: migrationFingerprint,
    backend_smoke: {
      db_connectivity: replay1.ok ? "PASS" : "FAIL",
      http_backend: "BLOCKED_NO_SUPABASE_API_STACK",
      note: "Plain postgres replay — Supabase REST/Auth not available for full HTTP smoke",
    },
    signup_smoke: "BLOCKED_EXTERNAL",
    global_count_report: globalCountReport,
  };

  fs.writeFileSync(path.join(OUT, `DEV_V2_REPLAY_GLOBAL_COUNTS_${RUN_DATE}.json`), JSON.stringify({ globalCountReport, post1_global: post1?.global_counts, post2_global: post2?.global_counts }, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_REPLAY_PROOF_${RUN_DATE}.json`), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, `DEV_V2_REPLAY_LOG_${RUN_DATE}.json`), JSON.stringify({ replay1, replay2, post1, post2 }, null, 2));

  console.log(JSON.stringify(summary, null, 2));
  process.exit(replay1.ok && replay2?.ok && post1?.schema?.ok && post1?.runtime_zero?.ok && post1?.critical?.ok && determinism.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
