#!/usr/bin/env node
/**
 * BATCH 5C1 — Migration 113 PROD (hardening Billing v2 pós-112)
 * Autorizado: 20260301000113 apenas. NÃO executar 114–116.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runShadow113 } from "./billing113_shadow_post112.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260818";
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const PROD_REF = "bazibzquasbdgjwdcwbz";
const DEV_REF = "alkelcaoexxbamqddaqv";
const VERSION = "20260301000113";
const MIG113 = path.join(WORKSPACE, "supabase", "migrations", "20260301000113_s7_billing_billable_sale_admission_atomic_hardening_6_9a10.sql");
const MIG114 = path.join(WORKSPACE, "supabase", "migrations", "20260301000114_s7_billing_trial_lifecycle_atomic_6_9a11a.sql");
const EXPECTED_PENDING_BEFORE = ["20260301000113", "20260301000114", "20260301000115", "20260301000116"];
const EXPECTED_PENDING_AFTER = ["20260301000114", "20260301000115", "20260301000116"];
const VERSION_112 = "20260301000112";
const CHECKPOINT_VERSIONS = ["20260301000118", "20260301000119", "20260301000120", "20260301000121", "20260301000122"];
const EXPECTED_SUB_FP = "e5be9742b1d53e951a18323b52172ff6bc6c5222749f43b28d01d3f282580555";

const V2_RPC = [
  "billing_reserve_billable_sale_v2",
  "billing_renew_billable_sale_reservation_lease_v2",
  "billing_finalize_billable_sale_v2",
  "billing_release_billable_sale_v2",
  "billing_reconcile_expired_billable_sale_reservations_v1",
  "billing_count_active_billable_slots",
];

const BILLING_TABLES = ["plans", "billing_plan_limits", "billing_subscriptions", "billing_billable_sale_admissions"];
const SELLER_TABLES = [
  "profiles", "seller_companies", "marketplace_accounts", "ml_tokens",
  "products", "marketplace_listings", "sales_orders", "sales_order_items",
  "legal_document_acceptances",
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
    throw new Error("Senha postgres PROD ausente — execute run_batch5c1_interactive.ps1 localmente");
  }
  process.stderr.write("Informe a senha postgres PROD (nao sera salva):\n");
  const r = spawnSync(
    "powershell",
    [
      "-NoProfile", "-Command",
      "$s=Read-Host 'Senha postgres PROD (Suse7-prod)' -AsSecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringAuto($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }",
    ],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  prodDbPasswordMem = (r.stdout || "").trim();
  if (!prodDbPasswordMem) throw new Error("Senha postgres PROD ausente — use run_batch5c1_interactive.ps1");
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
function psqlFile(creds, filePath) {
  return spawnSync(
    "docker",
    ["run", "--rm", "--network", "host", "-i", "-e", `PGPASSWORD=${creds.password}`, "postgres:17",
      "psql", "-h", creds.host, "-p", creds.port, "-U", creds.user, "-d", creds.database,
      "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input: fs.readFileSync(filePath, "utf8"), timeout: 900000 },
  );
}
async function ensurePostgresCreds(creds) {
  const ddlProbe = psqlExec(creds, "CREATE OR REPLACE FUNCTION public.__s7_batch5c1_ddl_probe() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;");
  if (ddlProbe.status !== 0) {
    if (!resolveProdPassword()) promptPassword();
    return { host: `db.${PROD_REF}.supabase.co`, port: "5432", user: "postgres", password: resolveProdPassword(), database: "postgres", role: "postgres" };
  }
  psqlExec(creds, "DROP FUNCTION IF EXISTS public.__s7_batch5c1_ddl_probe();");
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
  return { count: res.status === 404 ? null : m ? Number(m[1]) : null, missing: res.status === 404 };
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
function auditSql113() {
  const sql = fs.readFileSync(MIG113, "utf8");
  return {
    file: path.basename(MIG113),
    lines: sql.split("\n").length,
    transaction: sql.includes("BEGIN;") && sql.includes("COMMIT;"),
    ddl: {
      alter_table_columns: (sql.match(/ALTER TABLE public\.billing_billable_sale_admissions ADD COLUMN/g) || []).length,
      create_table: sql.includes("billing_internal_deployment_identity"),
      drop_create_indexes: ["plans_baby_active_uidx", "billing_billable_sale_admissions_cycle_active_idx", "billing_billable_sale_admissions_expires_idx", "billing_billable_sale_admissions_recovery_idx", "billing_billable_sale_admissions_active_order_uidx", "billing_billable_sale_admissions_idempotency_uidx"],
      constraint_result_chk: sql.includes("billing_billable_sale_admissions_result_chk"),
      rls_enable: sql.includes("ENABLE ROW LEVEL SECURITY"),
    },
    dml: {
      admitted_to_reserved: "ADMITTED → RESERVED (conditional, 0 rows expected PROD)",
      idempotency_backfill: "legacy idempotency_key for NULL/empty",
      subscription_usage_sync: "BABY_INTERNAL_FREE metadata sync tail block",
    },
    functions_replaced: V2_RPC.concat([
      "billing_admit_billable_sale_v1", "billing_rollback_billable_sale_admission_v1", "billing_count_admitted_billable_sales",
      "billing_internal_sync_subscription_usage_count", "billing_internal_resolve_access_precedence",
    ]),
    grants: "REVOKE ALL from PUBLIC/anon/authenticated/service_role (PROD-safe, no GRANT service_role)",
    state_conversion: "ADMITTED → RESERVED when v_admitted > 0",
  };
}
function postcheck113(creds, dumpText) {
  const funcs = {};
  for (const fn of [...V2_RPC, "billing_admit_billable_sale_v1"]) {
    const r = psqlExec(creds, `SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${fn}';`);
    funcs[fn] = (r.stdout || "").trim() === "1";
  }
  const v1Body = psqlExec(creds, `SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_admit_billable_sale_v1' LIMIT 1;`);
  const v1Wrapper = (v1Body.stdout || "").includes("v1_wrapper_disabled_use_v2");
  const babyIdx = psqlExec(creds, `SELECT COUNT(*)::text FROM pg_indexes WHERE schemaname='public' AND indexname='plans_baby_active_uidx';`);
  const statesR = psqlExec(creds, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.billing_billable_sale_admissions'::regclass AND contype='c' AND conname LIKE '%result%';`);
  const statesOk = ["RESERVED", "PERSISTED", "ROLLED_BACK", "EXPIRED", "REJECTED_QUOTA", "RECOVERY_REQUIRED"].every((s) => (statesR.stdout || "").includes(s));
  const admitted = Number((psqlExec(creds, `SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions WHERE admission_result='ADMITTED';`).stdout || "0").trim());
  const admissions = Number((psqlExec(creds, `SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions;`).stdout || "0").trim());
  const rls = psqlExec(creds, `SELECT relrowsecurity::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='billing_billable_sale_admissions';`);
  const searchPath = psqlExec(creds, `SELECT proconfig::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_reserve_billable_sale_v2' LIMIT 1;`);
  return {
    functions: funcs,
    functions_pass: V2_RPC.every((f) => funcs[f]),
    v1_wrapper: v1Wrapper,
    plans_baby_active_uidx: (babyIdx.stdout || "").trim() === "1",
    states_pass: statesOk,
    admitted_count: admitted,
    admissions_count: admissions,
    rls_enabled: (rls.stdout || "").trim() === "t",
    reserve_v2_search_path: (searchPath.stdout || "").includes("search_path=public") || (searchPath.stdout || "").includes("search_path"),
    pass: V2_RPC.every((f) => funcs[f]) && v1Wrapper && (babyIdx.stdout || "").trim() === "1" && statesOk && admitted === 0,
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
function readiness114Preview(postcheck, dumpText) {
  const sql114 = fs.existsSync(MIG114) ? fs.readFileSync(MIG114, "utf8") : "";
  const depends113 = postcheck.plans_baby_active_uidx && postcheck.functions_pass;
  const insertsNotification = sql114.includes("s7_notification_event_types");
  const createsTrialTable = sql114.includes("billing_trial_lifecycle_transitions");
  const touchesPlans = /INSERT INTO public\.plans|UPDATE public\.plans|ALTER TABLE public\.plans/i.test(sql114);
  const touchesLimits = /billing_plan_limits/i.test(sql114);
  return {
    ready: depends113 && insertsNotification && createsTrialTable && !touchesPlans && !touchesLimits,
    depends_113: depends113,
    catalog: { notification_event_types: insertsNotification, trial_lifecycle_transitions: createsTrialTable },
    plans_limits_intact: !touchesPlans && !touchesLimits,
    dml_expected: "INSERT/ON CONFLICT notification types; 0 rows billing tables",
    risk: "LOW — trial lifecycle seeds + new tables; no admission DML",
    note: "114 NÃO EXECUTADA — preview read-only pós-113",
  };
}
function writeArtifacts(prefix, data) {
  fs.writeFileSync(path.join(OUT, `${prefix}.json`), JSON.stringify(data, null, 2));
}
function writeReport(report) {
  writeArtifacts(`BATCH5C1_113_PROD_EXECUTION_${DATE}`, report);
  const md = `# BATCH 5C1 — Billing 113 PROD Execution — ${DATE}

## A. STATUS

**${report.status}**

## B. PRECHECK

- pending: ${report.precheck?.pending?.length} (${(report.precheck?.pending || []).join(", ")})
- 112 applied: ${report.precheck?.applied_112}
- admissions: ${report.precheck?.admissions_count}
- subscription: ${report.precheck?.subscription?.structural_fingerprint?.slice(0, 16)}…

## C. SHADOW

${JSON.stringify(report.shadow || {}, null, 2)}

## D. SQL 113

${JSON.stringify(report.sql_audit || {}, null, 2)}

## E. POSTCHECK

${report.postcheck?.pass ? "PASS" : "FAIL"}

## F. SUBSCRIPTION PRESERVATION

before: ${report.subscription?.before?.structural_fingerprint}
after: ${report.subscription?.after?.structural_fingerprint}
match: ${report.subscription?.preserved}

## G. ADMISSIONS

${report.admissions?.before} → ${report.admissions?.after} (DML delta: ${report.admissions?.dml_delta})

## H. SECURITY

RLS: ${report.postcheck?.rls_enabled}
search_path: ${report.postcheck?.reserve_v2_search_path}

## I. RUNTIME CALLER GUARD

${JSON.stringify(report.caller_guard || {}, null, 2)}

## J. HISTORY

${report.history?.pending_before?.length} → ${report.history?.pending_after?.length}

## K. 114 READINESS

${report.readiness_114?.ready ? "READY" : "NOT READY"}

## L. CHECKPOINT 118–122

${report.checkpoint?.intact ? "INTACTO" : "VERIFICAR"}

## M. SELLER DOMAIN

${JSON.stringify(report.seller_counts || {}, null, 2)}

## N. INCIDENTES

Backlog: Billing Maintenance Cron DEV/PROD failed; ML Webhook Events Cron DEV failed — não investigado nesta missão.

## O. GATES

113: ${report.gates?.["113_prod"]}
114–116: NÃO
`;
  fs.writeFileSync(path.join(OUT, `BATCH5C1_113_PROD_EXECUTION_${DATE}.md`), md);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(MIG113)) throw new Error(`Migration 113 ausente: ${MIG113}`);

  const sqlAudit = auditSql113();
  const shadow = runShadow113();
  if (!shadow.pass) {
    writeReport({ status: "113 PROD BLOQUEADA", pass: false, blocked_at: "shadow", shadow, sql_audit: sqlAudit });
    throw new Error(`Shadow FAIL: ${JSON.stringify(shadow.checks || {})}`);
  }

  linkProd();
  const projects = JSON.parse(run("supabase projects list -o json"));
  const proj = projects.find((p) => p.ref === PROD_REF);
  if (!proj || !/prod/i.test(proj.name || "")) throw new Error("Confirmacao PROD falhou");

  const backupsRaw = JSON.parse(run(`supabase backups list --project-ref ${PROD_REF} -o json`));
  const backups = backupsRaw.backups || backupsRaw;
  const backupOk = backups.some((b) => b.status === "COMPLETED");
  const pitrNote = backupsRaw.pitr_enabled ?? backupsRaw.physical_backup_enabled ?? false;
  if (!backupOk) throw new Error("Backup managed indisponivel — PARE");

  const historyBefore = parseHistory();
  if (historyBefore.pending.length !== 4 || JSON.stringify([...historyBefore.pending].sort()) !== JSON.stringify([...EXPECTED_PENDING_BEFORE].sort())) {
    throw new Error(`Precheck pending FAIL: esperado 4 (${EXPECTED_PENDING_BEFORE.join(",")}), got ${historyBefore.pending.join(",")}`);
  }
  if (!historyBefore.applied.includes(VERSION_112)) throw new Error("Precheck FAIL: 112 nao applied");

  writeArtifacts("MIGRATION_HISTORY_PROD_BEFORE_113", historyBefore);

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

  const admissionsBefore = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions;").stdout || "0").trim());
  const admittedBefore = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions WHERE admission_result='ADMITTED';").stdout || "0").trim());
  const babyActiveCount = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.plans WHERE plan_key='baby' AND COALESCE(is_active,true);").stdout || "0").trim());

  if (billingBefore.billing_subscriptions?.count !== 1) throw new Error(`Precheck FAIL: billing_subscriptions=${billingBefore.billing_subscriptions?.count}`);
  if (admissionsBefore !== 0 || admittedBefore > 0) throw new Error(`Precheck FAIL: admissions=${admissionsBefore} admitted=${admittedBefore} — PARE`);
  if (babyActiveCount !== 1) throw new Error(`Precheck FAIL: active baby plans=${babyActiveCount} — plans_baby_active_uidx risk`);

  billingBefore.billing_billable_sale_admissions = { count: admissionsBefore, source: "sql" };
  writeArtifacts("BILLING_COUNTS_PROD_BEFORE_113", billingBefore);

  const subBefore = subscriptionFingerprintSql(creds);
  writeArtifacts("BILLING_SUBSCRIPTION_FINGERPRINT_BEFORE_113", subBefore);
  if (subBefore.structural_fingerprint !== EXPECTED_SUB_FP) {
    console.warn(JSON.stringify({ warn: "subscription_fp_differs_from_5b3", expected: EXPECTED_SUB_FP, actual: subBefore.structural_fingerprint }));
  }

  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_113_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaBeforeFile.replace(/\\/g, "/")}"`, { timeout: 900000 });
  writeArtifacts("SCHEMA_FINGERPRINT_PROD_BEFORE_113", fpDump(schemaBeforeFile));

  const mig = psqlFile(creds, MIG113);
  if (mig.status !== 0) {
    writeReport({
      status: "113 PROD INTERROMPIDA", pass: false, blocked_at: "migration_113",
      error: redact((mig.stderr || mig.stdout || "").slice(0, 800)),
      precheck: { pending: historyBefore.pending, applied_112: true, admissions_count: admissionsBefore, subscription: subBefore },
      shadow, sql_audit: sqlAudit, backup: { completed: backupOk, pitr: pitrNote },
    });
    throw new Error(`Migration 113 FAIL: ${redact((mig.stderr || "").slice(0, 400))}`);
  }

  const admissionsAfter = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions;").stdout || "0").trim());
  const admittedAfter = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions WHERE admission_result='ADMITTED';").stdout || "0").trim());
  const dmlDelta = admissionsAfter - admissionsBefore;
  if (dmlDelta !== 0 || admittedAfter > 0) {
    writeReport({ status: "113 PROD INTERROMPIDA", pass: false, blocked_at: "dml_unexpected", admissions: { before: admissionsBefore, after: admissionsAfter, dml_delta: dmlDelta } });
    throw new Error(`DML inesperado: delta=${dmlDelta} admitted=${admittedAfter} — NÃO repair`);
  }

  const schemaAfterFile = path.join(OUT, `_prod_schema_after_113_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaAfterFile.replace(/\\/g, "/")}"`, { timeout: 900000 });
  const schemaAfterText = fs.readFileSync(schemaAfterFile, "utf8");
  writeArtifacts("SCHEMA_FINGERPRINT_PROD_AFTER_113", fpDump(schemaAfterFile));

  const postcheck = postcheck113(creds, schemaAfterText);
  writeArtifacts(`BILLING113_PROD_POSTCHECK_${DATE}`, postcheck);

  const subAfter = subscriptionFingerprintSql(creds);
  writeArtifacts("BILLING_SUBSCRIPTION_FINGERPRINT_AFTER_113", subAfter);
  const subscriptionPreserved =
    subBefore.structural_fingerprint === subAfter.structural_fingerprint &&
    subBefore.ownership_hash === subAfter.ownership_hash &&
    subBefore.row_count === subAfter.row_count;

  if (!postcheck.pass) {
    writeReport({ status: "113 PROD INTERROMPIDA", pass: false, blocked_at: "postcheck", postcheck, subscription: { before: subBefore, after: subAfter, preserved: subscriptionPreserved } });
    throw new Error("Postcheck FAIL — NÃO repair");
  }
  if (!subscriptionPreserved) {
    writeReport({ status: "113 PROD INTERROMPIDA", pass: false, blocked_at: "subscription_fingerprint", subscription: { before: subBefore, after: subAfter, preserved: false } });
    throw new Error("Subscription fingerprint divergiu — NÃO repair");
  }

  const callerGuard = spawnSync("node", [path.join(__dirname, "billing112_caller_audit.test.mjs")], { encoding: "utf8", cwd: __dirname });
  const callerGuardResult = { pass: callerGuard.status === 0, stdout: (callerGuard.stdout || "").slice(0, 500) };
  if (!callerGuardResult.pass) throw new Error("Caller guard FAIL — NÃO repair");

  const repairResult = repair(VERSION);
  if (!repairResult.ok) {
    writeReport({ status: "SQL_APPLIED_HISTORY_PENDING", pass: false, postcheck, repair: repairResult });
    throw new Error(`Repair FAIL: ${repairResult.stderr}`);
  }

  const historyAfter = parseHistory();
  writeArtifacts("MIGRATION_HISTORY_PROD_AFTER_113", historyAfter);

  const billingAfter = {};
  for (const t of BILLING_TABLES.filter((t) => t !== "billing_billable_sale_admissions")) billingAfter[t] = await restCount(serviceKey, t);
  billingAfter.billing_billable_sale_admissions = { count: admissionsAfter, source: "sql" };
  writeArtifacts("BILLING_COUNTS_PROD_AFTER_113", billingAfter);

  const sellerAfter = {};
  for (const t of SELLER_TABLES) sellerAfter[t] = await restCount(serviceKey, t);

  const checkpoint = checkpoint118Readonly(historyAfter, schemaAfterText);
  const readiness114 = readiness114Preview(postcheck, schemaAfterText);

  const historyOk =
    historyAfter.pending.length === 3 &&
    JSON.stringify([...historyAfter.pending].sort()) === JSON.stringify([...EXPECTED_PENDING_AFTER].sort()) &&
    historyAfter.applied.includes(VERSION);

  const billingOk =
    billingBefore.plans?.count === billingAfter.plans?.count &&
    billingBefore.billing_plan_limits?.count === billingAfter.billing_plan_limits?.count &&
    billingBefore.billing_subscriptions?.count === billingAfter.billing_subscriptions?.count &&
    admissionsAfter === 0;

  const sellerOk = JSON.stringify(sellerBefore) === JSON.stringify(sellerAfter);
  const success = historyOk && billingOk && subscriptionPreserved && postcheck.pass && checkpoint.intact && shadow.pass;

  const report = {
    pass: success,
    status: success ? "113 PROD CONCLUÍDA COM SUCESSO" : "113 PROD INTERROMPIDA",
    project: { ref: PROD_REF, name: proj.name },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    backup: { completed: backupOk, pitr: pitrNote, recovery_note: pitrNote ? "PITR/dashboard restore disponivel" : "PITR API=false; backup managed COMPLETED ok" },
    precheck: { pending: historyBefore.pending, applied_112: true, admissions_count: admissionsBefore, baby_active_plans: babyActiveCount, subscription: subBefore },
    shadow,
    sql_audit: sqlAudit,
    migration: { file: path.basename(MIG113), status: mig.status, dml_expected: 0, dml_actual: dmlDelta, admitted_after: admittedAfter },
    postcheck,
    subscription: { before: subBefore, after: subAfter, preserved: subscriptionPreserved },
    admissions: { before: admissionsBefore, after: admissionsAfter, dml_delta: dmlDelta, admitted_before: admittedBefore, admitted_after: admittedAfter },
    caller_guard: callerGuardResult,
    repair: { version: VERSION, ...repairResult },
    history: { pending_before: historyBefore.pending, pending_after: historyAfter.pending, applied_113: historyAfter.applied.includes(VERSION) },
    readiness_114: readiness114,
    checkpoint,
    billing_counts: { before: billingBefore, after: billingAfter },
    seller_counts: { before: sellerBefore, after: sellerAfter },
    gates: {
      "113_prod": success ? "EXECUTADA" : "INTERROMPIDA",
      "114_prod": "NÃO", "115_prod": "NÃO", "116_prod": "NÃO",
      cobranca_real: "NÃO", asaas: "NÃO", terms: "NÃO", oauth: "NÃO", initial_sync: "NÃO",
      commit: "NÃO", push: "NÃO", deploy: "NÃO",
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
