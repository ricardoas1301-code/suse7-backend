#!/usr/bin/env node
/**
 * BATCH 2B1 PROD — FORWARD-FIX controlado (00004, 00005, 00009, 00027).
 * Usa _shadow_forward_fix_*.sql do manifest. Não executa migration histórica completa.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260817";
const MANIFEST = path.join(OUT, `MIGRATION_EXECUTION_MANIFEST_${DATE}.json`);
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const PROD_REF = "bazibzquasbdgjwdcwbz";
const PROD_NAME = "Suse7-prod";
const DEV_REF = "alkelcaoexxbamqddaqv";
const SHADOW_DB = "s7_shadow_batch2b1_20260817";
const DOCKER_DB_CANDIDATES = [
  "supabase_db_supabase-local-replay-workspace",
  "supabase_db_supabase-hosted-v2-workspace",
];

const AUTHORIZED = [
  { version: "20260301000004", name: "core_schema_bootstrap", fixFile: "_shadow_forward_fix_20260301000004.sql" },
  { version: "20260301000005", name: "plans_commercial_schema_bootstrap", fixFile: "_shadow_forward_fix_20260301000005.sql" },
  { version: "20260301000009", name: "ml_tokens_marketplace_composite_unique", fixFile: "_shadow_forward_fix_20260301000009.sql" },
  { version: "20260301000027", name: "dev_center_v2_status_exec_history", fixFile: "_shadow_forward_fix_20260301000027.sql" },
];

let prodDbPasswordMem = null;
let dockerDbContainer = null;

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/PGPASSWORD="[^"]+"/g, 'PGPASSWORD="[REDACTED]"')
    .replace(/PGPASSWORD=[^\s]+/g, "PGPASSWORD=[REDACTED]");
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
  if (r.status !== 0 || !pass) throw new Error("Senha postgres PROD nao informada — Batch 2B1 abortado");
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

function getDbCreds() {
  const dbPassword = resolveProdPassword();
  if (!dbPassword) throw new Error("Credencial postgres PROD ausente");
  return {
    host: `db.${PROD_REF}.supabase.co`,
    port: "5432",
    user: "postgres",
    password: dbPassword,
    database: "postgres",
    role: "postgres",
  };
}

function psqlProd(creds, sql) {
  return spawnSync(
    "docker",
    [
      "run", "--rm", "--network", "host", "-e", `PGPASSWORD=${creds.password}`,
      "postgres:17", "psql", "-h", creds.host, "-p", creds.port, "-U", creds.user, "-d", creds.database,
      "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql,
    ],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
}

function psqlProdFile(creds, content) {
  return spawnSync(
    "docker",
    [
      "run", "--rm", "--network", "host", "-i", "-e", `PGPASSWORD=${creds.password}`,
      "postgres:17", "psql", "-h", creds.host, "-p", creds.port, "-U", creds.user, "-d", creds.database,
      "-v", "ON_ERROR_STOP=1", "-f", "-",
    ],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, input: content },
  );
}

function resolveDockerDbContainer() {
  if (dockerDbContainer) return dockerDbContainer;
  const r = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const names = (r.stdout || "").split(/\r?\n/).filter(Boolean);
  dockerDbContainer = DOCKER_DB_CANDIDATES.find((n) => names.includes(n)) || null;
  return dockerDbContainer;
}

function dockerShadowPsql(sql, { db = SHADOW_DB, file = null } = {}) {
  const container = resolveDockerDbContainer();
  if (!container) return { ok: false, stderr: "shadow docker container missing", status: 1, stdout: "" };
  const args = ["exec", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-d", db];
  if (file) args.push("-f", file);
  else args.push("-c", sql);
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), status: r.status };
}

function dockerShadowFile(localPath) {
  const container = resolveDockerDbContainer();
  if (!container) return { ok: false, stderr: "shadow docker container missing" };
  const containerPath = `/tmp/${path.basename(localPath)}`;
  spawnSync("docker", ["cp", localPath, `${container}:${containerPath}`], { encoding: "utf8" });
  return dockerShadowPsql("", { file: containerPath });
}

function setupShadowFromDump(dumpFile) {
  const container = resolveDockerDbContainer();
  if (!container) throw new Error("Container Postgres local ausente — shadow revalidation bloqueada");
  dockerShadowPsql(`DROP DATABASE IF EXISTS ${SHADOW_DB};`, { db: "postgres" });
  const created = dockerShadowPsql(`CREATE DATABASE ${SHADOW_DB};`, { db: "postgres" });
  if (!created.ok) throw new Error(`shadow create db failed: ${created.stderr}`);
  const boot = dockerShadowPsql(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      created_at timestamptz DEFAULT now()
    );
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth
      AS $$ SELECT NULL::uuid $$;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth
      AS $$ SELECT '{}'::jsonb $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = auth
      AS $$ SELECT 'service_role'::text $$;
    GRANT USAGE ON SCHEMA auth TO postgres, service_role, authenticated, anon;
  `);
  if (!boot.ok) throw new Error(`shadow bootstrap failed: ${boot.stderr}`);
  const loaded = dockerShadowFile(dumpFile);
  if (!loaded.ok) {
    throw new Error(`shadow load dump failed: ${loaded.stderr.slice(0, 400)}`);
  }
  return { ok: true };
}

function revalidateShadowForwardFixes(dumpFile) {
  setupShadowFromDump(dumpFile);
  const results = {};
  for (const entry of AUTHORIZED) {
    const fixPath = path.join(OUT, entry.fixFile);
    if (!fs.existsSync(fixPath)) throw new Error(`Forward-fix ausente: ${entry.fixFile}`);
    const r = dockerShadowFile(fixPath);
    results[entry.version] = r.ok ? "PASS" : `FAIL: ${r.stderr.slice(0, 200)}`;
    if (!r.ok) throw new Error(`Shadow revalidation FAIL ${entry.version}: ${r.stderr.slice(0, 300)}`);
  }
  return results;
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
  try { body = await res.json(); } catch { body = null; }
  if (res.status === 404 || body?.code === "PGRST205") return { table, count: null, missing: true, status: res.status };
  return { table, count: m ? Number(m[1]) : null, missing: false, status: res.status };
}

async function collectCounts(serviceKey) {
  const tables = [
    "profiles", "seller_companies", "marketplace_accounts", "ml_tokens", "products",
    "marketplace_listings", "sales_orders", "sales_order_items", "marketplace_account_sync_jobs",
    "legal_document_acceptances",
  ];
  const counts = {};
  for (const t of tables) counts[t] = await tableCount(serviceKey, t);
  const creds = getDbCreds();
  const auth = psqlProd(creds, "SELECT count(*)::int FROM auth.users;");
  counts.auth_users = { table: "auth.users", count: parseInt((auth.stdout || "").trim() || "0", 10), missing: false, status: auth.status };
  return counts;
}

function listBackups() {
  const raw = run(`supabase backups list --project-ref ${PROD_REF} -o json`, { timeout: 120000 });
  const parsed = JSON.parse(raw);
  return parsed.backups || parsed;
}

function indexOrConstraintExists(creds, name) {
  const sql = `
    SELECT (
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='${name}')
      OR EXISTS (
        SELECT 1 FROM pg_constraint con
        JOIN pg_class rel ON rel.oid=con.conrelid
        JOIN pg_namespace n ON n.oid=rel.relnamespace
        WHERE n.nspname='public' AND con.conname='${name}'
      )
    );`;
  const r = psqlProd(creds, sql);
  return (r.stdout || "").trim() === "t";
}

function tableExists(creds, shortName) {
  const r = psqlProd(
    creds,
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='${shortName}');`,
  );
  return (r.stdout || "").trim() === "t";
}

function columnExists(creds, col) {
  const r = psqlProd(
    creds,
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND column_name='${col}');`,
  );
  return (r.stdout || "").trim() === "t";
}

function functionExists(creds, shortName) {
  const r = psqlProd(
    creds,
    `SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${shortName}');`,
  );
  return (r.stdout || "").trim() === "t";
}

function checkObject(creds, kind, name) {
  if (kind === "table") return tableExists(creds, name.split(".").pop());
  if (kind === "index") return indexOrConstraintExists(creds, name);
  if (kind === "column") return columnExists(creds, name);
  if (kind === "function") return functionExists(creds, name.split(".").pop());
  return false;
}

function gapsFromManifest(manifestEntry) {
  const gaps = [];
  const op = manifestEntry.objects_prod || {};
  for (const [k, v] of Object.entries(op)) {
    if (v === false) gaps.push(k);
  }
  return gaps;
}

function verifyGapObjects(creds, manifestEntry) {
  const checks = [];
  for (const gap of gapsFromManifest(manifestEntry)) {
    let kind = "index";
    if (gap.startsWith("public.")) kind = gap.includes(".") && !gap.includes("_idx") ? "table" : "table";
    if (["plan_key", "description", "price_monthly", "price_cents", "sales_limit_monthly", "sales_range_min", "sales_range_max", "billing_required", "is_active", "pricing_mode", "sort_order", "display_name", "marketing_name", "slug", "marketplace", "owner_email", "exec_objective", "exec_context", "exec_problem", "exec_where_stopped", "customer_ingested_at"].includes(gap)) kind = "column";
    if (gap.startsWith("public.")) {
      const short = gap.split(".").pop();
      if (manifestEntry.objects_expected?.functions?.includes(gap)) kind = "function";
      else if (manifestEntry.objects_expected?.tables?.includes(gap)) kind = "table";
      else kind = "function";
    }
    if (manifestEntry.objects_expected?.indexes?.includes(gap)) kind = "index";
    if (manifestEntry.objects_expected?.columns?.includes(gap)) kind = "column";
    if (manifestEntry.objects_expected?.tables?.includes(gap) || (gap.startsWith("public.") && manifestEntry.objects_expected?.tables?.some((t) => t.endsWith(gap.split(".").pop())))) kind = "table";
    checks.push({ name: gap, kind, present: checkObject(creds, kind, gap) });
  }
  return checks;
}

function verifyForwardFixTargets(creds, manifestEntry, fixSql) {
  const checks = [];
  for (const idx of manifestEntry.objects_expected?.indexes || []) {
    if ((manifestEntry.objects_prod || {})[idx] === false || fixSql.includes(idx)) {
      checks.push({ name: idx, kind: "index", present: indexOrConstraintExists(creds, idx) });
    }
  }
  return checks;
}

function mlTokensDuplicatePrecheck(creds) {
  const r = psqlProd(
    creds,
    `SELECT count(*)::int FROM (SELECT user_id, marketplace FROM public.ml_tokens GROUP BY 1,2 HAVING count(*)>1) d;`,
  );
  const n = parseInt((r.stdout || "").trim() || "0", 10);
  return { ok: r.status === 0 && n === 0, duplicates: n, total: psqlProd(creds, "SELECT count(*)::int FROM public.ml_tokens;") };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifestDoc = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const manifestByVersion = Object.fromEntries(manifestDoc.manifest.map((m) => [m.version, m]));

  linkProd();
  promptProdPasswordInteractive();

  const backups = listBackups();
  if (!backups.length || !backups.some((b) => b.status === "COMPLETED")) {
    throw new Error("Backup COMPLETED indisponivel — Batch 2B1 bloqueado");
  }

  const credProbe = getDbCreds();
  const authProbe = psqlProd(credProbe, "SELECT 1;");
  if (authProbe.status !== 0 || (authProbe.stdout || "").trim() !== "1") {
    throw new Error("Postgres authentication FAIL");
  }
  const ddlProbe = psqlProd(
    credProbe,
    "CREATE OR REPLACE FUNCTION public.__s7_batch2b1_ddl_probe() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;",
  );
  if (ddlProbe.status !== 0) throw new Error("DDL probe FAIL");
  psqlProd(credProbe, "DROP FUNCTION IF EXISTS public.__s7_batch2b1_ddl_probe();");

  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_batch2b1_${DATE}.sql`);
  dumpSchema(schemaBeforeFile);
  const fpBefore = fingerprintDump(schemaBeforeFile);

  let shadowRevalidation = {};
  try {
    shadowRevalidation = revalidateShadowForwardFixes(schemaBeforeFile);
  } catch (err) {
    throw new Error(`Shadow revalidation pos-Batch2A falhou: ${redactSecrets(String(err.message || err))}`);
  }

  fs.writeFileSync(path.join(OUT, `SCHEMA_FINGERPRINT_PROD_BEFORE_BATCH2B1.json`), JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...fpBefore }, null, 2));

  const serviceKey = await getServiceRoleKey();
  const countsBefore = await collectCounts(serviceKey);
  fs.writeFileSync(path.join(OUT, `PROD_COUNTS_BEFORE_BATCH2B1.json`), JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), counts: countsBefore }, null, 2));

  const historyBefore = getMigrationList();
  fs.writeFileSync(path.join(OUT, `MIGRATION_HISTORY_PROD_BEFORE_BATCH2B1.json`), JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...historyBefore }, null, 2));

  const executed = [];
  const skipped = [];
  let aborted = false;
  let abortReason = null;

  for (const entry of AUTHORIZED) {
    const manifestEntry = manifestByVersion[entry.version];
    if (!manifestEntry || manifestEntry.action !== "FORWARD_FIX") {
      throw new Error(`${entry.version} nao e FORWARD_FIX no manifest`);
    }
    const fixPath = path.join(OUT, entry.fixFile);
    const fixSql = fs.readFileSync(fixPath, "utf8");
    const fixHash = sha256(fixSql);
    const creds = getDbCreds();

    const gapsBefore = verifyGapObjects(creds, manifestEntry);
    const preMissing = gapsBefore.filter((g) => !g.present);

    let dupPrecheck = null;
    if (entry.version === "20260301000009") {
      dupPrecheck = mlTokensDuplicatePrecheck(creds);
      if (!dupPrecheck.ok) {
        aborted = true;
        abortReason = "ml_tokens_duplicate_conflict";
        skipped.push({ version: entry.version, reason: abortReason, dupPrecheck });
        break;
      }
    }

    const sqlResult = psqlProdFile(creds, fixSql);
    const sqlOk = sqlResult.status === 0;

    const postTargets = verifyForwardFixTargets(creds, manifestEntry, fixSql);
    const postMissing = postTargets.filter((c) => !c.present);

    let historyResult = null;
    if (sqlOk && postMissing.length === 0) {
      historyResult = repairVersion(entry.version);
      if (!historyResult.ok) {
        aborted = true;
        abortReason = "history_repair_failed";
      }
    } else if (!sqlOk) {
      aborted = true;
      abortReason = "forward_fix_sql_failed";
    } else {
      aborted = true;
      abortReason = "equivalence_postcheck_failed";
    }

    const midCounts = await collectCounts(serviceKey);
    const sellerOk =
      midCounts.profiles.count === countsBefore.profiles.count &&
      midCounts.seller_companies.count === countsBefore.seller_companies.count &&
      midCounts.marketplace_accounts.count === countsBefore.marketplace_accounts.count &&
      midCounts.ml_tokens.count === countsBefore.ml_tokens.count &&
      midCounts.products.count === countsBefore.products.count &&
      midCounts.marketplace_listings.count === countsBefore.marketplace_listings.count &&
      midCounts.sales_orders.count === countsBefore.sales_orders.count &&
      midCounts.sales_order_items.count === countsBefore.sales_order_items.count;
    const legalOk = midCounts.legal_document_acceptances.missing === true;

    const rec = {
      version: entry.version,
      name: entry.name,
      fix_file: entry.fixFile,
      sql_hash: fixHash,
      gaps_before: preMissing,
      sql_ok: sqlOk,
      sql_error: sqlOk ? null : redactSecrets((sqlResult.stderr || sqlResult.stdout || "").slice(0, 500)),
      post_targets: postTargets,
      post_missing: postMissing,
      dup_precheck: dupPrecheck,
      history_ok: historyResult?.ok ?? false,
      seller_counts_ok: sellerOk,
      legal_still_missing: legalOk,
    };

    if (sqlOk && historyResult?.ok && postMissing.length === 0 && sellerOk && legalOk) {
      executed.push(rec);
    } else {
      skipped.push({ version: entry.version, reason: abortReason, rec });
      aborted = true;
      break;
    }
  }

  const schemaAfterFile = path.join(OUT, `_prod_schema_after_batch2b1_${DATE}.sql`);
  dumpSchema(schemaAfterFile);
  const fpAfter = fingerprintDump(schemaAfterFile);
  fs.writeFileSync(path.join(OUT, `SCHEMA_FINGERPRINT_PROD_AFTER_BATCH2B1.json`), JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...fpAfter }, null, 2));

  const countsAfter = await collectCounts(serviceKey);
  fs.writeFileSync(path.join(OUT, `PROD_COUNTS_AFTER_BATCH2B1.json`), JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), counts: countsAfter }, null, 2));

  const historyAfter = getMigrationList();
  fs.writeFileSync(path.join(OUT, `MIGRATION_HISTORY_PROD_AFTER_BATCH2B1.json`), JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...historyAfter }, null, 2));

  const allSuccess = !aborted && executed.length === AUTHORIZED.length;
  const report = {
    pass: allSuccess,
    status: allSuccess ? "BATCH 2B1 CONCLUÍDO COM SUCESSO" : executed.length > 0 ? "BATCH 2B1 CONCLUÍDO PARCIALMENTE" : aborted ? "BATCH 2B1 INTERROMPIDO" : "BATCH 2B1 BLOQUEADO",
    captured_at: new Date().toISOString(),
    credential: { postgres_authentication: "PASS", ddl_probe: "PASS" },
    shadow_revalidation: shadowRevalidation,
    environment: {
      project: PROD_NAME,
      project_ref: PROD_REF,
      backup_latest: backups[0]?.inserted_at,
      backup_status: backups[0]?.status,
    },
    executed,
    skipped,
    schema_fingerprint: { before: fpBefore, after: fpAfter, changed: fpBefore?.fingerprint !== fpAfter?.fingerprint },
    data_counts: { before: countsBefore, after: countsAfter, seller_identical: countsBefore.profiles.count === countsAfter.profiles.count },
    legal_table: { before_missing: countsBefore.legal_document_acceptances.missing, after_missing: countsAfter.legal_document_acceptances.missing },
    history: { before_pending: historyBefore.pending.length, after_pending: historyAfter.pending.length, newly_applied: executed.map((e) => e.version) },
    blocked: { "00043": true, "00002": true, "00118_122": true },
    abort_reason: abortReason,
  };

  fs.writeFileSync(path.join(OUT, `BATCH2B1_FORWARD_FIX_EXECUTION_${DATE}.json`), JSON.stringify(report, null, 2));

  const md = `# BATCH 2B1 PROD — FORWARD-FIX — ${DATE}

## A. STATUS
**${report.status}**

## B. SHADOW REVALIDATION (pos-Batch 2A)
${Object.entries(shadowRevalidation).map(([v, s]) => `- ${v}: ${s}`).join("\n")}

## C–F. EXECUCOES
${executed.map((e) => `### ${e.version} ${e.name}\n- SQL hash: \`${e.sql_hash.slice(0, 16)}…\`\n- SQL: ${e.sql_ok ? "PASS" : "FAIL"}\n- History: ${e.history_ok ? "PASS" : "FAIL"}\n- Post missing: ${e.post_missing.length}`).join("\n\n")}

## G. SCHEMA
| | Before | After |
|---|---|---|
| Fingerprint | \`${fpBefore?.fingerprint?.slice(0, 16)}…\` | \`${fpAfter?.fingerprint?.slice(0, 16)}…\` |
| Tables | ${fpBefore?.counts?.tables} | ${fpAfter?.counts?.tables} |
| Indexes | ${fpBefore?.counts?.indexes} | ${fpAfter?.counts?.indexes} |
| Policies | ${fpBefore?.counts?.policies} | ${fpAfter?.counts?.policies} |

## H. COUNTS
profiles: ${countsBefore.profiles.count} → ${countsAfter.profiles.count}

## I. HISTORY
Pending: ${historyBefore.pending.length} → ${historyAfter.pending.length}

## GATES
Batch 2B1: ${allSuccess ? "SIM" : "PARCIAL/NAO"} | 00043: NAO | 00002: NAO | 00118–122: NAO
`;
  fs.writeFileSync(path.join(OUT, `BATCH2B1_FORWARD_FIX_EXECUTION_${DATE}.md`), md);

  relinkDev();
  clearProdPasswordMem();
  console.log(JSON.stringify({ pass: report.pass, status: report.status, executed: executed.length, total: AUTHORIZED.length }, null, 2));
  process.exit(allSuccess ? 0 : 1);
}

main().catch((err) => {
  try { relinkDev(); } catch { /* ignore */ }
  clearProdPasswordMem();
  console.error(JSON.stringify({ pass: false, error: redactSecrets(String(err.message || err)) }));
  process.exit(1);
});
