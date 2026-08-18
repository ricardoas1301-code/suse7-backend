#!/usr/bin/env node
/**
 * BATCH 5C4 — Migration 116 PROD FINAL (bundle atômico histórico + lockdown)
 * Autorizado: 20260301000116 apenas — última migration pendente.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runShadow116 } from "./billing116_shadow_post115.mjs";
import { probeRlsCombined, sqlProbeRls } from "./billing_rls_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260818";
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const PROD_REF = "bazibzquasbdgjwdcwbz";
const DEV_REF = "alkelcaoexxbamqddaqv";
const VERSION = "20260301000116";
const MIG116 = path.join(WORKSPACE, "supabase", "migrations", "20260301000116_s7_billing_asaas_customer_notification_policy.sql");
const FORWARD_FIX = path.join(OUT, "BILLING116_FORWARD_FIX_CANDIDATE_20260818.sql");
const TABLE = "billing_customer_notification_policy";
const EXPECTED_PENDING_BEFORE = ["20260301000116"];
const EXPECTED_PENDING_AFTER = [];
const VERSIONS_APPLIED = ["20260301000112", "20260301000113", "20260301000114", "20260301000115"];
const CHECKPOINT_VERSIONS = ["20260301000118", "20260301000119", "20260301000120", "20260301000121", "20260301000122"];
const EXPECTED_SUB_FP = "e5be9742b1d53e951a18323b52172ff6bc6c5222749f43b28d01d3f282580555";

const BILLING_TABLES = ["plans", "billing_plan_limits", "billing_subscriptions", "billing_billable_sale_admissions"];
const SELLER_TABLES = [
  "profiles", "seller_companies", "marketplace_accounts", "ml_tokens",
  "products", "marketplace_listings", "sales_orders", "sales_order_items",
  "legal_document_acceptances",
];
const LIFECYCLE_TABLES = [
  "billing_trial_lifecycle_transitions",
  "billing_trial_lifecycle_job_locks",
  "billing_paid_lifecycle_ledger",
  "billing_paid_lifecycle_job_locks",
];

let prodDbPasswordMem = null;
const startedAt = new Date().toISOString();

function sha256(t) {
  return crypto.createHash("sha256").update(typeof t === "string" ? t : JSON.stringify(t)).digest("hex");
}
function redact(t) {
  return String(t || "")
    .replace(/PGPASSWORD="[^"]+"/g, "PGPASSWORD=[REDACTED]")
    .replace(/PGPASSWORD=[^\s]+/g, "PGPASSWORD=[REDACTED]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[UUID]");
}
function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: WORKSPACE, encoding: "utf8", stdio: opts.stdio || ["ignore", "pipe", "pipe"], timeout: opts.timeout || 600000 });
}
function linkProd() {
  run(`supabase link --project-ref ${PROD_REF} --yes`, { stdio: "ignore" });
}
function relinkDev() {
  run(`supabase link --project-ref ${DEV_REF} --yes`, { stdio: "ignore" });
}
function resolveProdPassword() {
  return prodDbPasswordMem || process.env.PROD_DB_PASSWORD || process.env.SUSE7_PROD_DB_PASSWORD || null;
}
function promptPassword() {
  if (resolveProdPassword()) return;
  if (!process.stdin.isTTY) {
    throw new Error("Senha postgres PROD ausente — execute run_batch5c4_interactive.ps1 localmente");
  }
  process.stderr.write("Informe a senha postgres PROD (nao sera salva):\n");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", "$s=Read-Host 'Senha postgres PROD (Suse7-prod)' -AsSecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringAuto($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }"],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  prodDbPasswordMem = (r.stdout || "").trim();
  if (!prodDbPasswordMem) throw new Error("Senha postgres PROD ausente — use run_batch5c4_interactive.ps1");
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
  return { host, port, user, password, database, role: user };
}
function getCreds() {
  const ephemeral = getEphemeralDbCreds();
  if (ephemeral) return ephemeral;
  const dbPassword = resolveProdPassword();
  if (!dbPassword) throw new Error("Credencial postgres PROD ausente");
  return { host: `db.${PROD_REF}.supabase.co`, port: "5432", user: "postgres", password: dbPassword, database: "postgres", role: "postgres" };
}
function psqlExec(creds, sql) {
  return spawnSync(
    "docker",
    ["run", "--rm", "--network", "host", "-e", `PGPASSWORD=${creds.password}`, "postgres:17",
      "psql", "-h", creds.host, "-p", creds.port, "-U", creds.user, "-d", creds.database,
      "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
}
function psqlInput(creds, input) {
  return spawnSync(
    "docker",
    ["run", "--rm", "--network", "host", "-i", "-e", `PGPASSWORD=${creds.password}`, "postgres:17",
      "psql", "-h", creds.host, "-p", creds.port, "-U", creds.user, "-d", creds.database,
      "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input, timeout: 900000 },
  );
}
async function ensurePostgresCreds(creds) {
  const ddlProbe = psqlExec(creds, "CREATE OR REPLACE FUNCTION public.__s7_batch5c4_ddl_probe() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;");
  if (ddlProbe.status !== 0) {
    if (!resolveProdPassword()) promptPassword();
    return { host: `db.${PROD_REF}.supabase.co`, port: "5432", user: "postgres", password: resolveProdPassword(), database: "postgres", role: "postgres" };
  }
  psqlExec(creds, "DROP FUNCTION IF EXISTS public.__s7_batch5c4_ddl_probe();");
  return creds;
}
function parseHistory() {
  const raw = run("supabase migration list --linked");
  const pending = [];
  const applied = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\d+)\s*\|\s*(\d*)\s*\|/);
    if (!m?.[1]) continue;
    if (m[2]?.trim()) applied.push(m[1]);
    else pending.push(m[1]);
  }
  return { pending, applied, raw: redact(raw) };
}
function repair(v) {
  const r = spawnSync(`supabase migration repair --status applied --linked --yes ${v}`, { shell: true, cwd: WORKSPACE, encoding: "utf8" });
  return { ok: r.status === 0, stderr: redact(r.stderr) };
}
async function restCount(serviceKey, table) {
  const res = await fetch(`https://${PROD_REF}.supabase.co/rest/v1/${table}?select=id&limit=0`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: "count=exact" },
  });
  const m = (res.headers.get("content-range") || "").match(/\/(\d+)$/);
  return { count: res.status === 404 ? null : m ? Number(m[1]) : null, missing: res.status === 404, status: res.status };
}
function fpDump(file) {
  const t = fs.readFileSync(file, "utf8");
  const tables = [...t.matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)"/g)].map((m) => m[1]).sort();
  const indexes = [...t.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "?([^"\s(]+)"?/g)].map((m) => m[1]).sort();
  const functions = [...t.matchAll(/CREATE OR REPLACE FUNCTION "public"\."([^"]+)"/g)].map((m) => m[1]).sort();
  return { fingerprint: sha256([...tables, ...indexes, ...functions].join("|")), counts: { tables: tables.length, indexes: indexes.length, functions: functions.length }, tables, indexes, functions };
}
function subscriptionFingerprintSql(creds) {
  const r = psqlExec(
    creds,
    `SELECT status, plan_key, provider, is_active::text,
      metadata->>'effective_entitlement', metadata->>'trial_state',
      metadata->>'suspension_fallback_active', metadata->>'sync_state',
      plan_id::text, user_id::text
     FROM public.billing_subscriptions ORDER BY created_at LIMIT 5;`,
  );
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  const structural = lines.map((line) => {
    const p = line.split("|");
    return [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]].join("|");
  });
  const ownership = lines.map((line) => sha256(line.split("|")[8] || "")).join(",");
  return { row_count: lines.length, structural_fingerprint: sha256(structural.join("\n")), ownership_hash: sha256(ownership), structural_sample: structural[0] || null };
}
function buildBundleSql() {
  if (!fs.existsSync(MIG116)) throw new Error(`Migration 116 ausente: ${MIG116}`);
  if (!fs.existsSync(FORWARD_FIX)) throw new Error(`Forward-fix ausente: ${FORWARD_FIX}`);
  const mig = fs.readFileSync(MIG116, "utf8");
  const lockdown = fs
    .readFileSync(FORWARD_FIX, "utf8")
    .split("\n")
    .filter((l) => l.trim().startsWith("SELECT s7_private.apply_service_role_only_lockdown"))
    .join("\n");
  if (!lockdown.includes("apply_service_role_only_lockdown")) {
    throw new Error("Forward-fix SSOT inválido — linha lockdown ausente");
  }
  return `BEGIN;\n${mig}\n${lockdown}\nCOMMIT;\n`;
}
function verifyHelper(creds) {
  const r = psqlExec(
    creds,
    `SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='s7_private' AND p.proname='apply_service_role_only_lockdown';`,
  );
  return (r.stdout || "").trim() === "1";
}
function tableExists(creds, table) {
  return (psqlExec(creds, `SELECT COUNT(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='${table}';`).stdout || "").trim() === "1";
}
function auditGrants(creds, table) {
  const r = psqlExec(
    creds,
    `SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
     FROM information_schema.role_table_grants
     WHERE table_schema='public' AND table_name='${table}'
     GROUP BY grantee ORDER BY grantee;`,
  );
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  const grants = {};
  for (const line of lines) {
    const [grantee, privs] = line.split("|");
    grants[grantee] = privs;
  }
  return grants;
}
function securityProbe(creds, table) {
  const anon = psqlExec(creds, `SET ROLE anon; SELECT COUNT(*) FROM public.${table};`);
  const auth = psqlExec(creds, `SET ROLE authenticated; SELECT COUNT(*) FROM public.${table};`);
  const authIns = psqlExec(
    creds,
    `SET ROLE authenticated; INSERT INTO public.${table} (user_id, provider, environment, provider_customer_id, policy_version, policy_status)
     VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 'asaas', 'sandbox', 'probe', 'v1', 'UNKNOWN');`,
  );
  const svc = psqlExec(creds, `SET ROLE service_role; SELECT COUNT(*)::text FROM public.${table};`);
  return {
    anon_select_denied: anon.status !== 0,
    authenticated_select_denied: auth.status !== 0,
    authenticated_insert_denied: authIns.status !== 0,
    service_role_select_ok: svc.status === 0,
  };
}
function postcheck116(creds, dumpText) {
  const exists = tableExists(creds, TABLE);
  const rowCount = Number((psqlExec(creds, `SELECT COUNT(*)::text FROM public.${TABLE};`).stdout || "0").trim());
  const policyCount = Number((psqlExec(creds, `SELECT COUNT(*)::text FROM pg_policies WHERE schemaname='public' AND tablename='${TABLE}';`).stdout || "0").trim());
  const rls = probeRlsCombined(psqlExec(creds, sqlProbeRls("public", TABLE)), dumpText, TABLE);
  const grants = auditGrants(creds, TABLE);
  const pk = (psqlExec(creds, `SELECT COUNT(*)::text FROM pg_constraint WHERE conname='billing_customer_notification_policy_pkey';`).stdout || "").trim() === "1";
  const unique = (psqlExec(creds, `SELECT COUNT(*)::text FROM pg_constraint WHERE conname='billing_customer_notification_policy_provider_env_customer_uidx';`).stdout || "").trim() === "1";
  const check = (psqlExec(creds, `SELECT COUNT(*)::text FROM pg_constraint WHERE conname='billing_customer_notification_policy_status_chk';`).stdout || "").trim() === "1";
  const idxUser = (psqlExec(creds, `SELECT COUNT(*)::text FROM pg_indexes WHERE schemaname='public' AND indexname='billing_customer_notification_policy_user_idx';`).stdout || "").trim() === "1";
  const idxStatus = (psqlExec(creds, `SELECT COUNT(*)::text FROM pg_indexes WHERE schemaname='public' AND indexname='billing_customer_notification_policy_status_idx';`).stdout || "").trim() === "1";
  const security = securityProbe(creds, TABLE);
  const grantsOk =
    !grants.anon &&
    !grants.authenticated &&
    !grants.PUBLIC &&
    Boolean(grants.service_role || grants.postgres);
  const pass =
    exists &&
    rowCount === 0 &&
    policyCount === 0 &&
    rls.enabled &&
    pk &&
    unique &&
    check &&
    idxUser &&
    idxStatus &&
    grantsOk &&
    security.anon_select_denied &&
    security.authenticated_select_denied &&
    security.authenticated_insert_denied &&
    security.service_role_select_ok;
  return {
    table_exists: exists,
    row_count: rowCount,
    policy_count: policyCount,
    rls,
    grants,
    grants_ok: grantsOk,
    constraints: { pk, unique, check, idxUser, idxStatus },
    security_probe: security,
    pass,
  };
}
function checkpoint118Readonly(history, dumpText) {
  const applied = CHECKPOINT_VERSIONS.every((v) => history.applied.includes(v));
  return {
    applied_versions: applied,
    legal_document_acceptances: dumpText.includes("legal_document_acceptances"),
    s7_complete_signup_birth_once: dumpText.includes("s7_complete_signup_birth_once"),
    marketplace_accounts_global_active_external_uidx: dumpText.includes("marketplace_accounts_global_active_external_uidx"),
    profiles_latches: /profiles.*latch|latch.*profiles|onboarding_latch/i.test(dumpText),
    intact: applied && dumpText.includes("legal_document_acceptances") && dumpText.includes("s7_complete_signup_birth_once") && dumpText.includes("marketplace_accounts_global_active_external_uidx"),
  };
}
function migrationGovernance(historyAfter) {
  const localMigs = fs.readdirSync(path.join(WORKSPACE, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).map((f) => f.split("_")[0]).sort();
  return {
    local_migration_files: localMigs.length,
    prod_pending: historyAfter.pending,
    prod_pending_count: historyAfter.pending.length,
    prod_applied_includes_116: historyAfter.applied.includes(VERSION),
    reconciliation_complete: historyAfter.pending.length === 0 && historyAfter.applied.includes(VERSION),
    known_holes: historyAfter.pending.filter((v) => !localMigs.includes(v)),
  };
}
function writeArtifacts(prefix, data) {
  fs.writeFileSync(path.join(OUT, `${prefix}.json`), JSON.stringify(data, null, 2));
}
function writeReport(report) {
  writeArtifacts(`BATCH5C4_116_FINAL_EXECUTION_${DATE}`, report);
  fs.writeFileSync(path.join(OUT, `BATCH5C4_116_FINAL_EXECUTION_${DATE}.md`), `# BATCH 5C4 — Billing 116 FINAL — ${DATE}\n\n## A. STATUS\n\n**${report.status}**\n`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const bundleSql = buildBundleSql();
  const bundlePath = path.join(OUT, `_prod_bundle_116_${DATE}.sql`);
  fs.writeFileSync(bundlePath, bundleSql);

  const shadow = await runShadow116();
  writeArtifacts("BILLING116_SHADOW_RESULTS_20260818", shadow);
  if (!shadow.pass) {
    writeReport({ status: "116 PROD BLOQUEADA", pass: false, blocked_at: "shadow", shadow });
    throw new Error(`Shadow FAIL — 116 PROD NÃO AUTORIZADA: ${JSON.stringify(shadow.checks || {})}`);
  }

  linkProd();
  const projects = JSON.parse(run("supabase projects list -o json"));
  const proj = projects.find((p) => p.ref === PROD_REF);
  if (!proj || !/prod/i.test(proj.name || "")) throw new Error("Confirmacao PROD falhou");

  const backupsRaw = JSON.parse(run(`supabase backups list --project-ref ${PROD_REF} -o json`));
  const backups = backupsRaw.backups || backupsRaw;
  const backupOk = backups.some((b) => b.status === "COMPLETED");
  const latestBackup = backups.find((b) => b.status === "COMPLETED")?.inserted_at;
  const pitrNote = backupsRaw.pitr_enabled ?? false;
  if (!backupOk) throw new Error("Backup managed indisponivel — PARE");

  const historyBefore = parseHistory();
  if (historyBefore.pending.length !== 1 || historyBefore.pending[0] !== VERSION) {
    throw new Error(`Precheck pending FAIL: esperado [${VERSION}], got ${historyBefore.pending.join(",")}`);
  }
  for (const v of VERSIONS_APPLIED) {
    if (!historyBefore.applied.includes(v)) throw new Error(`Precheck FAIL: ${v} nao applied`);
  }
  for (const v of CHECKPOINT_VERSIONS) {
    if (!historyBefore.applied.includes(v)) throw new Error(`Precheck FAIL checkpoint: ${v} nao applied`);
  }
  writeArtifacts("MIGRATION_HISTORY_PROD_BEFORE_116", historyBefore);

  const serviceKey = JSON.parse(run(`supabase projects api-keys --project-ref ${PROD_REF} -o json`)).find((k) => /service_role/i.test(k.name))?.api_key;
  const billingBefore = {};
  for (const t of BILLING_TABLES) billingBefore[t] = await restCount(serviceKey, t);
  const sellerBefore = {};
  for (const t of SELLER_TABLES) sellerBefore[t] = await restCount(serviceKey, t);

  let creds;
  try {
    creds = getCreds();
  } catch {
    promptPassword();
    creds = getCreds();
  }
  creds = await ensurePostgresCreds(creds);

  if (!verifyHelper(creds)) throw new Error("Helper apply_service_role_only_lockdown ausente no PROD — PARE");
  if (tableExists(creds, TABLE)) throw new Error(`Precheck FAIL: ${TABLE} já existe — reauditoria necessária`);

  const admissionsBefore = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions;").stdout || "0").trim());
  billingBefore.billing_billable_sale_admissions = { count: admissionsBefore, source: "sql" };
  const lifecycleCountsBefore = {};
  for (const t of LIFECYCLE_TABLES) {
    lifecycleCountsBefore[t] = Number((psqlExec(creds, `SELECT COUNT(*)::text FROM public.${t};`).stdout || "0").trim());
  }

  if (billingBefore.billing_subscriptions?.count !== 1) throw new Error(`Precheck FAIL: subscriptions=${billingBefore.billing_subscriptions?.count}`);
  if (admissionsBefore !== 0) throw new Error(`Precheck FAIL: admissions=${admissionsBefore}`);

  writeArtifacts("BILLING_COUNTS_PROD_BEFORE_116", billingBefore);

  const subBefore = subscriptionFingerprintSql(creds);
  writeArtifacts("BILLING_SUBSCRIPTION_FINGERPRINT_BEFORE_116", subBefore);
  if (subBefore.structural_fingerprint !== EXPECTED_SUB_FP) {
    throw new Error(`Precheck FAIL: subscription FP divergiu (${subBefore.structural_fingerprint})`);
  }

  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_116_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaBeforeFile.replace(/\\/g, "/")}"`, { timeout: 900000 });
  writeArtifacts("SCHEMA_FINGERPRINT_PROD_BEFORE_116", fpDump(schemaBeforeFile));

  const mig = psqlInput(creds, bundleSql);
  if (mig.status !== 0) {
    writeReport({
      status: "116 PROD INTERROMPIDA", pass: false, blocked_at: "bundle_transaction",
      error: redact((mig.stderr || mig.stdout || "").slice(0, 800)),
      note: "Transação deve ter feito ROLLBACK automático (ON_ERROR_STOP)",
    });
    throw new Error(`Bundle 116 FAIL: ${redact((mig.stderr || "").slice(0, 400))}`);
  }

  const admissionsAfter = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions;").stdout || "0").trim());
  const schemaAfterFile = path.join(OUT, `_prod_schema_after_116_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaAfterFile.replace(/\\/g, "/")}"`, { timeout: 900000 });
  const schemaAfterText = fs.readFileSync(schemaAfterFile, "utf8");
  writeArtifacts("SCHEMA_FINGERPRINT_PROD_AFTER_116", fpDump(schemaAfterFile));

  const postcheck = postcheck116(creds, schemaAfterText);
  writeArtifacts(`BILLING116_PROD_POSTCHECK_${DATE}`, postcheck);
  writeArtifacts(`BILLING116_SECURITY_POSTCHECK_${DATE}`, {
    rls: postcheck.rls,
    grants: postcheck.grants,
    policy_count: postcheck.policy_count,
    security_probe: postcheck.security_probe,
    pass: postcheck.pass,
  });

  const subAfter = subscriptionFingerprintSql(creds);
  writeArtifacts("BILLING_SUBSCRIPTION_FINGERPRINT_AFTER_116", subAfter);
  const subscriptionPreserved =
    subBefore.structural_fingerprint === subAfter.structural_fingerprint &&
    subBefore.ownership_hash === subAfter.ownership_hash &&
    subBefore.row_count === subAfter.row_count;

  const billingAfter = {};
  for (const t of BILLING_TABLES.filter((t) => t !== "billing_billable_sale_admissions")) billingAfter[t] = await restCount(serviceKey, t);
  billingAfter.billing_billable_sale_admissions = { count: admissionsAfter, source: "sql" };
  const lifecycleCountsAfter = {};
  for (const t of LIFECYCLE_TABLES) {
    lifecycleCountsAfter[t] = Number((psqlExec(creds, `SELECT COUNT(*)::text FROM public.${t};`).stdout || "0").trim());
  }
  const lifecycleInvariant = JSON.stringify(lifecycleCountsBefore) === JSON.stringify(lifecycleCountsAfter);

  const billingInvariant =
    billingBefore.plans?.count === billingAfter.plans?.count &&
    billingBefore.billing_plan_limits?.count === billingAfter.billing_plan_limits?.count &&
    billingBefore.billing_subscriptions?.count === billingAfter.billing_subscriptions?.count &&
    admissionsBefore === 0 &&
    admissionsAfter === 0;

  if (!postcheck.pass) {
    writeReport({ status: "116 PROD INTERROMPIDA", pass: false, blocked_at: "postcheck", postcheck });
    throw new Error("Postcheck FAIL — NÃO repair");
  }
  if (!subscriptionPreserved || !billingInvariant || !lifecycleInvariant) {
    writeReport({
      status: "116 PROD INTERROMPIDA", pass: false, blocked_at: "invariants",
      subscription: { before: subBefore, after: subAfter, preserved: subscriptionPreserved },
      lifecycle: { before: lifecycleCountsBefore, after: lifecycleCountsAfter },
    });
    throw new Error("Invariants divergiram — NÃO repair");
  }

  const repairResult = repair(VERSION);
  if (!repairResult.ok) {
    writeReport({ status: "SQL_APPLIED_HISTORY_PENDING", pass: false, postcheck, repair: repairResult });
    throw new Error(`Repair FAIL: ${repairResult.stderr}`);
  }

  const historyAfter = parseHistory();
  writeArtifacts("MIGRATION_HISTORY_PROD_AFTER_116", historyAfter);
  writeArtifacts("BILLING_COUNTS_PROD_AFTER_116", billingAfter);

  const sellerAfter = {};
  for (const t of SELLER_TABLES) sellerAfter[t] = await restCount(serviceKey, t);

  const checkpoint = checkpoint118Readonly(historyAfter, schemaAfterText);
  const governance = migrationGovernance(historyAfter);
  writeArtifacts(`FINAL_PROD_MIGRATION_GOVERNANCE_${DATE}`, governance);
  fs.writeFileSync(
    path.join(OUT, `FINAL_PROD_MIGRATION_GOVERNANCE_${DATE}.md`),
    `# Migration Governance Final — ${DATE}\n\n- pending: **${governance.prod_pending_count}**\n- reconciliation_complete: **${governance.reconciliation_complete}**\n`,
  );

  const historyOk = historyAfter.pending.length === 0 && historyAfter.applied.includes(VERSION);
  const sellerOk = JSON.stringify(sellerBefore) === JSON.stringify(sellerAfter);
  const success = historyOk && billingInvariant && subscriptionPreserved && postcheck.pass && checkpoint.intact && shadow.pass;

  const report = {
    pass: success,
    status: success ? "116 PROD CONCLUÍDA COM SUCESSO" : "116 PROD INTERROMPIDA",
    project: { ref: PROD_REF, name: proj.name },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    backup: { completed: backupOk, latest: latestBackup, pitr: pitrNote, recovery_note: "Backup físico COMPLETED; restore via dashboard" },
    precheck: {
      pending: historyBefore.pending,
      table_116_before: "MISSING",
      helper_lockdown: true,
      applied_112_115: true,
      checkpoint_118_122: true,
      admissions_count: admissionsBefore,
      subscription: subBefore,
      lifecycle_counts_before: lifecycleCountsBefore,
    },
    shadow,
    bundle: {
      historical: path.basename(MIG116),
      forward_fix: path.basename(FORWARD_FIX),
      transaction: "BEGIN → histórico + lockdown → COMMIT",
      bundle_file: path.basename(bundlePath),
      status: mig.status,
    },
    postcheck,
    subscription: { before: subBefore, after: subAfter, preserved: subscriptionPreserved },
    billing_counts: { before: billingBefore, after: billingAfter, invariants_pass: billingInvariant },
    lifecycle: { before: lifecycleCountsBefore, after: lifecycleCountsAfter, invariant: lifecycleInvariant },
    repair: { version: VERSION, ...repairResult },
    history: { pending_before: historyBefore.pending, pending_after: historyAfter.pending, applied_116: historyAfter.applied.includes(VERSION) },
    governance,
    checkpoint,
    seller_counts: { before: sellerBefore, after: sellerAfter, invariant: sellerOk },
    service_role_only_rationale: "Cache backend Asaas notificationDisabled — callers via jobs service_role; apply_user_id_tenant_rls não é target",
    gates: {
      "116_prod": success ? "EXECUTADA" : "INTERROMPIDA",
      pending_migrations: success ? "0" : String(historyAfter.pending.length),
      asaas_real: "NÃO",
      cobranca_real: "NÃO",
      terms: "NÃO",
      oauth: "NÃO",
      initial_sync: "NÃO",
      commit: "NÃO",
      push: "NÃO",
      deploy: "NÃO",
    },
  };

  writeReport(report);
  relinkDev();
  prodDbPasswordMem = null;
  delete process.env.PROD_DB_PASSWORD;
  delete process.env.SUSE7_PROD_DB_PASSWORD;
  console.log(JSON.stringify({ pass: report.pass, status: report.status, pendingAfter: historyAfter.pending.length }, null, 2));
  process.exit(success ? 0 : 1);
}

main().catch((e) => {
  try {
    relinkDev();
  } catch {}
  prodDbPasswordMem = null;
  delete process.env.PROD_DB_PASSWORD;
  delete process.env.SUSE7_PROD_DB_PASSWORD;
  console.error(JSON.stringify({ pass: false, error: redact(String(e.message || e)) }));
  process.exit(1);
});
