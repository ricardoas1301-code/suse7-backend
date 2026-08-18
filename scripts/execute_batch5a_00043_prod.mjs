#!/usr/bin/env node
/**
 * BATCH 5A — 00043 forward-fix mínimo (processed index) + repair history
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
const VERSION = "20260301000043";
const FIX_SQL = path.join(OUT, "_batch5a_forward_fix_00043_processed_idx.sql");
const EXPECTED_PENDING_AFTER = ["20260301000112", "20260301000113", "20260301000114", "20260301000115", "20260301000116"];

let prodDbPasswordMem = null;

function sha256(t) {
  return crypto.createHash("sha256").update(t).digest("hex");
}
function redact(t) {
  return String(t || "")
    .replace(/PGPASSWORD="[^"]+"/g, "PGPASSWORD=[REDACTED]")
    .replace(/PGPASSWORD=[^\s]+/g, "PGPASSWORD=[REDACTED]");
}
function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: WORKSPACE, encoding: "utf8", stdio: opts.stdio || ["ignore", "pipe", "pipe"], timeout: opts.timeout || 300000 });
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
  if (!prodDbPasswordMem) throw new Error("Senha postgres PROD ausente — use run_batch5a_interactive.ps1");
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
  return spawnSync("docker", psqlSpawnArgs(creds, ["-t", "-A", "-c", sql]), { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
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
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, input: fs.readFileSync(filePath, "utf8") },
  );
}
async function ensurePostgresCreds(creds) {
  const ddlProbe = psqlExec(creds, "CREATE OR REPLACE FUNCTION public.__s7_batch5a_ddl_probe() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;");
  if (ddlProbe.status !== 0) {
    if (!resolveProdPassword()) promptPassword();
    return {
      host: `db.${PROD_REF}.supabase.co`,
      port: "5432",
      user: "postgres",
      password: resolveProdPassword(),
      database: "postgres",
      role: "postgres",
    };
  }
  psqlExec(creds, "DROP FUNCTION IF EXISTS public.__s7_batch5a_ddl_probe();");
  return creds;
}
function parseHistory() {
  const raw = run("supabase migration list --linked");
  const pending = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\d+)\s*\|\s*(\d*)\s*\|/);
    if (m && m[1] && !m[2]?.trim()) pending.push(m[1]);
  }
  return pending;
}
function repair(v) {
  const r = spawnSync(`supabase migration repair --status applied --linked --yes ${v}`, { shell: true, cwd: WORKSPACE, encoding: "utf8" });
  return { ok: r.status === 0, stderr: redact(r.stderr) };
}
function indexInDump(text, name) {
  return new RegExp(`CREATE (?:UNIQUE )?INDEX[^;]*"${name}"`, "i").test(text) || new RegExp(`CREATE INDEX IF NOT EXISTS ${name}`, "i").test(text);
}
function indexFromPg(creds) {
  const r = psqlExec(
    creds,
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='billing_webhook_events_processed_idx';`,
  );
  const line = (r.stdout || "").trim();
  if (!line) return { exists: false, definition: null };
  const parts = line.split("|");
  return { exists: true, indexname: parts[0], definition: parts.slice(1).join("|") };
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
  const indexes = [...t.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "?([^"\s]+)"?/g)].map((m) => m[1]).sort();
  return { fingerprint: sha256([...tables, ...indexes].join("|")), counts: { tables: tables.length, indexes: indexes.length } };
}
function writeBlockedReport(reason, extra = {}) {
  const report = {
    pass: false,
    status: "BATCH 5A — BLOQUEADA",
    blocked_reason: reason,
    ...extra,
  };
  fs.writeFileSync(path.join(OUT, `BATCH5A_00043_EXECUTION_${DATE}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(OUT, `BATCH5A_00043_EXECUTION_${DATE}.md`),
    `# BATCH 5A — 00043\n\nStatus: **BLOQUEADA**\n\nMotivo: ${reason}\n\nUse \`run_batch5a_interactive.ps1\` com senha postgres PROD.\n`,
  );
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(FIX_SQL)) throw new Error(`Forward-fix SQL ausente: ${FIX_SQL}`);

  linkProd();
  const projects = JSON.parse(run("supabase projects list -o json"));
  const proj = projects.find((p) => p.ref === PROD_REF);
  if (!proj || !/prod/i.test(proj.name || "")) throw new Error("Confirmacao PROD falhou");

  const backups = JSON.parse(run(`supabase backups list --project-ref ${PROD_REF} -o json`));
  if (!(backups.backups || backups).some((b) => b.status === "COMPLETED")) throw new Error("Backup indisponivel");

  const pendingBefore = parseHistory();
  if (pendingBefore.length !== 6 || !pendingBefore.includes(VERSION)) {
    throw new Error(`Pending esperado=6 com ${VERSION}, got ${pendingBefore.length}: ${pendingBefore.join(", ")}`);
  }

  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_batch5a_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaBeforeFile.replace(/\\/g, "/")}"`, { timeout: 600000 });
  const schemaBeforeText = fs.readFileSync(schemaBeforeFile, "utf8");
  const fpBefore = fpDump(schemaBeforeFile);

  if (indexInDump(schemaBeforeText, "billing_webhook_events_processed_idx")) {
    throw new Error("Precheck FAIL — indice ja existe no dump");
  }
  if (!schemaBeforeText.includes("billing_webhook_events")) throw new Error("Tabela billing_webhook_events ausente");

  const serviceKey = JSON.parse(run(`supabase projects api-keys --project-ref ${PROD_REF} -o json`)).find((k) => /service_role/i.test(k.name))?.api_key;
  const billingBefore = {
    plans: await restCount(serviceKey, "plans"),
    billing_plan_limits: await restCount(serviceKey, "billing_plan_limits"),
    billing_subscriptions: await restCount(serviceKey, "billing_subscriptions"),
    billing_webhook_events: await restCount(serviceKey, "billing_webhook_events"),
  };
  const sellerBefore = {
    profiles: await restCount(serviceKey, "profiles"),
    legal_document_acceptances: await restCount(serviceKey, "legal_document_acceptances"),
  };

  let creds;
  try {
    creds = getCreds();
  } catch {
    promptPassword();
    creds = getCreds();
  }
  creds = await ensurePostgresCreds(creds);

  const ddl = psqlFile(creds, FIX_SQL);
  if (ddl.status !== 0) {
    const err = redact((ddl.stderr || ddl.stdout || "").slice(0, 400));
    writeBlockedReport(`Forward-fix DDL falhou (${creds.role}): ${err}`, {
      precheck: { pending: pendingBefore.length, index_missing: true, backup: true },
      forward_fix: { file: path.basename(FIX_SQL), ddl_status: ddl.status, role: creds.role },
      billing_counts: { before: billingBefore },
      seller_counts: { before: sellerBefore },
    });
    throw new Error(`Forward-fix FAIL: ${err}`);
  }

  const pgIndex = indexFromPg(creds);
  const schemaMidFile = path.join(OUT, `_prod_schema_mid_batch5a_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaMidFile.replace(/\\/g, "/")}"`, { timeout: 600000 });
  const schemaMidText = fs.readFileSync(schemaMidFile, "utf8");
  const postcheck = {
    index_exists_pg: pgIndex.exists,
    index_exists_dump: indexInDump(schemaMidText, "billing_webhook_events_processed_idx"),
    index_definition: pgIndex.definition || (schemaMidText.match(/CREATE INDEX[^;]*billing_webhook_events_processed_idx[^;]*;/i)?.[0] || "").replace(/\s+/g, " ").trim(),
    on_processed_column: /processed/i.test(pgIndex.definition || ""),
  };

  if (!postcheck.index_exists_pg || !postcheck.on_processed_column) {
    writeBlockedReport(`Postcheck FAIL — indice nao confirmado: ${JSON.stringify(postcheck)}`, {
      precheck: { pending: pendingBefore.length, backup: true },
      forward_fix: { file: path.basename(FIX_SQL), ddl_status: ddl.status, role: creds.role },
      postcheck,
      billing_counts: { before: billingBefore },
    });
    throw new Error(`Postcheck FAIL: ${JSON.stringify(postcheck)}`);
  }

  const repairResult = repair(VERSION);
  if (!repairResult.ok) throw new Error(`Repair FAIL: ${repairResult.stderr}`);

  const pendingAfter = parseHistory();
  const billingAfter = {
    plans: await restCount(serviceKey, "plans"),
    billing_plan_limits: await restCount(serviceKey, "billing_plan_limits"),
    billing_subscriptions: await restCount(serviceKey, "billing_subscriptions"),
    billing_webhook_events: await restCount(serviceKey, "billing_webhook_events"),
  };
  const sellerAfter = {
    profiles: await restCount(serviceKey, "profiles"),
    legal_document_acceptances: await restCount(serviceKey, "legal_document_acceptances"),
  };
  const fpAfter = fpDump(schemaMidFile);

  const success =
    repairResult.ok &&
    pendingAfter.length === 5 &&
    JSON.stringify(pendingAfter.sort()) === JSON.stringify([...EXPECTED_PENDING_AFTER].sort()) &&
    billingBefore.plans.count === billingAfter.plans.count &&
    billingBefore.billing_plan_limits.count === billingAfter.billing_plan_limits.count &&
    billingBefore.billing_subscriptions.count === billingAfter.billing_subscriptions.count &&
    JSON.stringify(sellerBefore) === JSON.stringify(sellerAfter);

  const report = {
    pass: success,
    status: success ? "BATCH 5A — 00043 CONCLUÍDA COM SUCESSO" : "BATCH 5A — BLOQUEADA",
    project: { ref: PROD_REF, name: proj.name },
    precheck: { pending: pendingBefore.length, index_missing: true, backup: true, schema_fingerprint: fpBefore },
    forward_fix: { file: path.basename(FIX_SQL), ddl_status: ddl.status, role: creds.role },
    postcheck,
    repair: { version: VERSION, ...repairResult },
    history: { before: pendingBefore.length, after: pendingAfter.length, pending_before: pendingBefore, pending_after: pendingAfter },
    schema_fingerprint: { before: fpBefore, after: fpAfter, delta_indexes: fpAfter.counts.indexes - fpBefore.counts.indexes },
    billing_counts: { before: billingBefore, after: billingAfter },
    seller_counts: { before: sellerBefore, after: sellerAfter },
    invariants: {
      plans: billingAfter.plans.count,
      billing_plan_limits: billingAfter.billing_plan_limits.count,
      billing_subscriptions: billingAfter.billing_subscriptions.count,
    },
  };

  fs.writeFileSync(path.join(OUT, `BATCH5A_00043_EXECUTION_${DATE}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(OUT, `BATCH5A_00043_EXECUTION_${DATE}.md`),
    `# BATCH 5A — 00043\n\nStatus: **${success ? "CONCLUÍDA" : "BLOQUEADA"}**\n\nPending: ${pendingBefore.length} → ${pendingAfter.length}\n\n## Invariantes\n- plans: ${billingBefore.plans.count} → ${billingAfter.plans.count}\n- billing_plan_limits: ${billingBefore.billing_plan_limits.count} → ${billingAfter.billing_plan_limits.count}\n- billing_subscriptions: ${billingBefore.billing_subscriptions.count} → ${billingAfter.billing_subscriptions.count}\n`,
  );

  relinkDev();
  prodDbPasswordMem = null;
  delete process.env.PROD_DB_PASSWORD;
  delete process.env.SUSE7_PROD_DB_PASSWORD;
  console.log(JSON.stringify({ pass: report.pass, status: report.status, pendingAfter: pendingAfter.length }, null, 2));
  process.exit(success ? 0 : 1);
}

main().catch((e) => {
  try {
    relinkDev();
  } catch {}
  prodDbPasswordMem = null;
  delete process.env.PROD_DB_PASSWORD;
  delete process.env.SUSE7_PROD_DB_PASSWORD;
  console.error(JSON.stringify({ pass: false, error: String(e.message || e) }));
  process.exit(1);
});
