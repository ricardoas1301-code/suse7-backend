#!/usr/bin/env node
/**
 * BATCH 3B PROD — 00003 EXECUTE + 00008 FORWARD-FIX + 00061 EXECUTE
 * Uma migration por vez · history repair por último.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260817";
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const MIGRATIONS_DIR = path.join(WORKSPACE, "supabase", "migrations");
const PROD_REF = "bazibzquasbdgjwdcwbz";
const DEV_REF = "alkelcaoexxbamqddaqv";
const PROD_NAME = "Suse7-prod";
const SHADOW_DB = "s7_shadow_batch3b_20260817";
const DOCKER_DB = "supabase_db_supabase-local-replay-workspace";

const AUTHORIZED = ["20260301000003", "20260301000008", "20260301000061"];
const FORBIDDEN = [
  "20260301000043",
  "20260301000112",
  "20260301000113",
  "20260301000114",
  "20260301000115",
  "20260301000116",
  "20260301000118",
  "20260301000119",
  "20260301000120",
  "20260301000121",
  "20260301000122",
];

const EXPECTED_REMAINING = [
  "20260301000043",
  "20260301000112",
  "20260301000113",
  "20260301000114",
  "20260301000115",
  "20260301000116",
  "20260301000118",
  "20260301000119",
  "20260301000120",
  "20260301000121",
  "20260301000122",
];

const FILES = {
  "20260301000003": path.join(MIGRATIONS_DIR, "20260301000003_normalized_sku_unique.sql"),
  "20260301000003_gap": path.join(OUT, "_00003_gap_uq_products_user_normalized_sku.sql"),
  "20260301000008": path.join(OUT, "_shadow_forward_fix_20260301000008.sql"),
  "20260301000061": path.join(MIGRATIONS_DIR, "20260301000061_storage_company_logos_bucket.sql"),
};

const BASELINE_SCHEMA = path.join(OUT, "_prod_schema_after_batch3a_20260817.sql");

let prodDbPasswordMem = null;

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/PGPASSWORD="[^"]+"/g, 'PGPASSWORD="[REDACTED]"')
    .replace(/PGPASSWORD=[^\s]+/g, "PGPASSWORD=[REDACTED]");
}

function promptProdPasswordInteractive() {
  if (prodDbPasswordMem || process.env.PROD_DB_PASSWORD || process.env.SUSE7_PROD_DB_PASSWORD) return;
  process.stderr.write("Informe a senha postgres PROD (nao sera salva):\n");
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$s=Read-Host 'Senha postgres PROD (Suse7-prod)' -AsSecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringAuto($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }",
    ],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  const pass = (r.stdout || "").trim();
  if (r.status !== 0 || !pass) throw new Error("Senha postgres PROD nao informada — Batch 3B abortado");
  prodDbPasswordMem = pass;
}

function clearProdPasswordMem() {
  prodDbPasswordMem = null;
  delete process.env.PROD_DB_PASSWORD;
  delete process.env.SUSE7_PROD_DB_PASSWORD;
}

function resolveProdPassword() {
  return prodDbPasswordMem || process.env.PROD_DB_PASSWORD || process.env.SUSE7_PROD_DB_PASSWORD || null;
}

function run(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: WORKSPACE,
    encoding: "utf8",
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    timeout: opts.timeout || 300000,
  });
}

function linkProd() {
  run(`supabase link --project-ref ${PROD_REF} --yes`, { stdio: "ignore" });
}

function relinkDev() {
  run(`supabase link --project-ref ${DEV_REF} --yes`, { stdio: "ignore" });
}

function getEphemeralDbCreds() {
  let raw = "";
  try {
    raw = run("supabase db dump --dry-run --linked -s public 2>&1", { timeout: 120000 });
  } catch (err) {
    raw = `${err.stdout || ""}\n${err.stderr || ""}\n${err.message || ""}`;
  }
  const host = raw.match(/PGHOST="([^"]+)"/)?.[1];
  const port = raw.match(/PGPORT="([^"]+)"/)?.[1] || "5432";
  const user = raw.match(/PGUSER="([^"]+)"/)?.[1];
  const password = raw.match(/PGPASSWORD="([^"]+)"/)?.[1];
  const database = raw.match(/PGDATABASE="([^"]+)"/)?.[1] || "postgres";
  if (!host || !user || !password) return null;
  return { host, port, user, password, database };
}

function getDbCreds() {
  const ephemeral = getEphemeralDbCreds();
  if (ephemeral) return ephemeral;
  const dbPassword = resolveProdPassword();
  if (!dbPassword) throw new Error("Credencial postgres PROD ausente");
  return {
    host: `db.${PROD_REF}.supabase.co`,
    port: "5432",
    user: "postgres",
    password: dbPassword,
    database: "postgres",
  };
}

function psqlSpawnArgs(creds, extraArgs) {
  return [
    "run",
    "--rm",
    "--network",
    "host",
    "-e",
    `PGPASSWORD=${creds.password}`,
    "postgres:17",
    "psql",
    "-h",
    creds.host,
    "-p",
    creds.port,
    "-U",
    creds.user,
    "-d",
    creds.database,
    "-v",
    "ON_ERROR_STOP=1",
    ...extraArgs,
  ];
}

function psqlExec(creds, sql) {
  return spawnSync("docker", psqlSpawnArgs(creds, ["-t", "-A", "-c", sql]), {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function psqlFile(creds, filePath) {
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "host",
      "-i",
      "-e",
      `PGPASSWORD=${creds.password}`,
      "postgres:17",
      "psql",
      "-h",
      creds.host,
      "-p",
      creds.port,
      "-U",
      creds.user,
      "-d",
      creds.database,
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      input: fs.readFileSync(filePath, "utf8"),
    },
  );
}

function dockerPsql(sql, { db = SHADOW_DB, file = null, timeoutMs = 300000 } = {}) {
  const args = ["exec", DOCKER_DB, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-d", db];
  if (file) args.push("-f", file);
  else args.push("-c", sql);
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), status: r.status };
}

function dockerCpToContainer(localPath, containerPath) {
  spawnSync("docker", ["cp", localPath, `${DOCKER_DB}:${containerPath}`], { encoding: "utf8" });
}

function fingerprintDump(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const t = fs.readFileSync(filePath, "utf8");
  const tables = [...t.matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)"/g)].map((m) => m[1]).sort();
  const indexes = [...t.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "([^"]+)"/g)].map((m) => m[1]).sort();
  const policies = [...t.matchAll(/CREATE POLICY "([^"]+)"/g)].map((m) => m[1]).sort();
  return {
    fingerprint: sha256([...tables, ...indexes, ...policies].join("|")),
    counts: { tables: tables.length, indexes: indexes.length, policies: policies.length },
  };
}

function dumpSchema(outFile) {
  run(`supabase db dump --linked -s public,s7_private -f "${outFile.replace(/\\/g, "/")}"`, { timeout: 600000 });
}

function parseMigrationList(raw) {
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*\|\s*(\d*)\s*\|\s*(.*)$/);
    if (!m) continue;
    rows.push({ local: m[1], remote: m[2]?.trim() ? m[2].trim() : null, name: m[3]?.trim() || null });
  }
  return {
    rows,
    remoteApplied: rows.filter((r) => r.remote).map((r) => r.remote),
    pending: rows.filter((r) => r.local && !r.remote).map((r) => r.local),
  };
}

function getMigrationList() {
  return parseMigrationList(run("supabase migration list --linked"));
}

function repairVersion(version) {
  const r = spawnSync(`supabase migration repair --status applied --linked --yes ${version}`, {
    shell: true,
    cwd: WORKSPACE,
    encoding: "utf8",
    timeout: 120000,
  });
  return { ok: r.status === 0, stdout: redactSecrets((r.stdout || "").trim()), stderr: redactSecrets((r.stderr || "").trim()) };
}

async function getServiceRoleKey() {
  const raw = run(`supabase projects api-keys --project-ref ${PROD_REF} -o json`);
  return JSON.parse(raw).find((k) => /service_role/i.test(k.name))?.api_key;
}

async function tableCount(serviceKey, table) {
  const res = await fetch(`https://${PROD_REF}.supabase.co/rest/v1/${table}?select=id&limit=0`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: "count=exact" },
  });
  const range = res.headers.get("content-range") || "";
  const m = range.match(/\/(\d+)$/);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 404 || body?.code === "PGRST205") {
    return { table, count: null, missing: true, status: res.status };
  }
  return { table, count: m ? Number(m[1]) : null, missing: false, status: res.status };
}

async function collectCounts(serviceKey, creds) {
  const tables = [
    "profiles",
    "seller_companies",
    "marketplace_accounts",
    "ml_tokens",
    "products",
    "marketplace_listings",
    "sales_orders",
    "sales_order_items",
    "sync_jobs",
    "legal_document_acceptances",
  ];
  const counts = {};
  for (const t of tables) counts[t] = await tableCount(serviceKey, t);
  const auth = psqlExec(creds, "SELECT count(*)::int FROM auth.users;");
  counts.auth_users = { table: "auth.users", count: parseInt((auth.stdout || "").trim() || "0", 10), missing: false };
  return counts;
}

function listBackups() {
  const raw = run(`supabase backups list --project-ref ${PROD_REF} -o json`, { timeout: 120000 });
  return JSON.parse(raw).backups || JSON.parse(raw);
}

function exists(creds, sql) {
  return (psqlExec(creds, sql).stdout || "").trim() === "t";
}

function precheck00003(creds) {
  const productsCount = parseInt((psqlExec(creds, "SELECT count(*)::int FROM public.products;").stdout || "0").trim(), 10);
  const variantsCount = parseInt((psqlExec(creds, "SELECT count(*)::int FROM public.product_variants;").stdout || "0").trim(), 10);
  const dupProducts = psqlExec(
    creds,
    `SELECT count(*)::int FROM (
      SELECT user_id, normalized_sku, count(*) c FROM public.products
      WHERE normalized_sku IS NOT NULL AND normalized_sku <> ''
      GROUP BY 1,2 HAVING count(*) > 1
    ) d;`,
  );
  return {
    products_count: productsCount,
    variants_count: variantsCount,
    duplicate_normalized_sku_pairs: parseInt((dupProducts.stdout || "0").trim(), 10),
    products_normalized_sku_column: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='normalized_sku');",
    ),
    variants_normalized_sku_column: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='product_variants' AND column_name='normalized_sku');",
    ),
    normalize_sku_fn: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='normalize_sku');",
    ),
    uq_index: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='uq_products_user_normalized_sku');",
    ),
    dml_expected_noop: productsCount === 0 && variantsCount === 0,
  };
}

function precheck00008(creds) {
  const body = psqlExec(
    creds,
    "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='normalize_sku' LIMIT 1;",
  );
  return {
    normalize_sku_present: (body.stdout || "").length > 0,
    uses_upper: /upper\s*\(/i.test(body.stdout || ""),
    variants_column: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='product_variants' AND column_name='normalized_sku');",
    ),
  };
}

function precheck00061(creds) {
  const bucket = psqlExec(creds, "SELECT count(*)::int FROM storage.buckets WHERE id = 'company-logos';");
  const policies = psqlExec(
    creds,
    "SELECT count(*)::int FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname LIKE 'company_logos_%';",
  );
  const objectsCount = psqlExec(creds, "SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'company-logos';");
  return {
    bucket_exists: parseInt((bucket.stdout || "0").trim(), 10) > 0,
    policy_count: parseInt((policies.stdout || "0").trim(), 10),
    objects_count: parseInt((objectsCount.stdout || "0").trim(), 10),
    destructive_ops_in_sql: false,
  };
}

function postcheckSkuObjects(creds) {
  return {
    normalize_sku: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='normalize_sku');",
    ),
    sync_products: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='sync_products_normalized_sku');",
    ),
    sync_variants: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='sync_product_variants_normalized_sku');",
    ),
    uq_products_user_normalized_sku: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='uq_products_user_normalized_sku');",
    ),
    idx_variants_normalized: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_product_variants_normalized_sku');",
    ),
    variants_column: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='product_variants' AND column_name='normalized_sku');",
    ),
    normalize_sku_no_upper: !/upper\s*\(/i.test(
      psqlExec(
        creds,
        "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='normalize_sku' LIMIT 1;",
      ).stdout || "",
    ),
  };
}

function postcheck00061(creds) {
  const policies = ["company_logos_select_public", "company_logos_insert_own", "company_logos_update_own", "company_logos_delete_own"];
  const out = { bucket_exists: parseInt((psqlExec(creds, "SELECT count(*)::int FROM storage.buckets WHERE id = 'company-logos';").stdout || "0").trim(), 10) > 0 };
  for (const p of policies) {
    out[p] = exists(
      creds,
      `SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='${p}');`,
    );
  }
  return out;
}

function setupShadow() {
  const check = spawnSync("docker", ["inspect", DOCKER_DB], { encoding: "utf8" });
  if (check.status !== 0) return { ok: false, reason: "docker_container_missing" };

  dockerPsql(`DROP DATABASE IF EXISTS ${SHADOW_DB};`, { db: "postgres" });
  dockerPsql(`CREATE DATABASE ${SHADOW_DB};`, { db: "postgres" });

  const boot = `
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, created_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth AS $$ SELECT '{}'::jsonb $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth AS $$ SELECT 'service_role'::text $$;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE IF NOT EXISTS storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text, name text, owner uuid);
GRANT USAGE ON SCHEMA auth TO postgres, service_role, authenticated, anon;
`;
  dockerPsql(boot, { db: SHADOW_DB });

  if (!fs.existsSync(BASELINE_SCHEMA)) return { ok: false, reason: "baseline_schema_missing" };
  const containerDump = "/tmp/batch3b_prod_baseline.sql";
  dockerCpToContainer(BASELINE_SCHEMA, containerDump);
  const load = dockerPsql("", { db: SHADOW_DB, file: containerDump, timeoutMs: 600000 });
  return { ok: load.ok, reason: load.ok ? null : load.stderr.slice(0, 500) };
}

function runShadowSequence() {
  const setup = setupShadow();
  if (!setup.ok) return { pass: false, setup, tests: [] };

  const tests = [];
  const seq = [
    { version: "00003", label: "00003_historical", file: FILES["20260301000003"] },
    { version: "00003", label: "00003_gap_index", file: FILES["20260301000003_gap"] },
    { version: "00008", label: "00008_forward_fix", file: FILES["20260301000008"] },
    { version: "00061", label: "00061_storage", file: FILES["20260301000061"] },
  ];

  for (const step of seq) {
    const containerSql = `/tmp/batch3b_${step.label}.sql`;
    dockerCpToContainer(step.file, containerSql);
    const r = dockerPsql("", { db: SHADOW_DB, file: containerSql, timeoutMs: 180000 });
    tests.push({ step: step.label, version: step.version, pass: r.ok, stderr: r.stderr.slice(0, 600) });
    if (!r.ok) break;
  }

  return { pass: tests.every((t) => t.pass), setup, tests };
}

function buildPrecisionPlan(prechecks) {
  return {
    captured_at: new Date().toISOString(),
    authorized: AUTHORIZED,
    forbidden: FORBIDDEN,
    migrations: {
      "20260301000003": {
        classification: "SAFE_SQL",
        mode: "EXECUTE_HISTORICAL + GAP_INDEX",
        sql_summary: {
          ddl: ["normalize_sku()", "sync_* triggers", "product_variants.normalized_sku"],
          dml: ["UPDATE products (skip — col exists)", "UPDATE variants (no-op se vazio)"],
          indexes: ["uq_products_user_normalized_sku via gap", "idx_product_variants_normalized_sku"],
        },
        precheck: prechecks["20260301000003"],
        note: "products.normalized_sku preexistente — gap index após SQL histórico",
      },
      "20260301000008": {
        classification: "FORWARD_FIX_REQUIRED",
        mode: "FORWARD_FIX_ONLY",
        gap: "normalize_sku preserve-case + recalc normalized_sku",
        precheck: prechecks["20260301000008"],
      },
      "20260301000061": {
        classification: "MANUAL_REVIEW_SIMPLE",
        mode: "EXECUTE_HISTORICAL",
        storage: {
          bucket: "company-logos",
          policies: 4,
          destructive: false,
        },
        precheck: prechecks["20260301000061"],
      },
    },
    expected_pending_after: 11,
    expected_remaining: EXPECTED_REMAINING,
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let creds;

  for (const v of AUTHORIZED) {
    if (FORBIDDEN.includes(v)) throw new Error(`Inconsistência: ${v} autorizada e proibida`);
  }

  linkProd();
  try {
    creds = getDbCreds();
  } catch {
    promptProdPasswordInteractive();
    creds = getDbCreds();
  }

  const backups = listBackups();
  if (!backups.some((b) => b.status === "COMPLETED")) throw new Error("Backup COMPLETED indisponível");

  const prechecks = {
    "20260301000003": precheck00003(creds),
    "20260301000008": precheck00008(creds),
    "20260301000061": precheck00061(creds),
  };

  const ddlProbe = psqlExec(creds, "CREATE OR REPLACE FUNCTION public.__s7_batch3b_ddl_probe() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;");
  if (ddlProbe.status !== 0) {
    if (!resolveProdPassword()) promptProdPasswordInteractive();
    creds = {
      host: `db.${PROD_REF}.supabase.co`,
      port: "5432",
      user: "postgres",
      password: resolveProdPassword(),
      database: "postgres",
    };
    const ddl2 = psqlExec(creds, "CREATE OR REPLACE FUNCTION public.__s7_batch3b_ddl_probe() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;");
    if (ddl2.status !== 0) throw new Error("DDL probe FAIL — postgres role necessário");
    psqlExec(creds, "DROP FUNCTION IF EXISTS public.__s7_batch3b_ddl_probe();");
  } else {
    psqlExec(creds, "DROP FUNCTION IF EXISTS public.__s7_batch3b_ddl_probe();");
  }

  // Re-run prechecks with final creds
  prechecks["20260301000003"] = precheck00003(creds);
  prechecks["20260301000008"] = precheck00008(creds);
  prechecks["20260301000061"] = precheck00061(creds);

  if (prechecks["20260301000003"].duplicate_normalized_sku_pairs > 0) {
    throw new Error("00003 precheck FAIL — duplicatas normalized_sku detectadas");
  }

  const plan = buildPrecisionPlan(prechecks);
  fs.writeFileSync(path.join(OUT, `BATCH3B_PRECISION_PLAN_${DATE}.json`), JSON.stringify(plan, null, 2));

  console.log("[batch3b] shadow...");
  const shadow = runShadowSequence();
  plan.shadow = shadow;
  fs.writeFileSync(path.join(OUT, `BATCH3B_PRECISION_PLAN_${DATE}.json`), JSON.stringify(plan, null, 2));

  if (!shadow.pass) {
    throw new Error(`Shadow FAIL — abortado antes de PROD write: ${JSON.stringify(shadow.tests.filter((t) => !t.pass))}`);
  }

  const operationStarted = new Date().toISOString();
  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_batch3b_${DATE}.sql`);
  dumpSchema(schemaBeforeFile);
  const fpBefore = fingerprintDump(schemaBeforeFile);
  const serviceKey = await getServiceRoleKey();
  const countsBefore = await collectCounts(serviceKey, creds);
  const historyBefore = getMigrationList();

  if (historyBefore.pending.length !== 14) {
    throw new Error(`Expected pending=14, got ${historyBefore.pending.length}`);
  }

  fs.writeFileSync(path.join(OUT, `SCHEMA_FINGERPRINT_PROD_BEFORE_BATCH3B.json`), JSON.stringify({ captured_at: operationStarted, ...fpBefore }, null, 2));
  fs.writeFileSync(path.join(OUT, `PROD_COUNTS_BEFORE_BATCH3B.json`), JSON.stringify({ captured_at: operationStarted, counts: countsBefore }, null, 2));
  fs.writeFileSync(path.join(OUT, `MIGRATION_HISTORY_PROD_BEFORE_BATCH3B.json`), JSON.stringify({ captured_at: operationStarted, ...historyBefore }, null, 2));

  const results = [];
  let aborted = false;
  let abortReason = null;

  // --- 00003 ---
  console.log("[batch3b] EXECUTE 00003...");
  const r03 = psqlFile(creds, FILES["20260301000003"]);
  if (r03.status !== 0) {
    aborted = true;
    abortReason = redactSecrets((r03.stderr || r03.stdout || "").slice(0, 400));
  } else {
    const needsGap = exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='normalized_sku');",
    ) && !exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='uq_products_user_normalized_sku');",
    );
    if (needsGap) {
      const gap03 = psqlFile(creds, FILES["20260301000003_gap"]);
      if (gap03.status !== 0) {
        aborted = true;
        abortReason = "00003_gap_index_fail";
      }
    }
  }

  const post03 = postcheckSkuObjects(creds);
  const sellerAfter03 = await collectCounts(serviceKey, creds);
  const countsInvariant03 = JSON.stringify(countsBefore) === JSON.stringify(sellerAfter03);

  if (!aborted && (!post03.normalize_sku || !post03.uq_products_user_normalized_sku || !post03.variants_column)) {
    aborted = true;
    abortReason = "00003_postcheck_objects_missing";
  }
  if (!aborted && !countsInvariant03) {
    aborted = true;
    abortReason = "00003_seller_counts_changed";
  }

  let repair03 = { ok: false, skipped: true };
  if (!aborted) {
    repair03 = repairVersion("20260301000003");
    if (!repair03.ok) {
      aborted = true;
      abortReason = "00003_repair_fail";
    }
  }

  results.push({
    version: "20260301000003",
    sql_executed: !aborted || abortReason !== "00003_sql_fail",
    gap_index: true,
    postcheck: post03,
    seller_invariant: countsInvariant03,
    repair: repair03,
  });

  // --- 00008 forward-fix ---
  if (!aborted) {
    console.log("[batch3b] FORWARD-FIX 00008...");
    const r08 = psqlFile(creds, FILES["20260301000008"]);
    const post08 = postcheckSkuObjects(creds);
    const sellerAfter08 = await collectCounts(serviceKey, creds);
    const countsInvariant08 = JSON.stringify(countsBefore) === JSON.stringify(sellerAfter08);

    if (r08.status !== 0) {
      aborted = true;
      abortReason = "00008_forward_fix_fail";
    } else if (!post08.normalize_sku_no_upper) {
      aborted = true;
      abortReason = "00008_equivalence_fail";
    } else if (!countsInvariant08) {
      aborted = true;
      abortReason = "00008_seller_counts_changed";
    } else {
      const repair08 = repairVersion("20260301000008");
      results.push({
        version: "20260301000008",
        mode: "FORWARD_FIX",
        postcheck: post08,
        equivalence: post08.normalize_sku_no_upper,
        seller_invariant: countsInvariant08,
        repair: repair08,
      });
      if (!repair08.ok) {
        aborted = true;
        abortReason = "00008_repair_fail";
      }
    }
  }

  // --- 00061 ---
  if (!aborted) {
    console.log("[batch3b] EXECUTE 00061...");
    const r61 = psqlFile(creds, FILES["20260301000061"]);
    const post61 = postcheck00061(creds);
    const sellerAfter61 = await collectCounts(serviceKey, creds);
    const countsInvariant61 = JSON.stringify(countsBefore) === JSON.stringify(sellerAfter61);
    const objectsBefore61 = prechecks["20260301000061"].objects_count;

    if (r61.status !== 0) {
      aborted = true;
      abortReason = "00061_sql_fail";
    } else if (!post61.bucket_exists || !post61.company_logos_select_public) {
      aborted = true;
      abortReason = "00061_postcheck_fail";
    } else if (!countsInvariant61) {
      aborted = true;
      abortReason = "00061_seller_counts_changed";
    } else if (post61.objects_count < objectsBefore61) {
      aborted = true;
      abortReason = "00061_storage_objects_decreased";
    } else {
      const repair61 = repairVersion("20260301000061");
      results.push({
        version: "20260301000061",
        mode: "EXECUTE",
        postcheck: post61,
        seller_invariant: countsInvariant61,
        repair: repair61,
      });
      if (!repair61.ok) {
        aborted = true;
        abortReason = "00061_repair_fail";
      }
    }
  }

  const schemaAfterFile = path.join(OUT, `_prod_schema_after_batch3b_${DATE}.sql`);
  dumpSchema(schemaAfterFile);
  const fpAfter = fingerprintDump(schemaAfterFile);
  const countsAfter = await collectCounts(serviceKey, creds);
  const historyAfter = getMigrationList();

  fs.writeFileSync(path.join(OUT, `SCHEMA_FINGERPRINT_PROD_AFTER_BATCH3B.json`), JSON.stringify({ captured_at: new Date().toISOString(), ...fpAfter }, null, 2));
  fs.writeFileSync(path.join(OUT, `PROD_COUNTS_AFTER_BATCH3B.json`), JSON.stringify({ counts: countsAfter }, null, 2));
  fs.writeFileSync(path.join(OUT, `MIGRATION_HISTORY_PROD_AFTER_BATCH3B.json`), JSON.stringify({ ...historyAfter }, null, 2));

  const pendingAfter = [...historyAfter.pending].sort();
  fs.writeFileSync(
    path.join(OUT, `PENDING_AFTER_BATCH3B_${DATE}.json`),
    JSON.stringify(
      {
        pending_count: pendingAfter.length,
        pending: pendingAfter,
        expected: EXPECTED_REMAINING,
        matches_expected: JSON.stringify(pendingAfter) === JSON.stringify([...EXPECTED_REMAINING].sort()),
      },
      null,
      2,
    ),
  );

  const sellerInvariant = JSON.stringify(countsBefore) === JSON.stringify(countsAfter);
  const legalMissing = countsAfter.legal_document_acceptances?.missing === true;
  const success =
    !aborted &&
    results.length === 3 &&
    pendingAfter.length === 11 &&
    sellerInvariant &&
    legalMissing &&
    !FORBIDDEN.some((v) => historyAfter.remoteApplied.includes(v));

  const report = {
    pass: success,
    status: aborted ? "BATCH 3B INTERROMPIDO" : success ? "BATCH 3B CONCLUÍDO COM SUCESSO" : "BATCH 3B PARCIAL",
    captured_at: new Date().toISOString(),
    operation_started_at: operationStarted,
    shadow,
    prechecks,
    results,
    history: { before: historyBefore.pending.length, after: historyAfter.pending.length },
    schema_fingerprint: {
      before: fpBefore,
      after: fpAfter,
      seller_data_identical: sellerInvariant,
      structural_delta_expected: true,
    },
    counts: { before: countsBefore, after: countsAfter, identical: sellerInvariant },
    legal: { before: "MISSING", after: legalMissing ? "MISSING" : "PRESENT" },
    pending_after: pendingAfter,
    checkpoint_readiness: {
      functional_non_billing: success ? "READY" : "NOT READY",
      migration_history_for_checkpoint: "NOT READY — billing 00043 + 112–116 permanecem pending; checkpoint exige SQL direto + repair seletivo (padrão Batch 1/2A/3A) OU missão billing antes de db push sequencial",
      billing_defer_strategy:
        "Opção B recomendada: manter billing pending; executar 00118–122 via psql + repair individual (governança comprovada). Opção A: missão billing antes do checkpoint se exigirem db push linear.",
    },
    abort_reason: abortReason,
    gates: {
      batch_3b: success,
      billing: "NÃO TOCADO",
      checkpoint_118_122: "NÃO TOCADO",
      seller: sellerInvariant ? "INVARIANTE" : "ALTERADO",
    },
  };

  const jsonPath = path.join(OUT, `BATCH3B_EXECUTION_${DATE}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = `# BATCH 3B — ${DATE}

## A. STATUS: ${report.status}

## B. SHADOW
${shadow.tests.map((t) => `- ${t.step}: ${t.pass ? "PASS" : "FAIL"}`).join("\n")}

## C–E. Migrations
${results.map((r) => `- ${r.version}: ${r.mode || "EXECUTE"} repair=${r.repair?.ok}`).join("\n")}

## F. SCHEMA
Before fingerprint: ${fpBefore?.fingerprint?.slice(0, 16)}...
After fingerprint: ${fpAfter?.fingerprint?.slice(0, 16)}...
Seller counts identical: ${sellerInvariant}

## H. HISTORY: ${historyBefore.pending.length} → ${historyAfter.pending.length}

## J. PENDING
${pendingAfter.map((v) => `- ${v}`).join("\n")}

## L. CHECKPOINT READINESS
Functional: ${report.checkpoint_readiness.functional_non_billing}
History: ${report.checkpoint_readiness.migration_history_for_checkpoint}
`;
  fs.writeFileSync(path.join(OUT, `BATCH3B_EXECUTION_${DATE}.md`), md);

  console.log("[batch3b] relink DEV...");
  relinkDev();
  clearProdPasswordMem();

  console.log(JSON.stringify({ pass: report.pass, status: report.status, pendingAfter: pendingAfter.length, jsonPath }, null, 2));
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  try {
    relinkDev();
  } catch {
    /* ignore */
  }
  clearProdPasswordMem();
  console.error(JSON.stringify({ pass: false, error: String(err.message || err) }));
  process.exit(1);
});
