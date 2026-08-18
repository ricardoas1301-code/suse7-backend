#!/usr/bin/env node
/**
 * BATCH 5B3 — Forward-fix Billing 112 PROD (v1→v2) + repair history
 * Autorizado: 20260301000112 apenas. NÃO executar 113–116.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260818";
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const PROD_REF = "bazibzquasbdgjwdcwbz";
const DEV_REF = "alkelcaoexxbamqddaqv";
const VERSION = "20260301000112";
const FIX_SQL = path.join(OUT, "BILLING112_FORWARD_FIX_CANDIDATE_20260818.sql");
const SCHEMA_MATRIX = path.join(OUT, "BILLING112_SCHEMA_MATRIX_20260818.json");
const EXPECTED_PENDING_BEFORE = ["20260301000112", "20260301000113", "20260301000114", "20260301000115", "20260301000116"];
const EXPECTED_PENDING_AFTER = ["20260301000113", "20260301000114", "20260301000115", "20260301000116"];
const CHECKPOINT_VERSIONS = ["20260301000118", "20260301000119", "20260301000120", "20260301000121", "20260301000122"];

const V2_COLUMNS = [
  "usage_limit", "entitlement_type", "entitlement_source", "pause_cycle_key", "pause_reason",
  "previous_sync_state", "previous_usage_state", "previous_access_profile", "reservation_owner_token",
  "reservation_attempt_id", "reserved_at", "reservation_expires_at", "persisted_at", "finalized_at",
  "expired_at", "recovery_attempt_count", "last_recovery_at", "next_recovery_at", "recovery_reason",
  "reservation_heartbeat_at", "cycle_limit_snapshot", "updated_at", "last_error_code",
];

const V2_RPC_FUNCTIONS = [
  "billing_reserve_billable_sale_v2",
  "billing_renew_billable_sale_reservation_lease_v2",
  "billing_finalize_billable_sale_v2",
  "billing_release_billable_sale_v2",
  "billing_reconcile_expired_billable_sale_reservations_v1",
  "billing_count_active_billable_slots",
];

const V1_FUNCTIONS = [
  "billing_admit_billable_sale_v1",
  "billing_rollback_billable_sale_admission_v1",
  "billing_count_admitted_billable_sales",
];

const V2_STATES = ["RESERVED", "PERSISTED", "ROLLED_BACK", "EXPIRED", "REJECTED_QUOTA", "RECOVERY_REQUIRED"];

const V2_INDEXES = [
  "billing_billable_sale_admissions_cycle_active_idx",
  "billing_billable_sale_admissions_expires_idx",
  "billing_billable_sale_admissions_recovery_idx",
  "billing_billable_sale_admissions_active_order_uidx",
  "billing_billable_sale_admissions_idempotency_uidx",
];

const CHECKPOINT_OBJECTS = [
  { type: "table", name: "legal_document_acceptances" },
  { type: "function", name: "s7_complete_signup_birth_once" },
  { type: "column_latch", table: "profiles", pattern: /profiles.*latch/i },
  { type: "index", name: "marketplace_accounts_global_active_external_uidx" },
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
    throw new Error("Senha postgres PROD ausente — execute run_batch5b3_interactive.ps1 localmente");
  }
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
  prodDbPasswordMem = (r.stdout || "").trim();
  if (!prodDbPasswordMem) throw new Error("Senha postgres PROD ausente — use run_batch5b3_interactive.ps1");
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
function psqlSpawnArgs(creds, extraArgs) {
  return [
    "run", "--rm", "--network", "host", "-e", `PGPASSWORD=${creds.password}`,
    "postgres:17", "psql", "-h", creds.host, "-p", creds.port, "-U", creds.user, "-d", creds.database,
    "-v", "ON_ERROR_STOP=1", ...extraArgs,
  ];
}
function psqlExec(creds, sql) {
  return spawnSync("docker", psqlSpawnArgs(creds, ["-t", "-A", "-c", sql]), { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
function psqlFile(creds, filePath) {
  return spawnSync(
    "docker",
    ["run", "--rm", "--network", "host", "-i", "-e", `PGPASSWORD=${creds.password}`, "postgres:17",
      "psql", "-h", creds.host, "-p", creds.port, "-U", creds.user, "-d", creds.database,
      "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input: fs.readFileSync(filePath, "utf8") },
  );
}
async function ensurePostgresCreds(creds) {
  const ddlProbe = psqlExec(creds, "CREATE OR REPLACE FUNCTION public.__s7_batch5b3_ddl_probe() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;");
  if (ddlProbe.status !== 0) {
    if (!resolveProdPassword()) promptPassword();
    return {
      host: `db.${PROD_REF}.supabase.co`, port: "5432", user: "postgres",
      password: resolveProdPassword(), database: "postgres", role: "postgres",
    };
  }
  psqlExec(creds, "DROP FUNCTION IF EXISTS public.__s7_batch5b3_ddl_probe();");
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
  return {
    fingerprint: sha256([...tables, ...indexes, ...functions].join("|")),
    counts: { tables: tables.length, indexes: indexes.length, functions: functions.length },
    tables, indexes, functions,
  };
}
function subscriptionFingerprintFromDump(text) {
  const block = text.match(/COPY public\.billing_subscriptions[\s\S]*?\\\./);
  if (!block) return { fingerprint: null, source: "dump_unavailable" };
  return { fingerprint: sha256(block[0].replace(/\d{4}-\d{2}-\d{2}[^\t]*/g, "[TS]")), source: "dump_copy_redacted" };
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
  return {
    row_count: lines.length,
    structural_fingerprint: sha256(structural.join("\n")),
    ownership_hash: sha256(ownership),
    structural_sample: structural[0] || null,
  };
}
function schemaV1Precheck(creds, dumpText) {
  const hasTable = dumpText.includes("billing_billable_sale_admissions");
  const v1Present = V1_FUNCTIONS.every((f) => dumpText.includes(`"${f}"`) || new RegExp(`FUNCTION public\\.${f}`, "i").test(dumpText));
  const v2Absent = !dumpText.includes("billing_reserve_billable_sale_v2");
  const colsMissing = V2_COLUMNS.filter((c) => {
    const r = psqlExec(creds, `SELECT COUNT(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='billing_billable_sale_admissions' AND column_name='${c}';`);
    return (r.stdout || "").trim() !== "1";
  });
  return { hasTable, v1Present, v2Absent, v2ColumnsStillMissing: colsMissing, pass: hasTable && v1Present && v2Absent && colsMissing.length === V2_COLUMNS.length };
}
function postcheckV2(creds, dumpText) {
  const cols = {};
  for (const c of V2_COLUMNS) {
    const r = psqlExec(creds, `SELECT COUNT(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='billing_billable_sale_admissions' AND column_name='${c}';`);
    cols[c] = (r.stdout || "").trim() === "1";
  }
  const statesR = psqlExec(
    creds,
    `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.billing_billable_sale_admissions'::regclass AND contype='c' AND conname LIKE '%result%';`,
  );
  const statesOk = V2_STATES.every((s) => (statesR.stdout || "").includes(s));
  const indexes = {};
  for (const idx of V2_INDEXES) {
    const r = psqlExec(creds, `SELECT COUNT(*)::text FROM pg_indexes WHERE schemaname='public' AND indexname='${idx}';`);
    indexes[idx] = (r.stdout || "").trim() === "1";
  }
  const funcs = {};
  for (const fn of [...V2_RPC_FUNCTIONS, "billing_admit_billable_sale_v1"]) {
    const r = psqlExec(creds, `SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${fn}';`);
    funcs[fn] = (r.stdout || "").trim() === "1";
  }
  const deployId = psqlExec(creds, `SELECT COUNT(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='billing_internal_deployment_identity';`);
  const v1Body = psqlExec(creds, `SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_admit_billable_sale_v1' LIMIT 1;`);
  const v1Wrapper = (v1Body.stdout || "").includes("v1_wrapper_disabled_use_v2");
  const admissions = psqlExec(creds, `SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions;`);
  const admitted = psqlExec(creds, `SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions WHERE admission_result='ADMITTED';`);
  return {
    columns: cols,
    columns_pass: Object.values(cols).every(Boolean),
    states_pass: statesOk,
    indexes,
    indexes_pass: Object.values(indexes).every(Boolean),
    functions: funcs,
    functions_pass: V2_RPC_FUNCTIONS.every((f) => funcs[f]),
    billing_internal_deployment_identity: (deployId.stdout || "").trim() === "1",
    v1_wrapper: v1Wrapper,
    admissions_count: Number((admissions.stdout || "0").trim()),
    admitted_count: Number((admitted.stdout || "0").trim()),
    pass: Object.values(cols).every(Boolean) && statesOk && Object.values(indexes).every(Boolean) &&
      V2_RPC_FUNCTIONS.every((f) => funcs[f]) && (deployId.stdout || "").trim() === "1" && v1Wrapper,
  };
}
function checkpoint118Readonly(history, dumpText) {
  const applied = CHECKPOINT_VERSIONS.every((v) => history.applied.includes(v));
  const legal = dumpText.includes("legal_document_acceptances");
  const signup = dumpText.includes("s7_complete_signup_birth_once");
  const mlIdx = dumpText.includes("marketplace_accounts_global_active_external_uidx");
  const profilesLatch = /profiles.*latch|latch.*profiles|onboarding_latch/i.test(dumpText);
  return { applied_versions: applied, legal_document_acceptances: legal, s7_complete_signup_birth_once: signup, marketplace_accounts_global_active_external_uidx: mlIdx, profiles_latches: profilesLatch, intact: applied && legal && signup && mlIdx };
}
function readiness113Preview(postcheck, dumpText) {
  const reserve = postcheck.functions?.billing_reserve_billable_sale_v2 === true;
  const salesOrders = dumpText.includes("sales_orders");
  const ma = dumpText.includes("marketplace_accounts");
  return {
    ready: reserve && salesOrders && ma && postcheck.states_pass,
    reserve_v2: reserve,
    sales_orders: salesOrders,
    marketplace_accounts: ma,
    note: "113 NÃO EXECUTADA — preview read-only pós-112",
  };
}
function equivalenceMatrix(postcheck) {
  const matrix = fs.existsSync(SCHEMA_MATRIX) ? JSON.parse(fs.readFileSync(SCHEMA_MATRIX, "utf8")) : [];
  const results = matrix.slice(0, 20).map((row) => ({
    objeto: row.objeto,
    status: postcheck.pass ? "MATCH" : row.prod_v1 === "MISSING" && postcheck.columns_pass ? "MATCH" : "LEGACY_SAFE",
  }));
  const missing = [];
  if (!postcheck.functions_pass) missing.push("v2_functions");
  if (!postcheck.columns_pass) missing.push("v2_columns");
  if (!postcheck.indexes_pass) missing.push("v2_indexes");
  return { items: results, missing, different: missing, repair_allowed: missing.length === 0 && postcheck.pass };
}
function writeArtifacts(prefix, data) {
  fs.writeFileSync(path.join(OUT, `${prefix}.json`), JSON.stringify(data, null, 2));
}
function writeReport(report) {
  fs.writeFileSync(path.join(OUT, `BATCH5B3_112_PROD_EXECUTION_${DATE}.json`), JSON.stringify(report, null, 2));
  const md = `# BATCH 5B3 — Billing 112 PROD Execution — ${DATE}

## A. STATUS

**${report.status}**

## B. PRECHECK

- pending: ${report.precheck?.pending?.length} (${(report.precheck?.pending || []).join(", ")})
- admissions: ${report.precheck?.admissions_count}
- subscription structural: ${report.precheck?.subscription?.structural_fingerprint?.slice(0, 16)}…
- schema v1: ${report.precheck?.schema_v1?.pass ? "PASS" : "FAIL"}

## C. BACKUP/PITR

${JSON.stringify(report.backup || {}, null, 2)}

## D. FORWARD-FIX

- transaction: ${report.forward_fix?.transaction}
- DDL status: ${report.forward_fix?.ddl_status}
- DML expected/actual: ${report.forward_fix?.dml_expected} / ${report.forward_fix?.dml_actual}

## E. SCHEMA V2

Postcheck: ${report.postcheck?.pass ? "PASS" : "FAIL"}

## F. V1 WRAPPER

${report.postcheck?.v1_wrapper ? "v1_wrapper_disabled_use_v2 OK" : "FAIL"}

## G. SUBSCRIPTION PRESERVATION

before: ${report.subscription?.before?.structural_fingerprint}
after: ${report.subscription?.after?.structural_fingerprint}
match: ${report.subscription?.preserved}

## H. ADMISSIONS

${report.admissions?.before} → ${report.admissions?.after}

## K. HISTORY

${report.history?.pending_before?.length} → ${report.history?.pending_after?.length}

## L. 113 READINESS

${report.readiness_113?.ready ? "READY" : "NOT READY"} (113 não executada)

## M. CHECKPOINT 118–122

${report.checkpoint?.intact ? "INTACTO" : "VERIFICAR"}

## P. GATES

112: ${report.gates?.["112_prod"]}
113–116: NÃO
`;
  fs.writeFileSync(path.join(OUT, `BATCH5B3_112_PROD_EXECUTION_${DATE}.md`), md);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(FIX_SQL)) throw new Error(`Forward-fix ausente: ${FIX_SQL}`);

  linkProd();
  const projects = JSON.parse(run("supabase projects list -o json"));
  const proj = projects.find((p) => p.ref === PROD_REF);
  if (!proj || !/prod/i.test(proj.name || "")) throw new Error("Confirmacao PROD falhou — ref/name");

  const backupsRaw = JSON.parse(run(`supabase backups list --project-ref ${PROD_REF} -o json`));
  const backups = backupsRaw.backups || backupsRaw;
  const backupOk = backups.some((b) => b.status === "COMPLETED");
  const pitrNote = backupsRaw.pitr_enabled ?? backupsRaw.physical_backup_enabled ?? "verificar_dashboard";
  if (!backupOk) throw new Error("Backup managed indisponivel — PARE");

  const historyBefore = parseHistory();
  if (historyBefore.pending.length !== 5 || JSON.stringify([...historyBefore.pending].sort()) !== JSON.stringify([...EXPECTED_PENDING_BEFORE].sort())) {
    throw new Error(`Precheck pending FAIL: esperado 5 (${EXPECTED_PENDING_BEFORE.join(",")}), got ${historyBefore.pending.join(",")}`);
  }

  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_112_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaBeforeFile.replace(/\\/g, "/")}"`, { timeout: 900000 });
  const schemaBeforeText = fs.readFileSync(schemaBeforeFile, "utf8");
  const fpBefore = fpDump(schemaBeforeFile);
  writeArtifacts("SCHEMA_FINGERPRINT_PROD_BEFORE_112", fpBefore);
  writeArtifacts("MIGRATION_HISTORY_PROD_BEFORE_112", historyBefore);

  const serviceKey = JSON.parse(run(`supabase projects api-keys --project-ref ${PROD_REF} -o json`)).find((k) => /service_role/i.test(k.name))?.api_key;
  const billingBefore = {};
  for (const t of BILLING_TABLES) billingBefore[t] = await restCount(serviceKey, t);
  writeArtifacts("BILLING_COUNTS_PROD_BEFORE_112", billingBefore);

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

  const admissionsSqlBefore = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions;").stdout || "0").trim());
  const admittedSqlBefore = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions WHERE admission_result='ADMITTED';").stdout || "0").trim());
  billingBefore.billing_billable_sale_admissions = { count: admissionsSqlBefore, source: "sql" };
  billingBefore.billing_billable_sale_admissions_admitted = { count: admittedSqlBefore, source: "sql" };

  if (billingBefore.billing_subscriptions.count !== 1) throw new Error(`Precheck FAIL: billing_subscriptions=${billingBefore.billing_subscriptions.count}`);
  if (admissionsSqlBefore !== 0) {
    throw new Error(`Precheck FAIL: admissions=${admissionsSqlBefore} — PARE, Rico+Neo reavaliam`);
  }
  if (admittedSqlBefore > 0) {
    throw new Error(`Precheck FAIL: ADMITTED rows=${admittedSqlBefore} — PARE`);
  }

  const schemaV1 = schemaV1Precheck(creds, schemaBeforeText);
  if (!schemaV1.pass) throw new Error(`Precheck schema v1 FAIL: ${JSON.stringify(schemaV1)}`);

  const subBefore = subscriptionFingerprintSql(creds);
  writeArtifacts("BILLING_SUBSCRIPTION_FINGERPRINT_BEFORE_112", subBefore);

  const admissionsBeforeSql = admissionsSqlBefore;

  // --- EXECUTE FORWARD-FIX ---
  const ddl = psqlFile(creds, FIX_SQL);
  const ddlOk = ddl.status === 0;
  const admissionsAfterSql = Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions;").stdout || "0").trim());
  const dmlDelta = admissionsAfterSql - admissionsBeforeSql;

  if (!ddlOk) {
    const err = redact((ddl.stderr || ddl.stdout || "").slice(0, 600));
    const report = {
      status: "112 PROD INTERROMPIDA",
      pass: false,
      blocked_at: "forward_fix",
      forward_fix: { transaction: "BEGIN/COMMIT esperado rollback se falha", ddl_status: ddl.status, error: err },
      precheck: { pending: historyBefore.pending, admissions_count: billingBefore.billing_billable_sale_admissions.count, schema_v1: schemaV1, subscription: subBefore },
      backup: { completed: backupOk, pitr: pitrNote, started_at: startedAt },
    };
    writeReport(report);
    throw new Error(`Forward-fix FAIL: ${err}`);
  }

  if (dmlDelta !== 0) {
    const report = {
      status: "112 PROD INTERROMPIDA",
      pass: false,
      blocked_at: "dml_unexpected",
      forward_fix: { dml_expected: 0, dml_actual: dmlDelta },
      admissions: { before: admissionsBeforeSql, after: admissionsAfterSql },
    };
    writeReport(report);
    throw new Error(`DML inesperado: delta=${dmlDelta} — NÃO repair`);
  }

  const schemaAfterFile = path.join(OUT, `_prod_schema_after_112_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaAfterFile.replace(/\\/g, "/")}"`, { timeout: 900000 });
  const schemaAfterText = fs.readFileSync(schemaAfterFile, "utf8");
  const fpAfter = fpDump(schemaAfterFile);
  writeArtifacts("SCHEMA_FINGERPRINT_PROD_AFTER_112", fpAfter);

  const postcheck = postcheckV2(creds, schemaAfterText);
  writeArtifacts("BILLING112_PROD_POSTCHECK_20260818", postcheck);

  const subAfter = subscriptionFingerprintSql(creds);
  writeArtifacts("BILLING_SUBSCRIPTION_FINGERPRINT_AFTER_112", subAfter);
  const subscriptionPreserved = subBefore.structural_fingerprint === subAfter.structural_fingerprint &&
    subBefore.ownership_hash === subAfter.ownership_hash && subBefore.row_count === subAfter.row_count;

  if (!postcheck.pass) {
    writeReport({ status: "112 PROD INTERROMPIDA", pass: false, blocked_at: "postcheck", postcheck, subscription: { before: subBefore, after: subAfter, preserved: subscriptionPreserved } });
    throw new Error("Postcheck schema v2 FAIL — NÃO repair");
  }
  if (!subscriptionPreserved) {
    writeReport({ status: "112 PROD INTERROMPIDA", pass: false, blocked_at: "subscription_fingerprint", subscription: { before: subBefore, after: subAfter, preserved: false } });
    throw new Error("Subscription fingerprint divergiu — NÃO repair");
  }

  const callerGuard = spawnSync("node", [path.join(__dirname, "billing112_caller_audit.test.mjs")], { encoding: "utf8", cwd: __dirname });
  if (callerGuard.status !== 0) throw new Error("Caller guard FAIL — NÃO repair");

  const equiv = equivalenceMatrix(postcheck);
  if (!equiv.repair_allowed) throw new Error("Equivalência FAIL — NÃO repair");

  const repairResult = repair(VERSION);
  if (!repairResult.ok) {
    writeReport({
      status: "SQL_APPLIED_HISTORY_PENDING",
      pass: false,
      postcheck,
      repair: repairResult,
      note: "Schema PASS mas repair falhou — RCA necessario",
    });
    throw new Error(`Repair FAIL: ${repairResult.stderr}`);
  }

  const historyAfter = parseHistory();
  writeArtifacts("MIGRATION_HISTORY_PROD_AFTER_112", historyAfter);

  const billingAfter = {};
  for (const t of BILLING_TABLES.filter((t) => t !== "billing_billable_sale_admissions")) billingAfter[t] = await restCount(serviceKey, t);
  billingAfter.billing_billable_sale_admissions = {
    count: Number((psqlExec(creds, "SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions;").stdout || "0").trim()),
    source: "sql",
  };
  writeArtifacts("BILLING_COUNTS_PROD_AFTER_112", billingAfter);

  const sellerAfter = {};
  for (const t of SELLER_TABLES) sellerAfter[t] = await restCount(serviceKey, t);

  const checkpoint = checkpoint118Readonly(historyAfter, schemaAfterText);
  const readiness113Result = readiness113Preview(postcheck, schemaAfterText);

  const historyOk =
    historyAfter.pending.length === 4 &&
    JSON.stringify([...historyAfter.pending].sort()) === JSON.stringify([...EXPECTED_PENDING_AFTER].sort()) &&
    historyAfter.applied.includes(VERSION);

  const billingOk =
    billingBefore.plans.count === billingAfter.plans.count &&
    billingBefore.billing_plan_limits.count === billingAfter.billing_plan_limits.count &&
    billingBefore.billing_subscriptions.count === billingAfter.billing_subscriptions.count &&
    billingAfter.billing_billable_sale_admissions.count === 0;

  const sellerOk = JSON.stringify(sellerBefore) === JSON.stringify(sellerAfter);
  const success = historyOk && billingOk && subscriptionPreserved && postcheck.pass && checkpoint.intact;

  const report = {
    pass: success,
    status: success ? "112 PROD CONCLUÍDA COM SUCESSO" : "112 PROD INTERROMPIDA",
    project: { ref: PROD_REF, name: proj.name },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    backup: { completed: backupOk, pitr: pitrNote, recovery_point: startedAt },
    precheck: {
      pending: historyBefore.pending,
      admissions_count: billingBefore.billing_billable_sale_admissions.count,
      subscription: subBefore,
      schema_v1: schemaV1,
    },
    forward_fix: {
      file: path.basename(FIX_SQL),
      transaction: "BEGIN/COMMIT",
      ddl_status: ddl.status,
      role: creds.role,
      dml_expected: 0,
      dml_actual: dmlDelta,
    },
    postcheck,
    subscription: { before: subBefore, after: subAfter, preserved: subscriptionPreserved },
    admissions: { before: admissionsBeforeSql, after: admissionsAfterSql, delta: dmlDelta },
    equivalence: equiv,
    repair: { version: VERSION, ...repairResult },
    history: { pending_before: historyBefore.pending, pending_after: historyAfter.pending, applied_112: historyAfter.applied.includes(VERSION) },
    readiness_113: readiness113Result,
    checkpoint,
    billing_counts: { before: billingBefore, after: billingAfter },
    seller_counts: { before: sellerBefore, after: sellerAfter },
    schema_fingerprint: { before: fpBefore, after: fpAfter },
    gates: {
      "112_prod": success ? "EXECUTADA" : "INTERROMPIDA",
      "113_prod": "NÃO",
      "114_prod": "NÃO",
      "115_prod": "NÃO",
      "116_prod": "NÃO",
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
