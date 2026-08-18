#!/usr/bin/env node
/**
 * BATCH 5 PROD — execução controlada billing (gate por migration).
 * Lê plano gerado por audit_batch5_billing_final.mjs.
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
const PLAN_PATH = path.join(OUT, `BATCH5_BILLING_FINAL_PLAN_${DATE}.json`);
const FORWARD_43 = path.join(OUT, "_shadow_forward_fix_20260301000043.sql");

const CHECKPOINT_VERSIONS = ["20260301000118", "20260301000119", "20260301000120", "20260301000121", "20260301000122"];

let prodDbPasswordMem = null;

function redact(t) {
  return String(t || "").replace(/PGPASSWORD="[^"]+"/g, 'PGPASSWORD="[REDACTED]"');
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

function promptPassword() {
  if (prodDbPasswordMem || process.env.PROD_DB_PASSWORD) return;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "$s=Read-Host 'Senha postgres PROD' -AsSecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringAuto($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }"], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  prodDbPasswordMem = (r.stdout || "").trim();
  if (!prodDbPasswordMem) throw new Error("Senha postgres ausente");
}

function getCreds() {
  let raw = "";
  try {
    raw = run("supabase db dump --dry-run --linked -s public 2>&1");
  } catch (e) {
    raw = `${e.stdout || ""}\n${e.stderr || ""}`;
  }
  const host = raw.match(/PGHOST="([^"]+)"/)?.[1];
  const user = raw.match(/PGUSER="([^"]+)"/)?.[1];
  const password = raw.match(/PGPASSWORD="([^"]+)"/)?.[1] || prodDbPasswordMem;
  if (!host || !user || !password) {
    promptPassword();
    return { host: `db.${PROD_REF}.supabase.co`, port: "5432", user: "postgres", password: prodDbPasswordMem, database: "postgres" };
  }
  return { host, port: raw.match(/PGPORT="([^"]+)"/)?.[1] || "5432", user, password, database: "postgres" };
}

function psqlFile(creds, filePath) {
  return spawnSync("docker", ["run", "--rm", "--network", "host", "-i", "-e", `PGPASSWORD=${creds.password}`, "postgres:17", "psql", "-h", creds.host, "-p", creds.port, "-U", creds.user, "-d", creds.database, "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: fs.readFileSync(filePath, "utf8"), encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

function psql(creds, sql) {
  return spawnSync("docker", ["run", "--rm", "--network", "host", "-e", `PGPASSWORD=${creds.password}`, "postgres:17", "psql", "-h", creds.host, "-p", creds.port, "-U", creds.user, "-d", creds.database, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" });
}

function repair(v) {
  const r = spawnSync(`supabase migration repair --status applied --linked --yes ${v}`, { shell: true, cwd: WORKSPACE, encoding: "utf8" });
  return { ok: r.status === 0, stderr: redact(r.stderr) };
}

function parseHistory() {
  const raw = run("supabase migration list --linked");
  const pending = [];
  const applied = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(\d+)\s*\|\s*(\d*)\s*\|/);
    if (!m) continue;
    if (m[2]?.trim()) applied.push(m[1]);
    else pending.push(m[1]);
  }
  return { pending, applied };
}

async function restCounts(serviceKey, tables) {
  const out = {};
  for (const t of tables) {
    const res = await fetch(`https://${PROD_REF}.supabase.co/rest/v1/${t}?select=id&limit=0`, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: "count=exact" } });
    const range = res.headers.get("content-range") || "";
    const m = range.match(/\/(\d+)$/);
    out[t] = { count: res.status === 404 ? null : m ? Number(m[1]) : null, missing: res.status === 404 };
  }
  return out;
}

function fingerprintFromDump(file) {
  const t = fs.readFileSync(file, "utf8");
  const tables = [...t.matchAll(/CREATE TABLE IF NOT EXISTS "([^"]+)"/g)].map((m) => m[1]).sort();
  const indexes = [...t.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "([^"]+)"/g)].map((m) => m[1]).sort();
  return { fingerprint: crypto.createHash("sha256").update([...tables, ...indexes].join("|")).digest("hex"), counts: { tables: tables.length, indexes: indexes.length } };
}

async function main() {
  if (!fs.existsSync(PLAN_PATH)) throw new Error("Plano Batch5 ausente — rode audit_batch5_billing_final.mjs primeiro");
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
  linkProd();

  const backups = JSON.parse(run(`supabase backups list --project-ref ${PROD_REF} -o json`));
  if (!(backups.backups || backups).some((b) => b.status === "COMPLETED")) throw new Error("Backup indisponivel");

  if (!plan.shadow?.tests?.find((t) => t.version === "20260301000043")?.pass) throw new Error("00043 shadow FAIL — abortado");

  const historyBefore = parseHistory();
  if (historyBefore.pending.length !== 6) throw new Error(`Expected pending=6, got ${historyBefore.pending.length}`);

  const schemaBefore = path.join(OUT, `_prod_schema_before_batch5_exec_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaBefore.replace(/\\/g, "/")}"`, { timeout: 600000 });
  const fpBefore = fingerprintFromDump(schemaBefore);
  const serviceKey = JSON.parse(run(`supabase projects api-keys --project-ref ${PROD_REF} -o json`)).find((k) => /service_role/i.test(k.name))?.api_key;
  const billingBefore = await restCounts(serviceKey, Object.keys(plan.billing_counts || {}));
  const sellerBefore = await restCounts(serviceKey, Object.keys(plan.seller_counts || {}));

  const results = [];
  let status = "BATCH 5 BILLING PARCIAL";
  let blockedAt = null;

  // --- 00043 ---
  const creds = getCreds();
  const ddlProbe = psql(creds, "SELECT 1");
  if (ddlProbe.status !== 0) {
    promptPassword();
    creds.password = prodDbPasswordMem;
    creds.user = "postgres";
    creds.host = `db.${PROD_REF}.supabase.co`;
  }

  console.log("[batch5] FORWARD-FIX 00043...");
  const r43 = psqlFile(creds, FORWARD_43);
  const idxAfter = psql(creds, "SELECT indexdef FROM pg_indexes WHERE indexname='billing_webhook_events_processed_idx';");
  const post43 = { ok: r43.status === 0, index_processed: (idxAfter.stdout || "").includes("processed") };
  let repair43 = { ok: false };
  if (post43.ok && post43.index_processed) repair43 = repair("20260301000043");
  results.push({ version: "20260301000043", mode: "FORWARD_FIX", postcheck: post43, repair: repair43 });

  // --- 112 BLOCK ---
  const shadow112 = plan.shadow?.tests?.find((t) => t.version === "20260301000112");
  blockedAt = {
    version: "20260301000112",
    reason: "SHADOW_FAIL_LEGACY_ADMISSION_V1",
    detail: shadow112?.stderr?.slice(0, 400) || "112 falhou no shadow — tabela legacy impede CREATE TABLE IF NOT EXISTS + COMMENT em colunas novas",
    action: "MANUAL_BLOCK",
    note: "Requer forward-fix dedicado v1→v2 antes de SQL histórico 112",
  };
  results.push({ version: "20260301000112", skipped: true, block: blockedAt });
  for (const v of ["20260301000113", "20260301000114", "20260301000115", "20260301000116"]) {
    results.push({ version: v, skipped: true, block: { reason: "DEPENDS_ON_112_OR_CHAIN", action: "MANUAL_BLOCK" } });
  }

  const schemaAfter = path.join(OUT, `_prod_schema_after_batch5_exec_${DATE}.sql`);
  run(`supabase db dump --linked -s public,s7_private -f "${schemaAfter.replace(/\\/g, "/")}"`, { timeout: 600000 });
  const fpAfter = fingerprintFromDump(schemaAfter);
  const historyAfter = parseHistory();
  const billingAfter = await restCounts(serviceKey, Object.keys(plan.billing_counts || {}));
  const sellerAfter = await restCounts(serviceKey, Object.keys(plan.seller_counts || {}));

  const plansPreserved = billingBefore.plans?.count === billingAfter.plans?.count && billingBefore.billing_plan_limits?.count === billingAfter.billing_plan_limits?.count;
  const sellerInvariant = JSON.stringify(sellerBefore) === JSON.stringify(sellerAfter);
  const checkpointOk = CHECKPOINT_VERSIONS.every((v) => historyAfter.applied.includes(v));

  const pass43 = repair43.ok && post43.ok;
  const report = {
    pass: pass43 && blockedAt !== null,
    status: pass43 ? "BATCH 5 BILLING PARCIAL" : "BATCH 5 BILLING BLOQUEADO",
    captured_at: new Date().toISOString(),
    results,
    blocked_at: blockedAt,
    history: { before: historyBefore.pending.length, after: historyAfter.pending.length },
    pending_after: historyAfter.pending,
    schema: { before: fpBefore, after: fpAfter, delta_indexes: fpAfter.counts.indexes - fpBefore.counts.indexes },
    billing_counts: { before: billingBefore, after: billingAfter, plans_preserved: plansPreserved },
    seller_counts: { before: sellerBefore, after: sellerAfter, invariant: sellerInvariant },
    checkpoint_intact: checkpointOk,
    gates: { cobranca_real: "NÃO", asaas_real: "NÃO", deploy: "NÃO", commit: "NÃO" },
  };

  fs.writeFileSync(path.join(OUT, `BATCH5_BILLING_FINAL_EXECUTION_${DATE}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, `SCHEMA_FINGERPRINT_PROD_AFTER_BATCH5.json`), JSON.stringify(fpAfter, null, 2));
  fs.writeFileSync(path.join(OUT, `PROD_COUNTS_AFTER_BATCH5.json`), JSON.stringify({ billing: billingAfter, seller: sellerAfter }, null, 2));
  fs.writeFileSync(path.join(OUT, `MIGRATION_HISTORY_PROD_AFTER_BATCH5.json`), JSON.stringify(historyAfter, null, 2));
  fs.writeFileSync(path.join(OUT, `PENDING_AFTER_BATCH5_${DATE}.json`), JSON.stringify({ pending_count: historyAfter.pending.length, pending: historyAfter.pending }, null, 2));

  const md = `# BATCH 5 BILLING — ${DATE}\n\n## STATUS: ${report.status}\n\n00043: ${pass43 ? "PASS" : "FAIL"}\n112-116: BLOQUEADAS (shadow 112 FAIL)\n\nPending: ${historyBefore.pending.length} → ${historyAfter.pending.length}\n`;
  fs.writeFileSync(path.join(OUT, `BATCH5_BILLING_FINAL_EXECUTION_${DATE}.md`), md);

  relinkDev();
  prodDbPasswordMem = null;
  delete process.env.PROD_DB_PASSWORD;

  console.log(JSON.stringify({ status: report.status, pendingAfter: historyAfter.pending.length, pass43 }, null, 2));
  process.exit(pass43 ? 0 : 1);
}

main().catch((e) => {
  try {
    relinkDev();
  } catch {}
  console.error(JSON.stringify({ pass: false, error: String(e.message || e) }));
  process.exit(1);
});
