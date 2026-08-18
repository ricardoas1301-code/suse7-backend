#!/usr/bin/env node
/**
 * BATCH 5C2 — Migration 114 PROD (trial lifecycle foundation)
 * Autorizado: 20260301000114 apenas. NÃO executar 115–116.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runShadow114 } from "./billing114_shadow_post113.mjs";
import { probeRlsCombined, probeRlsPgCatalog, sqlProbeRls } from "./billing_rls_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260818";
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const PROD_REF = "bazibzquasbdgjwdcwbz";
const DEV_REF = "alkelcaoexxbamqddaqv";
const VERSION = "20260301000114";
const MIG114 = path.join(WORKSPACE, "supabase", "migrations", "20260301000114_s7_billing_trial_lifecycle_atomic_6_9a11a.sql");
const MIG115 = path.join(WORKSPACE, "supabase", "migrations", "20260301000115_s7_billing_paid_lifecycle_atomic_6_9a12.sql");
const EXPECTED_PENDING_BEFORE = ["20260301000114", "20260301000115", "20260301000116"];
const EXPECTED_PENDING_AFTER = ["20260301000115", "20260301000116"];
const VERSION_112 = "20260301000112";
const VERSION_113 = "20260301000113";
const CHECKPOINT_VERSIONS = ["20260301000118", "20260301000119", "20260301000120", "20260301000121", "20260301000122"];
const EXPECTED_SUB_FP = "e5be9742b1d53e951a18323b52172ff6bc6c5222749f43b28d01d3f282580555";
const TRIAL_TYPES = ["TRIAL_ENDING_D3", "TRIAL_ENDING_D2", "TRIAL_ENDING_D1", "TRIAL_EXPIRED"];

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
    throw new Error("Senha postgres PROD ausente — execute run_batch5c2_interactive.ps1 localmente");
  }
  process.stderr.write("Informe a senha postgres PROD (nao sera salva):\n");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", "$s=Read-Host 'Senha postgres PROD (Suse7-prod)' -AsSecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringAuto($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }"],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  prodDbPasswordMem = (r.stdout || "").trim();
  if (!prodDbPasswordMem) throw new Error("Senha postgres PROD ausente — use run_batch5c2_interactive.ps1");
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
  const ddlProbe = psqlExec(creds, "CREATE OR REPLACE FUNCTION public.__s7_batch5c2_ddl_probe() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;");
  if (ddlProbe.status !== 0) {
    if (!resolveProdPassword()) promptPassword();
    return { host: `db.${PROD_REF}.supabase.co`, port: "5432", user: "postgres", password: resolveProdPassword(), database: "postgres", role: "postgres" };
  }
  psqlExec(creds, "DROP FUNCTION IF EXISTS public.__s7_batch5c2_ddl_probe();");
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
function auditNotificationCatalog(creds) {
  const total = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.s7_notification_event_types;").stdout || "0").trim());
  const types = {};
  for (const tk of TRIAL_TYPES) {
    const c = Number(
      (psqlExec(creds, `SELECT COUNT(*)::text FROM public.s7_notification_event_types WHERE category_code='BILLING' AND type_key='${tk}';`).stdout || "0").trim(),
    );
    types[tk] = { count: c, status: c === 1 ? "CANONICAL" : c === 0 ? "MISSING" : "DUPLICATE" };
  }
  return { total, types };
}
function auditSql114() {
  const sql = fs.readFileSync(MIG114, "utf8");
  return {
    file: path.basename(MIG114),
    lines: sql.split("\n").length,
    transaction: sql.includes("BEGIN;") && sql.includes("COMMIT;"),
    tables: ["billing_trial_lifecycle_transitions", "billing_trial_lifecycle_job_locks"],
    rpcs: [
      "billing_trial_lifecycle_try_acquire_job_lock",
      "billing_trial_lifecycle_release_job_lock",
      "billing_trial_lifecycle_apply_transition",
    ],
    catalog_dml: TRIAL_TYPES,
    billing_dml: "none — no direct DML on plans/limits/subscriptions/admissions",
  };
}
function postcheck114(creds, dumpText) {
  const tables = ["billing_trial_lifecycle_transitions", "billing_trial_lifecycle_job_locks"];
  const tbl = {};
  for (const t of tables) {
    tbl[t] = (psqlExec(creds, `SELECT COUNT(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='${t}';`).stdout || "").trim() === "1";
  }
  const rpcs = {};
  for (const fn of [
    "billing_trial_lifecycle_try_acquire_job_lock",
    "billing_trial_lifecycle_release_job_lock",
    "billing_trial_lifecycle_apply_transition",
  ]) {
    rpcs[fn] = (psqlExec(creds, `SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${fn}';`).stdout || "").trim() === "1";
  }
  const indexes = {
    transitions_uq: dumpText.includes("billing_trial_lifecycle_transitions_uq"),
    transitions_user_created: dumpText.includes("billing_trial_lifecycle_transitions_user_created_idx"),
  };
  const rls = {};
  for (const t of tables) {
    rls[t] = probeRlsCombined(psqlExec(creds, sqlProbeRls("public", t)), dumpText, t);
  }
  const acquireSp = psqlExec(
    creds,
    `SELECT proconfig::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_trial_lifecycle_try_acquire_job_lock' LIMIT 1;`,
  );
  const catalog = auditNotificationCatalog(creds);
  const catalogOk = TRIAL_TYPES.every((tk) => catalog.types[tk].count === 1);
  return {
    tables: tbl,
    tables_pass: Object.values(tbl).every(Boolean),
    rpcs,
    rpcs_pass: Object.values(rpcs).every(Boolean),
    indexes,
    rls,
    rls_pass: Object.values(rls).every((r) => r.enabled),
    search_path_public: (acquireSp.stdout || "").includes("search_path"),
    catalog,
    catalog_pass: catalogOk,
    pass: Object.values(tbl).every(Boolean) && Object.values(rpcs).every(Boolean) && catalogOk && Object.values(rls).every((r) => r.enabled),
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
function readiness115Preview(postcheck, dumpText) {
  const sql115 = fs.existsSync(MIG115) ? fs.readFileSync(MIG115, "utf8") : "";
  const depends114 = postcheck.tables_pass && postcheck.rpcs_pass;
  return {
    ready: depends114 && sql115.includes("billing_paid_lifecycle_ledger"),
    objective: "Paid subscription lifecycle — ledger + job locks + apply_transition RPC",
    ddl: ["billing_paid_lifecycle_ledger", "billing_paid_lifecycle_job_locks"],
    dml_catalog: "INSERT ON CONFLICT 10 notification types (RENEWAL, PAYMENT, GRACE, etc.)",
    lifecycle: "paid delinquency/reactivation atomic ledger",
    rpcs: ["billing_paid_lifecycle_try_acquire_job_lock", "billing_paid_lifecycle_release_job_lock", "billing_paid_lifecycle_apply_transition"],
    depends_114: "trial foundation independent; shared notification catalog pattern",
    subscription_impact: "RPC runtime only — no migration DML on real subscription",
    plans_limits_impact: "intocado",
    risk: "MÉDIO-ALTO — paid lifecycle + catalog seeds",
    note: "115 NÃO EXECUTADA — preview read-only pós-114",
  };
}
function writeArtifacts(prefix, data) {
  fs.writeFileSync(path.join(OUT, `${prefix}.json`), JSON.stringify(data, null, 2));
}
function writeReport(report) {
  writeArtifacts(`BATCH5C2_114_PROD_EXECUTION_${DATE}`, report);
  fs.writeFileSync(
    path.join(OUT, `BATCH5C2_114_PROD_EXECUTION_${DATE}.md`),
    `# BATCH 5C2 — Billing 114 PROD — ${DATE}\n\n## A. STATUS\n\n**${report.status}**\n\nVer JSON completo.\n`,
  );
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(MIG114)) throw new Error(`Migration 114 ausente: ${MIG114}`);

  const sqlAudit = auditSql114();
  const shadow = await runShadow114();
  if (!shadow.pass) {
    writeReport({ status: "114 PROD BLOQUEADA", pass: false, blocked_at: "shadow", shadow, sql_audit: sqlAudit });
    throw new Error(`Shadow FAIL: ${JSON.stringify(shadow.checks || {})}`);
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
  if (historyBefore.pending.length !== 3 || JSON.stringify([...historyBefore.pending].sort()) !== JSON.stringify([...EXPECTED_PENDING_BEFORE].sort())) {
    throw new Error(`Precheck pending FAIL: esperado 3 (${EXPECTED_PENDING_BEFORE.join(",")}), got ${historyBefore.pending.join(",")}`);
  }
  if (!historyBefore.applied.includes(VERSION_112) || !historyBefore.applied.includes(VERSION_113)) {
    throw new Error("Precheck FAIL: 112/113 devem estar applied");
  }
  writeArtifacts("MIGRATION_HISTORY_PROD_BEFORE_114", historyBefore);

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
  billingBefore.billing_billable_sale_admissions = { count: admissionsBefore, source: "sql" };

  if (billingBefore.billing_subscriptions?.count !== 1) throw new Error(`Precheck FAIL: subscriptions=${billingBefore.billing_subscriptions?.count}`);
  if (admissionsBefore !== 0) throw new Error(`Precheck FAIL: admissions=${admissionsBefore}`);

  writeArtifacts("BILLING_COUNTS_PROD_BEFORE_114", billingBefore);

  const subBefore = subscriptionFingerprintSql(creds);
  writeArtifacts("BILLING_SUBSCRIPTION_FINGERPRINT_BEFORE_114", subBefore);
  if (subBefore.structural_fingerprint !== EXPECTED_SUB_FP) {
    throw new Error(`Precheck FAIL: subscription FP divergiu do pós-113 (${subBefore.structural_fingerprint})`);
  }

  const catalogBefore = auditNotificationCatalog(creds);
  const trialBeforeStatus = {};
  for (const tk of TRIAL_TYPES) {
    trialBeforeStatus[tk] = catalogBefore.types[tk].count > 0 ? "EXISTS" : "MISSING";
  }

  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_114_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaBeforeFile.replace(/\\/g, "/")}"`, { timeout: 900000 });
  writeArtifacts("SCHEMA_FINGERPRINT_PROD_BEFORE_114", fpDump(schemaBeforeFile));

  const mig = psqlFile(creds, MIG114);
  if (mig.status !== 0) {
    writeReport({
      status: "114 PROD INTERROMPIDA", pass: false, blocked_at: "migration_114",
      error: redact((mig.stderr || mig.stdout || "").slice(0, 800)),
      precheck: { pending: historyBefore.pending, subscription: subBefore, catalog_before: catalogBefore },
      backup: { completed: backupOk, latest: latestBackup, pitr: pitrNote },
    });
    throw new Error(`Migration 114 FAIL: ${redact((mig.stderr || "").slice(0, 400))}`);
  }

  const admissionsAfter = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions;").stdout || "0").trim());
  const schemaAfterFile = path.join(OUT, `_prod_schema_after_114_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaAfterFile.replace(/\\/g, "/")}"`, { timeout: 900000 });
  const schemaAfterText = fs.readFileSync(schemaAfterFile, "utf8");
  writeArtifacts("SCHEMA_FINGERPRINT_PROD_AFTER_114", fpDump(schemaAfterFile));

  const postcheck = postcheck114(creds, schemaAfterText);
  writeArtifacts(`BILLING114_PROD_POSTCHECK_${DATE}`, postcheck);

  const catalogAfter = auditNotificationCatalog(creds);
  const catalogDelta = {
    total_before: catalogBefore.total,
    total_after: catalogAfter.total,
    delta_real: catalogAfter.total - catalogBefore.total,
    delta_expected_max: TRIAL_TYPES.filter((tk) => catalogBefore.types[tk].count === 0).length,
    trial_types: catalogAfter.types,
  };
  writeArtifacts(`BILLING114_NOTIFICATION_CATALOG_DELTA_${DATE}`, catalogDelta);

  const subAfter = subscriptionFingerprintSql(creds);
  writeArtifacts("BILLING_SUBSCRIPTION_FINGERPRINT_AFTER_114", subAfter);
  const subscriptionPreserved =
    subBefore.structural_fingerprint === subAfter.structural_fingerprint &&
    subBefore.ownership_hash === subAfter.ownership_hash &&
    subBefore.row_count === subAfter.row_count;

  const billingAfter = {};
  for (const t of BILLING_TABLES.filter((t) => t !== "billing_billable_sale_admissions")) billingAfter[t] = await restCount(serviceKey, t);
  billingAfter.billing_billable_sale_admissions = { count: admissionsAfter, source: "sql" };

  const billingInvariant =
    billingBefore.plans?.count === billingAfter.plans?.count &&
    billingBefore.billing_plan_limits?.count === billingAfter.billing_plan_limits?.count &&
    billingBefore.billing_subscriptions?.count === billingAfter.billing_subscriptions?.count &&
    admissionsBefore === 0 &&
    admissionsAfter === 0;

  if (!postcheck.pass) {
    writeReport({ status: "114 PROD INTERROMPIDA", pass: false, blocked_at: "postcheck", postcheck, subscription: { before: subBefore, after: subAfter } });
    throw new Error("Postcheck FAIL — NÃO repair");
  }
  if (!subscriptionPreserved || !billingInvariant) {
    writeReport({
      status: "114 PROD INTERROMPIDA", pass: false, blocked_at: "billing_invariants",
      subscription: { before: subBefore, after: subAfter, preserved: subscriptionPreserved },
      billing_counts: { before: billingBefore, after: billingAfter },
    });
    throw new Error("Billing invariants divergiram — NÃO repair");
  }

  const repairResult = repair(VERSION);
  if (!repairResult.ok) {
    writeReport({ status: "SQL_APPLIED_HISTORY_PENDING", pass: false, postcheck, repair: repairResult });
    throw new Error(`Repair FAIL: ${repairResult.stderr}`);
  }

  const historyAfter = parseHistory();
  writeArtifacts("MIGRATION_HISTORY_PROD_AFTER_114", historyAfter);
  writeArtifacts("BILLING_COUNTS_PROD_AFTER_114", billingAfter);

  const sellerAfter = {};
  for (const t of SELLER_TABLES) sellerAfter[t] = await restCount(serviceKey, t);

  const checkpoint = checkpoint118Readonly(historyAfter, schemaAfterText);
  const readiness115 = readiness115Preview(postcheck, schemaAfterText);

  const historyOk =
    historyAfter.pending.length === 2 &&
    JSON.stringify([...historyAfter.pending].sort()) === JSON.stringify([...EXPECTED_PENDING_AFTER].sort()) &&
    historyAfter.applied.includes(VERSION);

  const sellerOk = JSON.stringify(sellerBefore) === JSON.stringify(sellerAfter);
  const success = historyOk && billingInvariant && subscriptionPreserved && postcheck.pass && checkpoint.intact && shadow.pass;

  const report = {
    pass: success,
    status: success ? "114 PROD CONCLUÍDA COM SUCESSO" : "114 PROD INTERROMPIDA",
    project: { ref: PROD_REF, name: proj.name },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    backup: { completed: backupOk, latest: latestBackup, pitr: pitrNote, recovery_note: "Backup físico COMPLETED; restore via dashboard managed backup" },
    precheck: {
      pending: historyBefore.pending,
      applied_112: true,
      applied_113: true,
      admissions_count: admissionsBefore,
      subscription: subBefore,
      catalog_before: { total: catalogBefore.total, trial_types: trialBeforeStatus },
    },
    shadow,
    sql_audit: sqlAudit,
    migration: { file: path.basename(MIG114), status: mig.status, transaction: sqlAudit.transaction },
    postcheck,
    catalog_delta: catalogDelta,
    subscription: { before: subBefore, after: subAfter, preserved: subscriptionPreserved },
    billing_counts: { before: billingBefore, after: billingAfter, invariants_pass: billingInvariant },
    admissions: { before: admissionsBefore, after: admissionsAfter },
    repair: { version: VERSION, ...repairResult },
    history: { pending_before: historyBefore.pending, pending_after: historyAfter.pending, applied_114: historyAfter.applied.includes(VERSION) },
    readiness_115: readiness115,
    checkpoint,
    seller_counts: { before: sellerBefore, after: sellerAfter, invariant: sellerOk },
    gates: {
      "114_prod": success ? "EXECUTADA" : "INTERROMPIDA",
      "115_prod": "NÃO",
      "116_prod": "NÃO",
      trial_real: "NÃO",
      cobranca_real: "NÃO",
      asaas: "NÃO",
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
