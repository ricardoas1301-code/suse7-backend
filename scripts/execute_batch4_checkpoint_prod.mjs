#!/usr/bin/env node
/**
 * BATCH 4 PROD — CHECKPOINT ONBOARDING / PRÉ-SYNC
 * 00118 → 00119 → 00120 → 00121 → 00122
 * Uma migration por vez · SQL → postcheck → repair.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validarIndiceMlGlobalUnique } from "./lib/validar_indice_ml_global_unique.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260818";
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const MIGRATIONS_DIR = path.join(WORKSPACE, "supabase", "migrations");
const PROD_REF = "bazibzquasbdgjwdcwbz";
const DEV_REF = "alkelcaoexxbamqddaqv";
const PROD_NAME = "Suse7-prod";
const SHADOW_DB = "s7_shadow_batch4_20260818";
const DOCKER_DB = "supabase_db_supabase-local-replay-workspace";

const AUTHORIZED = [
  "20260301000118",
  "20260301000119",
  "20260301000120",
  "20260301000121",
  "20260301000122",
];

const FORBIDDEN_BILLING = [
  "20260301000043",
  "20260301000112",
  "20260301000113",
  "20260301000114",
  "20260301000115",
  "20260301000116",
];

const EXPECTED_REMAINING = [...FORBIDDEN_BILLING];

const FILES = {
  "20260301000118": path.join(MIGRATIONS_DIR, "20260301000118_legal_document_acceptances.sql"),
  "20260301000119": path.join(MIGRATIONS_DIR, "20260301000119_s7_security_exposure_preconnect_hardening.sql"),
  "20260301000120": path.join(MIGRATIONS_DIR, "20260301000120_s7_signup_pending_births_two_phase.sql"),
  "20260301000121": path.join(MIGRATIONS_DIR, "20260301000121_profiles_onboarding_configuration_latches.sql"),
  "20260301000122": path.join(MIGRATIONS_DIR, "20260301000122_marketplace_accounts_global_ml_external_active_uidx.sql"),
};

const BASELINE_SCHEMA = path.join(OUT, "_prod_schema_after_batch3b_20260817.sql");

const LEGACY_SERVICE_ROLE_ONLY = [
  "get_ml_token_for_user",
  "refresh_ml_tokens_for_user",
  "iniciar_teste_gratis",
  "reset_monthly_usage",
  "register_log",
  "registrar_precificacao",
  "delete_old_logs",
  "calcular_precificacao_automatica",
  "verificar_limite_plano",
];

const TENANT_AUTHENTICATED_RPCS = [
  "update_product_image_links_sort_order",
  "update_product_variants_sort_order",
  "s7_sales_order_items_page_v1",
  "s7_vendas_search_order_ids_v1",
];

const SIGNUP_RPCS = [
  "s7_signup_pending_birth_create",
  "s7_signup_pending_birth_bind",
  "s7_signup_pending_birth_abort",
  "s7_complete_signup_birth_once",
];

const LATCH_COLUMNS = [
  "operational_cycle_configured_at",
  "first_marketplace_connected_at",
  "initial_configuration_completed_at",
];

let prodDbPasswordMem = null;

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/PGPASSWORD="[^"]+"/g, 'PGPASSWORD="[REDACTED]"')
    .replace(/PGPASSWORD=[^\s]+/g, "PGPASSWORD=[REDACTED]")
    .replace(/apikey:\s*\S+/gi, "apikey: [REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
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
  if (r.status !== 0 || !pass) throw new Error("Senha postgres PROD nao informada — Batch 4 abortado");
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

function exists(creds, sql) {
  return (psqlExec(creds, sql).stdout || "").trim() === "t";
}

function fingerprintDump(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const t = fs.readFileSync(filePath, "utf8");
  const tables = [...t.matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)"/g)].map((m) => m[1]).sort();
  const indexes = [...t.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "([^"]+)"/g)].map((m) => m[1]).sort();
  const policies = [...t.matchAll(/CREATE POLICY "([^"]+)"/g)].map((m) => m[1]).sort();
  const functions = [...t.matchAll(/CREATE OR REPLACE FUNCTION "([^"]+)"\."([^"]+)"/g)].map((m) => `${m[1]}.${m[2]}`).sort();
  return {
    fingerprint: sha256([...tables, ...indexes, ...policies, ...functions].join("|")),
    counts: { tables: tables.length, indexes: indexes.length, policies: policies.length, functions: functions.length },
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

async function collectCounts(serviceKey) {
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
  return counts;
}

async function collectCountsWithAuth(creds, serviceKey) {
  const counts = await collectCounts(serviceKey);
  const auth = psqlExec(creds, "SELECT count(*)::int FROM auth.users;");
  counts.auth_users = { table: "auth.users", count: parseInt((auth.stdout || "").trim() || "0", 10), missing: false };
  return counts;
}

function listBackups() {
  const raw = run(`supabase backups list --project-ref ${PROD_REF} -o json`, { timeout: 120000 });
  const parsed = JSON.parse(raw);
  return parsed.backups || parsed;
}

function probeCheckpointObjects(creds) {
  return {
    legal_document_acceptances: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='legal_document_acceptances');",
    ),
    signup_pending_births: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='s7_private' AND table_name='signup_pending_births');",
    ),
    s7_complete_signup_birth_once: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='s7_complete_signup_birth_once');",
    ),
    latch_operational_cycle: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='operational_cycle_configured_at');",
    ),
    latch_first_marketplace: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='first_marketplace_connected_at');",
    ),
    latch_initial_configuration: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='initial_configuration_completed_at');",
    ),
    ml_global_unique_index: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='marketplace_accounts_global_active_external_uidx');",
    ),
  };
}

function setupShadow() {
  const check = spawnSync("docker", ["inspect", DOCKER_DB], { encoding: "utf8" });
  if (check.status !== 0) return { ok: false, reason: "docker_container_missing" };
  if (!fs.existsSync(BASELINE_SCHEMA)) return { ok: false, reason: "baseline_schema_missing" };

  dockerPsql(`DROP DATABASE IF EXISTS ${SHADOW_DB};`, { db: "postgres" });
  dockerPsql(`CREATE DATABASE ${SHADOW_DB};`, { db: "postgres" });

  const boot = `
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, created_at timestamptz DEFAULT now(), email_confirmed_at timestamptz, confirmed_at timestamptz);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth AS $$ SELECT '{}'::jsonb $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth AS $$ SELECT 'service_role'::text $$;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE IF NOT EXISTS storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text, name text, owner uuid);
GRANT USAGE ON SCHEMA auth TO postgres, service_role, authenticated, anon;
`;
  dockerPsql(boot, { db: SHADOW_DB });

  const containerDump = "/tmp/batch4_prod_baseline.sql";
  dockerCpToContainer(BASELINE_SCHEMA, containerDump);
  const load = dockerPsql("", { db: SHADOW_DB, file: containerDump, timeoutMs: 900000 });
  return { ok: load.ok, reason: load.ok ? null : load.stderr.slice(0, 500) };
}

function runShadowSequence() {
  const setup = setupShadow();
  if (!setup.ok) return { pass: false, setup, tests: [] };

  const tests = [];
  const seq = AUTHORIZED.map((v) => ({
    version: v,
    label: v.slice(-5),
    file: FILES[v],
  }));

  for (const step of seq) {
    const containerSql = `/tmp/batch4_${step.label}.sql`;
    dockerCpToContainer(step.file, containerSql);
    const r = dockerPsql("", { db: SHADOW_DB, file: containerSql, timeoutMs: 300000 });
    tests.push({ step: step.label, version: step.version, pass: r.ok, stderr: r.stderr.slice(0, 600) });
    if (!r.ok) break;
  }

  return { pass: tests.length === 5 && tests.every((t) => t.pass), setup, tests };
}

function fnHasGrant(creds, schema, name, grantee) {
  const r = psqlExec(
    creds,
    `SELECT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = '${schema}' AND p.proname = '${name}' AND r.rolname = '${grantee}' AND a.privilege_type = 'EXECUTE'
    );`,
  );
  return (r.stdout || "").trim() === "t";
}

function fnHasAnonGrant(creds, schema, name) {
  return fnHasGrant(creds, schema, name, "anon");
}

function postcheck00118(creds) {
  const cols = psqlExec(
    creds,
    `SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='legal_document_acceptances';`,
  );
  const rowCount = parseInt((psqlExec(creds, "SELECT count(*)::int FROM public.legal_document_acceptances;").stdout || "0").trim(), 10);
  return {
    table_exists: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='legal_document_acceptances');",
    ),
    pk_on_id: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.legal_document_acceptances'::regclass AND contype='p');",
    ),
    fk_user_id: exists(
      creds,
      `SELECT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = 'public.legal_document_acceptances'::regclass
          AND c.contype = 'f' AND a.attname = 'user_id'
      );`,
    ),
    columns: (cols.stdout || "").trim(),
    idx_user_id: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='legal_document_acceptances_user_id_idx');",
    ),
    idx_user_doc: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='legal_document_acceptances_user_doc_idx');",
    ),
    rls_enabled: exists(
      creds,
      "SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='legal_document_acceptances';",
    ),
    policy_select_own: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='legal_document_acceptances' AND policyname='legal_document_acceptances_select_own');",
    ),
    policy_insert_own: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='legal_document_acceptances' AND policyname='legal_document_acceptances_insert_own');",
    ),
    row_count: rowCount,
    checks_count: parseInt(
      (psqlExec(
        creds,
        "SELECT count(*)::int FROM pg_constraint WHERE conrelid='public.legal_document_acceptances'::regclass AND contype='c';",
      ).stdout || "0").trim(),
      10,
    ),
  };
}

function postcheck00119(creds) {
  const legacy = {};
  for (const fn of LEGACY_SERVICE_ROLE_ONLY) {
    legacy[fn] = {
      exists: exists(
        creds,
        `SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${fn}');`,
      ),
      anon_execute: fnHasAnonGrant(creds, "public", fn),
      service_role_execute: fnHasGrant(creds, "public", fn, "service_role"),
    };
  }
  const tenant = {};
  for (const fn of TENANT_AUTHENTICATED_RPCS) {
    tenant[fn] = {
      exists: exists(
        creds,
        `SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${fn}');`,
      ),
      anon_execute: fnHasAnonGrant(creds, "public", fn),
      authenticated_execute: fnHasGrant(creds, "public", fn, "authenticated"),
    };
  }
  const searchPathSample = psqlExec(
    creds,
    "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='normalize_sku' LIMIT 1;",
  );
  return {
    apply_lockdown_fn: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='s7_private' AND p.proname='apply_service_role_only_lockdown');",
    ),
    legacy_service_role_only: legacy,
    tenant_authenticated_rpcs: tenant,
    normalize_sku_search_path: /SET search_path = public, pg_temp/i.test(searchPathSample.stdout || ""),
    legacy_anon_exposure: Object.values(legacy).some((x) => x.anon_execute),
    tenant_anon_exposure: Object.values(tenant).some((x) => x.anon_execute),
  };
}

function postcheck00120(creds) {
  const rpcTest = psqlExec(
    creds,
    "SELECT public.s7_complete_signup_birth_once('00000000-0000-0000-0000-000000000000'::uuid)::text;",
  );
  let synthetic = null;
  try {
    synthetic = JSON.parse((rpcTest.stdout || "").trim());
  } catch {
    synthetic = { parse_error: true, raw: (rpcTest.stdout || "").slice(0, 200) };
  }
  return {
    schema_s7_private: exists(creds, "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name='s7_private');"),
    table_signup_pending_births: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='s7_private' AND table_name='signup_pending_births');",
    ),
    idx_auth_user_uniq: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='s7_private' AND c.relname='signup_pending_births_auth_user_id_uniq');",
    ),
    idx_email_status: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='s7_private' AND c.relname='signup_pending_births_email_status_idx');",
    ),
    idx_expires: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='s7_private' AND c.relname='signup_pending_births_expires_idx');",
    ),
    rpcs: Object.fromEntries(
      [...SIGNUP_RPCS, "bootstrap_signup_primary_recipients"].map((fn) => [
        fn,
        exists(
          creds,
          `SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','s7_private') AND p.proname='${fn}');`,
        ),
      ]),
    ),
    synthetic_complete_signup: synthetic,
    pending_births_count: parseInt(
      (psqlExec(creds, "SELECT count(*)::int FROM s7_private.signup_pending_births;").stdout || "0").trim(),
      10,
    ),
  };
}

function postcheck00121(creds) {
  const profile = psqlExec(
    creds,
    `SELECT count(*)::int,
            count(*) FILTER (WHERE operational_cycle_configured_at IS NOT NULL)::int,
            count(*) FILTER (WHERE first_marketplace_connected_at IS NOT NULL)::int,
            count(*) FILTER (WHERE initial_configuration_completed_at IS NOT NULL)::int
     FROM public.profiles;`,
  );
  const parts = (profile.stdout || "0|0|0|0|0").split("|").map((x) => parseInt(x.trim(), 10));
  const colMeta = {};
  for (const col of LATCH_COLUMNS) {
    const r = psqlExec(
      creds,
      `SELECT data_type, is_nullable, column_default IS NOT NULL
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='profiles' AND column_name='${col}';`,
    );
    const [dataType, nullable, hasDefault] = (r.stdout || "").split("|").map((s) => s.trim());
    colMeta[col] = { data_type: dataType, nullable: nullable === "YES", has_default: hasDefault === "t" };
  }
  return {
    columns: colMeta,
    profile_count: parts[0] || 0,
    latches_non_null: {
      operational_cycle_configured_at: parts[1] || 0,
      first_marketplace_connected_at: parts[2] || 0,
      initial_configuration_completed_at: parts[3] || 0,
    },
    configuration_snapshot_contract: {
      all_latch_columns_exist: LATCH_COLUMNS.every((c) => colMeta[c]?.data_type === "timestamp with time zone"),
      no_artificial_completion: (parts[1] || 0) === 0 && (parts[2] || 0) === 0 && (parts[3] || 0) === 0,
    },
  };
}

function precheck00122(creds) {
  const dup = psqlExec(
    creds,
    `SELECT count(*)::int FROM (
      SELECT marketplace, external_seller_id, count(*) c
      FROM public.marketplace_accounts
      WHERE status IS DISTINCT FROM 'removed'
      GROUP BY 1, 2
      HAVING count(*) > 1
    ) d;`,
  );
  const total = parseInt((psqlExec(creds, "SELECT count(*)::int FROM public.marketplace_accounts;").stdout || "0").trim(), 10);
  return {
    marketplace_accounts_total: total,
    duplicate_active_pairs: parseInt((dup.stdout || "0").trim(), 10),
    safe_to_create_index: parseInt((dup.stdout || "0").trim(), 10) === 0,
  };
}

function postcheck00122(creds) {
  const idxDef = psqlExec(
    creds,
    "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='marketplace_accounts_global_active_external_uidx';",
  );
  const indexExists = exists(
    creds,
    "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='marketplace_accounts_global_active_external_uidx');",
  );
  const semantic = validarIndiceMlGlobalUnique({
    index_exists: indexExists,
    index_definition: (idxDef.stdout || "").trim(),
  });
  return {
    index_exists: indexExists,
    index_definition: semantic.index_definition,
    predicate_correct: semantic.predicate_ok,
    columns_ok: semantic.columns_ok,
    unique: semantic.unique,
    semantic_pass: semantic.pass,
    predicate_normalized: semantic.predicate_normalized,
    marketplace_accounts_count: parseInt((psqlExec(creds, "SELECT count(*)::int FROM public.marketplace_accounts;").stdout || "0").trim(), 10),
  };
}

function sellerCountsInvariant(before, after) {
  const keys = [
    "auth_users",
    "profiles",
    "seller_companies",
    "marketplace_accounts",
    "ml_tokens",
    "products",
    "marketplace_listings",
    "sales_orders",
    "sales_order_items",
  ];
  for (const k of keys) {
    if ((before[k]?.count ?? null) !== (after[k]?.count ?? null)) return false;
  }
  return true;
}

function assertProdProject() {
  linkProd();
  const raw = run(`supabase projects list -o json`);
  const projects = JSON.parse(raw);
  const linked = projects.find((p) => p.ref === PROD_REF);
  if (!linked) throw new Error(`Project ref ${PROD_REF} nao encontrado`);
  if (!/prod/i.test(linked.name || "")) throw new Error(`Confirmacao PROD falhou: ${linked.name}`);
  return { ref: PROD_REF, name: linked.name };
}

async function ensurePostgresCreds(creds) {
  const ddlProbe = psqlExec(creds, "CREATE OR REPLACE FUNCTION public.__s7_batch4_ddl_probe() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;");
  if (ddlProbe.status !== 0) {
    if (!resolveProdPassword()) promptProdPasswordInteractive();
    return {
      host: `db.${PROD_REF}.supabase.co`,
      port: "5432",
      user: "postgres",
      password: resolveProdPassword(),
      database: "postgres",
    };
  }
  psqlExec(creds, "DROP FUNCTION IF EXISTS public.__s7_batch4_ddl_probe();");
  return creds;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  for (const v of AUTHORIZED) {
    if (!fs.existsSync(FILES[v])) throw new Error(`Migration file missing: ${FILES[v]}`);
  }

  const project = assertProdProject();
  let creds;
  try {
    creds = getDbCreds();
  } catch {
    promptProdPasswordInteractive();
    creds = getDbCreds();
  }
  creds = await ensurePostgresCreds(creds);

  const backups = listBackups();
  const completedBackups = backups.filter((b) => b.status === "COMPLETED");
  if (completedBackups.length === 0) throw new Error("Backup COMPLETED indisponivel");

  const backupInfo = {
    pitr_available: true,
    completed_backups: completedBackups.length,
    latest_completed_at: completedBackups[0]?.inserted_at || completedBackups[0]?.created_at || null,
    note: "Supabase managed backup + PITR disponivel no projeto PROD",
  };

  console.log("[batch4] shadow...");
  const shadow = runShadowSequence();
  if (!shadow.pass) {
    throw new Error(`Shadow FAIL — abortado antes de PROD write: ${JSON.stringify(shadow.tests.filter((t) => !t.pass))}`);
  }

  const operationStarted = new Date().toISOString();
  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_batch4_${DATE}.sql`);
  dumpSchema(schemaBeforeFile);
  const fpBefore = fingerprintDump(schemaBeforeFile);
  const serviceKey = await getServiceRoleKey();
  const countsBefore = await collectCountsWithAuth(creds, serviceKey);
  const historyBefore = getMigrationList();
  const probesBefore = probeCheckpointObjects(creds);

  if (historyBefore.pending.length !== 11) {
    throw new Error(`Expected pending=11, got ${historyBefore.pending.length}: ${historyBefore.pending.join(",")}`);
  }
  if (!countsBefore.legal_document_acceptances?.missing) {
    throw new Error("00118 precheck FAIL — legal_document_acceptances ja existe");
  }
  if (probesBefore.legal_document_acceptances) {
    throw new Error("00118 precheck FAIL — legal table probe inconsistente");
  }

  fs.writeFileSync(path.join(OUT, `SCHEMA_FINGERPRINT_PROD_BEFORE_BATCH4.json`), JSON.stringify({ captured_at: operationStarted, project, ...fpBefore }, null, 2));
  fs.writeFileSync(path.join(OUT, `PROD_COUNTS_BEFORE_BATCH4.json`), JSON.stringify({ captured_at: operationStarted, counts: countsBefore }, null, 2));
  fs.writeFileSync(path.join(OUT, `MIGRATION_HISTORY_PROD_BEFORE_BATCH4.json`), JSON.stringify({ captured_at: operationStarted, ...historyBefore }, null, 2));

  const results = [];
  let aborted = false;
  let abortReason = null;

  function pushResult(entry) {
    results.push(entry);
  }

  // --- 00118 ---
  console.log("[batch4] EXECUTE 00118...");
  const r118 = psqlFile(creds, FILES["20260301000118"]);
  const post118 = postcheck00118(creds);
  const countsAfter118 = await collectCountsWithAuth(creds, serviceKey);
  const seller118 = sellerCountsInvariant(countsBefore, countsAfter118);

  if (r118.status !== 0) {
    aborted = true;
    abortReason = redactSecrets((r118.stderr || r118.stdout || "").slice(0, 400));
  } else if (!post118.table_exists || !post118.pk_on_id || !post118.fk_user_id || !post118.rls_enabled) {
    aborted = true;
    abortReason = "00118_postcheck_objects_missing";
  } else if (!post118.policy_select_own || !post118.policy_insert_own) {
    aborted = true;
    abortReason = "00118_policies_missing";
  } else if (post118.row_count !== 0) {
    aborted = true;
    abortReason = "00118_unexpected_rows";
  } else if (!seller118) {
    aborted = true;
    abortReason = "00118_seller_counts_changed";
  }

  let repair118 = { ok: false, skipped: true };
  if (!aborted) {
    repair118 = repairVersion("20260301000118");
    if (!repair118.ok) {
      aborted = true;
      abortReason = "00118_repair_fail";
    }
  }
  pushResult({ version: "20260301000118", postcheck: post118, seller_invariant: seller118, repair: repair118 });

  // --- 00119 ---
  if (!aborted) {
    console.log("[batch4] EXECUTE 00119...");
    const inventory119 = postcheck00119(creds);
    const r119 = psqlFile(creds, FILES["20260301000119"]);
    const post119 = postcheck00119(creds);
    const countsAfter119 = await collectCountsWithAuth(creds, serviceKey);
    const seller119 = sellerCountsInvariant(countsBefore, countsAfter119);

    if (r119.status !== 0) {
      aborted = true;
      abortReason = "00119_sql_fail";
    } else if (post119.legacy_anon_exposure || post119.tenant_anon_exposure) {
      aborted = true;
      abortReason = "00119_anon_exposure_detected";
    } else if (!seller119) {
      aborted = true;
      abortReason = "00119_seller_counts_changed";
    } else {
      const repair119 = repairVersion("20260301000119");
      pushResult({ version: "20260301000119", inventory_before: inventory119, postcheck: post119, seller_invariant: seller119, repair: repair119 });
      if (!repair119.ok) {
        aborted = true;
        abortReason = "00119_repair_fail";
      }
    }
  }

  // --- 00120 ---
  if (!aborted) {
    console.log("[batch4] EXECUTE 00120...");
    const r120 = psqlFile(creds, FILES["20260301000120"]);
    const post120 = postcheck00120(creds);
    const countsAfter120 = await collectCountsWithAuth(creds, serviceKey);
    const seller120 = sellerCountsInvariant(countsBefore, countsAfter120);

    if (r120.status !== 0) {
      aborted = true;
      abortReason = "00120_sql_fail";
    } else if (!post120.table_signup_pending_births || !post120.rpcs.s7_complete_signup_birth_once) {
      aborted = true;
      abortReason = "00120_postcheck_objects_missing";
    } else if (post120.synthetic_complete_signup?.code !== "INVALID_USER_ID" && post120.synthetic_complete_signup?.code !== "USER_NOT_FOUND") {
      aborted = true;
      abortReason = "00120_synthetic_rpc_unexpected";
    } else if (post120.pending_births_count !== 0) {
      aborted = true;
      abortReason = "00120_pending_births_nonzero";
    } else if (!seller120) {
      aborted = true;
      abortReason = "00120_seller_counts_changed";
    } else {
      const repair120 = repairVersion("20260301000120");
      pushResult({ version: "20260301000120", postcheck: post120, seller_invariant: seller120, repair: repair120 });
      if (!repair120.ok) {
        aborted = true;
        abortReason = "00120_repair_fail";
      }
    }
  }

  // --- 00121 ---
  if (!aborted) {
    console.log("[batch4] EXECUTE 00121...");
    const r121 = psqlFile(creds, FILES["20260301000121"]);
    const post121 = postcheck00121(creds);
    const countsAfter121 = await collectCountsWithAuth(creds, serviceKey);
    const seller121 = sellerCountsInvariant(countsBefore, countsAfter121);

    if (r121.status !== 0) {
      aborted = true;
      abortReason = "00121_sql_fail";
    } else if (!post121.configuration_snapshot_contract.all_latch_columns_exist) {
      aborted = true;
      abortReason = "00121_latch_columns_missing";
    } else if (!post121.configuration_snapshot_contract.no_artificial_completion) {
      aborted = true;
      abortReason = "00121_artificial_latch_completion";
    } else if (post121.profile_count !== 1) {
      aborted = true;
      abortReason = "00121_profile_count_changed";
    } else if (!seller121) {
      aborted = true;
      abortReason = "00121_seller_counts_changed";
    } else {
      const repair121 = repairVersion("20260301000121");
      pushResult({ version: "20260301000121", postcheck: post121, seller_invariant: seller121, repair: repair121 });
      if (!repair121.ok) {
        aborted = true;
        abortReason = "00121_repair_fail";
      }
    }
  }

  // --- 00122 ---
  if (!aborted) {
    console.log("[batch4] PRECHECK + EXECUTE 00122...");
    const pre122 = precheck00122(creds);
    if (!pre122.safe_to_create_index) {
      aborted = true;
      abortReason = "00122_duplicate_conflict";
      pushResult({ version: "20260301000122", precheck: pre122, skipped: true });
    } else {
      const r122 = psqlFile(creds, FILES["20260301000122"]);
      const post122 = postcheck00122(creds);
      const countsAfter122 = await collectCountsWithAuth(creds, serviceKey);
      const seller122 = sellerCountsInvariant(countsBefore, countsAfter122);

      if (r122.status !== 0) {
        aborted = true;
        abortReason = "00122_sql_fail";
      } else if (!post122.semantic_pass) {
        aborted = true;
        abortReason = "00122_postcheck_semantic_fail";
      } else if (!seller122) {
        aborted = true;
        abortReason = "00122_seller_counts_changed";
      } else {
        const repair122 = repairVersion("20260301000122");
        pushResult({ version: "20260301000122", precheck: pre122, postcheck: post122, seller_invariant: seller122, repair: repair122 });
        if (!repair122.ok) {
          aborted = true;
          abortReason = "00122_repair_fail";
        }
      }
    }
  }

  const schemaAfterFile = path.join(OUT, `_prod_schema_after_batch4_${DATE}.sql`);
  dumpSchema(schemaAfterFile);
  const fpAfter = fingerprintDump(schemaAfterFile);
  const countsAfter = await collectCountsWithAuth(creds, serviceKey);
  const historyAfter = getMigrationList();
  const probesAfter = probeCheckpointObjects(creds);

  fs.writeFileSync(path.join(OUT, `SCHEMA_FINGERPRINT_PROD_AFTER_BATCH4.json`), JSON.stringify({ captured_at: new Date().toISOString(), ...fpAfter }, null, 2));
  fs.writeFileSync(path.join(OUT, `PROD_COUNTS_AFTER_BATCH4.json`), JSON.stringify({ counts: countsAfter }, null, 2));
  fs.writeFileSync(path.join(OUT, `MIGRATION_HISTORY_PROD_AFTER_BATCH4.json`), JSON.stringify({ ...historyAfter }, null, 2));

  const pendingAfter = [...historyAfter.pending].sort();
  fs.writeFileSync(
    path.join(OUT, `PENDING_AFTER_BATCH4_${DATE}.json`),
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

  const postcheckArtifact = {
    captured_at: new Date().toISOString(),
    legal: postcheck00118(creds),
    security: postcheck00119(creds),
    signup: postcheck00120(creds),
    latches: postcheck00121(creds),
    ml_unique: { precheck: precheck00122(creds), postcheck: postcheck00122(creds) },
    probes: probesAfter,
  };
  fs.writeFileSync(path.join(OUT, `CHECKPOINT_118_122_POSTCHECK_${DATE}.json`), JSON.stringify(postcheckArtifact, null, 2));

  const sellerInvariant = sellerCountsInvariant(countsBefore, countsAfter);
  const legalExistsZeroRows =
    !countsAfter.legal_document_acceptances?.missing && countsAfter.legal_document_acceptances?.count === 0;
  const billingUntouched = FORBIDDEN_BILLING.every((v) => !historyAfter.remoteApplied.includes(v));
  const checkpointApplied = AUTHORIZED.every((v) => historyAfter.remoteApplied.includes(v));
  const success =
    !aborted &&
    results.length === 5 &&
    pendingAfter.length === 6 &&
    sellerInvariant &&
    legalExistsZeroRows &&
    billingUntouched &&
    checkpointApplied &&
    probesAfter.legal_document_acceptances &&
    probesAfter.s7_complete_signup_birth_once &&
    probesAfter.ml_global_unique_index;

  const report = {
    pass: success,
    status: aborted ? "BATCH 4 INTERROMPIDO" : success ? "BATCH 4 CONCLUÍDO COM SUCESSO" : "BATCH 4 PARCIAL",
    captured_at: new Date().toISOString(),
    operation_started_at: operationStarted,
    project,
    backup: backupInfo,
    shadow,
    probes_before: probesBefore,
    probes_after: probesAfter,
    results,
    history: { before: historyBefore.pending.length, after: historyAfter.pending.length },
    schema_fingerprint: { before: fpBefore, after: fpAfter },
    counts: { before: countsBefore, after: countsAfter, seller_invariant: sellerInvariant },
    legal: {
      before: "MISSING",
      after: legalExistsZeroRows ? "EXISTS rows=0" : countsAfter.legal_document_acceptances?.missing ? "MISSING" : "EXISTS",
    },
    pending_after: pendingAfter,
    abort_reason: abortReason,
    gates: {
      batch_4: success,
      billing: billingUntouched ? "NÃO TOCADO" : "ALTERADO",
      terms_real: "NÃO",
      signup_real: "NÃO",
      oauth_real: "NÃO",
      initial_sync: "NÃO",
      commit: "NÃO",
      push: "NÃO",
      deploy: "NÃO",
    },
  };

  const jsonPath = path.join(OUT, `BATCH4_CHECKPOINT_EXECUTION_${DATE}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = `# BATCH 4 — CHECKPOINT ONBOARDING / PRÉ-SYNC — ${DATE}

## A. STATUS: ${report.status}

pass=${report.pass}

## B. BACKUP/PITR
- completed_backups: ${backupInfo.completed_backups}
- latest: ${backupInfo.latest_completed_at}
- PITR: ${backupInfo.pitr_available}

## C. SHADOW
${shadow.tests.map((t) => `- ${t.version}: ${t.pass ? "PASS" : "FAIL"}`).join("\n")}

## D–H. Migrations
${results.map((r) => `- ${r.version}: repair=${r.repair?.ok ?? "skipped"}`).join("\n")}

## I. SCHEMA
Before: ${fpBefore?.fingerprint}
After: ${fpAfter?.fingerprint}
Tables: ${fpBefore?.counts?.tables} → ${fpAfter?.counts?.tables}
Indexes: ${fpBefore?.counts?.indexes} → ${fpAfter?.counts?.indexes}
Policies: ${fpBefore?.counts?.policies} → ${fpAfter?.counts?.policies}

## J. COUNTS
Seller invariant: ${sellerInvariant}
Legal: ${report.legal.after}

## L. HISTORY: ${historyBefore.pending.length} → ${historyAfter.pending.length}

## M. PENDING
${pendingAfter.map((v) => `- ${v}`).join("\n")}

## N. BILLING: ${report.gates.billing}

## S. GATES
${Object.entries(report.gates).map(([k, v]) => `- ${k}: ${v}`).join("\n")}
`;
  fs.writeFileSync(path.join(OUT, `BATCH4_CHECKPOINT_EXECUTION_${DATE}.md`), md);

  console.log("[batch4] relink DEV...");
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
