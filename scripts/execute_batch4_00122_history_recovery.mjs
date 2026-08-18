#!/usr/bin/env node
/**
 * BATCH 4 RECOVERY — repair history 20260301000122 ONLY
 * READ-ONLY precheck → migration repair → READ-ONLY postcheck
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
const PROD_REF = "bazibzquasbdgjwdcwbz";
const DEV_REF = "alkelcaoexxbamqddaqv";
const VERSION = "20260301000122";
const EXPECTED_PENDING = [
  "20260301000043",
  "20260301000112",
  "20260301000113",
  "20260301000114",
  "20260301000115",
  "20260301000116",
];

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

function assertProdProject() {
  linkProd();
  const projects = JSON.parse(run("supabase projects list -o json"));
  const linked = projects.find((p) => p.ref === PROD_REF);
  if (!linked) throw new Error(`Project ref ${PROD_REF} nao encontrado`);
  if (!/prod/i.test(linked.name || "")) throw new Error(`Confirmacao PROD falhou: ${linked.name}`);
  return { ref: PROD_REF, name: linked.name };
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

function psqlExec(creds, sql) {
  return spawnSync(
    "docker",
    [
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
      "-t",
      "-A",
      "-c",
      sql,
    ],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
}

function exists(creds, sql) {
  return (psqlExec(creds, sql).stdout || "").trim() === "t";
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

function extrairIndexdefDoDump(dumpText, indexName) {
  const re = new RegExp(
    `CREATE UNIQUE INDEX (?:IF NOT EXISTS )?"${indexName}"[\\s\\S]*?;`,
    "i",
  );
  const m = dumpText.match(re);
  if (m) return m[0].replace(/\s+/g, " ").trim();
  const re2 = new RegExp(`CREATE UNIQUE INDEX (?:IF NOT EXISTS )?${indexName}[\\s\\S]*?;`, "i");
  const m2 = dumpText.match(re2);
  return m2 ? m2[0].replace(/\s+/g, " ").trim() : "";
}

function precheck00122(creds, schemaDumpText) {
  let indexdefFromPsql = "";
  if (creds) {
    const idxDef = psqlExec(
      creds,
      "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='marketplace_accounts_global_active_external_uidx';",
    );
    indexdefFromPsql = (idxDef.stdout || "").trim();
  }
  const indexdefFromDump = extrairIndexdefDoDump(schemaDumpText || "", "marketplace_accounts_global_active_external_uidx");
  const indexDefinition = indexdefFromPsql || indexdefFromDump;

  let duplicatePairs = 0;
  let total = 0;
  if (creds) {
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
    duplicatePairs = parseInt((dup.stdout || "0").trim(), 10);
    total = parseInt((psqlExec(creds, "SELECT count(*)::int FROM public.marketplace_accounts;").stdout || "0").trim(), 10);
  }

  const indexExistsPsql = creds
    ? exists(
        creds,
        "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='marketplace_accounts_global_active_external_uidx');",
      )
    : false;
  const indexExists = indexExistsPsql || indexdefFromDump.length > 0;

  const semantic = validarIndiceMlGlobalUnique({
    index_exists: indexExists,
    index_definition: indexDefinition,
  });
  return {
    ...semantic,
    index_source: indexdefFromPsql ? "pg_indexes" : indexdefFromDump ? "schema_dump" : "none",
    duplicate_active_pairs: duplicatePairs,
    marketplace_accounts_total: total,
    pass: semantic.pass && duplicatePairs === 0,
  };
}

const LATCH_COLUMNS = [
  "operational_cycle_configured_at",
  "first_marketplace_connected_at",
  "initial_configuration_completed_at",
];

function probeCheckpoint(creds) {
  return {
    legal_document_acceptances: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='legal_document_acceptances');",
    ),
    legal_rows: parseInt((psqlExec(creds, "SELECT count(*)::int FROM public.legal_document_acceptances;").stdout || "0").trim(), 10),
    signup_pending_births: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='s7_private' AND table_name='signup_pending_births');",
    ),
    s7_complete_signup_birth_once: exists(
      creds,
      "SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='s7_complete_signup_birth_once');",
    ),
    latch_columns: LATCH_COLUMNS.every((col) =>
      exists(
        creds,
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='${col}');`,
      ),
    ),
  };
}

function countsIdentical(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const project = assertProdProject();
  const creds = getEphemeralDbCreds();
  if (!creds) throw new Error("Credenciais read-only indisponiveis para precheck");

  const historyBefore = getMigrationList();
  if (historyBefore.pending.length !== 7 || !historyBefore.pending.includes(VERSION)) {
    throw new Error(`Expected pending=7 incluindo ${VERSION}, got ${historyBefore.pending.length}: ${historyBefore.pending.join(",")}`);
  }
  if (historyBefore.remoteApplied.includes(VERSION)) {
    throw new Error(`${VERSION} ja applied — abortado`);
  }

  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_00122_repair_${DATE}.sql`);
  dumpSchema(schemaBeforeFile);
  const schemaBeforeText = fs.readFileSync(schemaBeforeFile, "utf8");
  const fpBefore = fingerprintDump(schemaBeforeFile);
  const serviceKey = await getServiceRoleKey();
  const countsBefore = await collectCounts(serviceKey, creds);
  const precheck = precheck00122(creds, schemaBeforeText);
  const checkpointBefore = probeCheckpoint(creds);

  fs.writeFileSync(path.join(OUT, `MIGRATION_HISTORY_PROD_BEFORE_00122_REPAIR.json`), JSON.stringify({ captured_at: new Date().toISOString(), project, ...historyBefore }, null, 2));
  fs.writeFileSync(path.join(OUT, `SCHEMA_FINGERPRINT_PROD_BEFORE_00122_REPAIR.json`), JSON.stringify({ captured_at: new Date().toISOString(), ...fpBefore }, null, 2));
  fs.writeFileSync(path.join(OUT, `PROD_COUNTS_BEFORE_00122_REPAIR.json`), JSON.stringify({ counts: countsBefore }, null, 2));

  if (!precheck.pass) {
    const blocked = {
      pass: false,
      status: "BATCH 4 RECOVERY BLOQUEADO",
      reason: "precheck_fail",
      precheck,
      project,
    };
    fs.writeFileSync(path.join(OUT, `BATCH4_00122_HISTORY_RECOVERY_${DATE}.json`), JSON.stringify(blocked, null, 2));
    throw new Error(`Precheck FAIL — repair abortado: ${JSON.stringify(precheck)}`);
  }

  console.log("[recovery] repair 00122 history...");
  const repair = repairVersion(VERSION);
  if (!repair.ok) throw new Error(`Repair FAIL: ${repair.stderr}`);

  const historyAfter = getMigrationList();
  const schemaAfterFile = path.join(OUT, `_prod_schema_after_00122_repair_${DATE}.sql`);
  dumpSchema(schemaAfterFile);
  const schemaAfterText = fs.readFileSync(schemaAfterFile, "utf8");
  const fpAfter = fingerprintDump(schemaAfterFile);
  const countsAfter = await collectCounts(serviceKey, creds);
  const precheckAfter = precheck00122(creds, schemaAfterText);
  const checkpointAfter = probeCheckpoint(creds);

  fs.writeFileSync(path.join(OUT, `MIGRATION_HISTORY_PROD_AFTER_00122_REPAIR.json`), JSON.stringify({ ...historyAfter }, null, 2));
  fs.writeFileSync(path.join(OUT, `SCHEMA_FINGERPRINT_PROD_AFTER_00122_REPAIR.json`), JSON.stringify({ captured_at: new Date().toISOString(), ...fpAfter }, null, 2));
  fs.writeFileSync(path.join(OUT, `PROD_COUNTS_AFTER_00122_REPAIR.json`), JSON.stringify({ counts: countsAfter }, null, 2));

  const pendingAfter = [...historyAfter.pending].sort();
  const AUTHORIZED_CHECKPOINT = ["20260301000118", "20260301000119", "20260301000120", "20260301000121", VERSION];
  const schemaIdentical = fpBefore?.fingerprint === fpAfter?.fingerprint;
  const countsIdenticalFlag = countsIdentical(countsBefore, countsAfter);
  const indexIdentical = precheck.index_definition === precheckAfter.index_definition;
  const checkpointApplied = AUTHORIZED_CHECKPOINT.every((v) => historyAfter.remoteApplied.includes(v));

  const success =
    repair.ok &&
    historyAfter.remoteApplied.includes(VERSION) &&
    pendingAfter.length === 6 &&
    JSON.stringify(pendingAfter) === JSON.stringify([...EXPECTED_PENDING].sort()) &&
    schemaIdentical &&
    countsIdenticalFlag &&
    indexIdentical &&
    checkpointApplied;

  const report = {
    pass: success,
    status: success ? "BATCH 4 RECOVERY CONCLUÍDO COM SUCESSO" : "BATCH 4 RECOVERY BLOQUEADO",
    captured_at: new Date().toISOString(),
    project,
    precheck,
    repair: { version: VERSION, ...repair },
    history: { before: historyBefore.pending.length, after: historyAfter.pending.length },
    pending_after: pendingAfter,
    schema_fingerprint: { before: fpBefore, after: fpAfter, identical: schemaIdentical },
    index_definition: { before: precheck.index_definition, after: precheckAfter.index_definition, identical: indexIdentical },
    counts: { before: countsBefore, after: countsAfter, identical: countsIdenticalFlag },
    checkpoint: {
      "20260301000118": historyAfter.remoteApplied.includes("20260301000118") ? "APPLIED" : "PENDING",
      "20260301000119": historyAfter.remoteApplied.includes("20260301000119") ? "APPLIED" : "PENDING",
      "20260301000120": historyAfter.remoteApplied.includes("20260301000120") ? "APPLIED" : "PENDING",
      "20260301000121": historyAfter.remoteApplied.includes("20260301000121") ? "APPLIED" : "PENDING",
      "20260301000122": historyAfter.remoteApplied.includes(VERSION) ? "APPLIED" : "PENDING",
    },
    checkpoint_objects: { before: checkpointBefore, after: checkpointAfter },
    executor_fix: {
      file: "lib/validar_indice_ml_global_unique.mjs",
      rca: "regex rigido nao aceitava cast ::text em pg_indexes.indexdef",
      correction: "validacao semantica via normalizacao + colunas + predicate",
      tests: "validar_indice_ml_global_unique.test.mjs",
    },
    gates: {
      sql_reexecuted: "NÃO",
      history_repair: repair.ok ? "SIM" : "NÃO",
      schema_write: "NÃO",
      data_write: "NÃO",
      billing: "NÃO TOCADO",
      terms_real: "NÃO",
      signup_real: "NÃO",
      oauth: "NÃO",
      initial_sync: "NÃO",
      deploy: "NÃO",
    },
  };

  const jsonPath = path.join(OUT, `BATCH4_00122_HISTORY_RECOVERY_${DATE}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = `# BATCH 4 RECOVERY 00122 — ${DATE}

## A. STATUS: ${report.status}

## B. PRECHECK
- index_exists: ${precheck.index_exists}
- unique: ${precheck.unique}
- columns: ${precheck.columns?.join(", ")}
- predicate_ok: ${precheck.predicate_ok}
- duplicates: ${precheck.duplicate_active_pairs}

## C. REPAIR
- version: ${VERSION}
- ok: ${repair.ok}

## D. HISTORY
${historyBefore.pending.length} → ${historyAfter.pending.length}

## E. PENDING
${pendingAfter.map((v) => `- ${v}`).join("\n")}

## F. SCHEMA
Before: ${fpBefore?.fingerprint}
After: ${fpAfter?.fingerprint}
Identical: ${schemaIdentical}

## G. COUNTS
Identical: ${countsIdenticalFlag}

## H. CHECKPOINT 118–122
${Object.entries(report.checkpoint).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

## I. LEGAL
EXISTS rows=${checkpointAfter.legal_rows}

## J. BILLING: NÃO TOCADO

## K. EXECUTOR FIX
${report.executor_fix.file}
`;
  fs.writeFileSync(path.join(OUT, `BATCH4_00122_HISTORY_RECOVERY_${DATE}.md`), md);

  console.log("[recovery] relink DEV...");
  relinkDev();

  console.log(JSON.stringify({ pass: report.pass, status: report.status, pendingAfter: pendingAfter.length, jsonPath }, null, 2));
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  try {
    relinkDev();
  } catch {
    /* ignore */
  }
  console.error(JSON.stringify({ pass: false, error: String(err.message || err) }));
  process.exit(1);
});
