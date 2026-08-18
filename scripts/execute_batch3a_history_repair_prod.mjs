#!/usr/bin/env node
/**
 * BATCH 3A PROD — REPAIR history das 58 REPAIR_READY + NOOP_CONFIRMED.
 * Altera APENAS migration history remoto. Não executa SQL de migration.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260817";
const CLASSIFICATION = path.join(OUT, `PENDING72_FINAL_CLASSIFICATION_${DATE}.json`);
const PROD_SCHEMA = path.join(OUT, "_prod_schema_after_batch2b1_20260817.sql");
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const PROD_REF = "bazibzquasbdgjwdcwbz";
const DEV_REF = "alkelcaoexxbamqddaqv";
const PROD_NAME = "Suse7-prod";
const GROUP_SIZE = 10;

const FORBIDDEN = new Set([
  "20260301000003",
  "20260301000008",
  "20260301000043",
  "20260301000061",
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
]);

const EXPECTED_REMAINING = [
  "20260301000003",
  "20260301000008",
  "20260301000043",
  "20260301000061",
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

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
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

function parseMigrationList(raw) {
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*\|\s*(\d*)\s*\|\s*(.*)$/);
    if (!m) continue;
    rows.push({ local: m[1], remote: m[2]?.trim() ? m[2].trim() : null, name: m[3]?.trim() || null });
  }
  const remoteApplied = rows.filter((r) => r.remote).map((r) => r.remote);
  const pending = rows.filter((r) => r.local && !r.remote).map((r) => r.local);
  return { rows, remoteApplied, pending, lastRemote: remoteApplied.sort().at(-1) || null };
}

function getMigrationList() {
  return parseMigrationList(run("supabase migration list --linked"));
}

function dumpSchema(outFile) {
  run(`supabase db dump --linked -s public,s7_private -f "${outFile.replace(/\\/g, "/")}"`, { timeout: 600000 });
}

function getServiceRoleKey() {
  const raw = run(`supabase projects api-keys --project-ref ${PROD_REF} -o json`);
  const keys = JSON.parse(raw);
  const service = keys.find((k) => k.name === "service_role" || k.name === "service role");
  if (!service?.api_key) throw new Error("service_role key indisponível via CLI");
  return service.api_key;
}

async function tableCount(serviceKey, table) {
  const res = await fetch(`https://${PROD_REF}.supabase.co/rest/v1/${table}?select=id&limit=0`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "count=exact",
    },
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
  if (!m) return { table, count: null, missing: false, status: res.status, error: body?.message || "no_count" };
  return { table, count: Number(m[1]), missing: false, status: res.status };
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
  for (const table of tables) counts[table] = await tableCount(serviceKey, table);
  return counts;
}

function listBackups() {
  try {
    const raw = run(`supabase backups list --project-ref ${PROD_REF} -o json`, { timeout: 120000 });
    return JSON.parse(raw);
  } catch (err) {
    return { available: false, error: String(err.message || err).slice(0, 200) };
  }
}

function repairVersions(versions) {
  const args = versions.join(" ");
  const r = spawnSync(`supabase migration repair --status applied --linked --yes ${args}`, {
    shell: true,
    cwd: WORKSPACE,
    encoding: "utf8",
    timeout: 180000,
  });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), status: r.status };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parseProdSchema() {
  if (!fs.existsSync(PROD_SCHEMA)) return { raw: "", hasSalesOrderId: false, hasLegal: false };
  const raw = fs.readFileSync(PROD_SCHEMA, "utf8");
  return {
    raw,
    hasSalesOrderId: raw.includes('"sales_order_id"') && raw.includes('"public"."sales_order_items"'),
    hasLegal: raw.includes('"public"."legal_document_acceptances"'),
  };
}

function revalidateCandidate(m, prodSchema) {
  if (m.version === "20260301000002") {
    if (!prodSchema.hasSalesOrderId) {
      return { ok: false, reason: "sales_order_id ausente — NOOP não comprovado", new_class: "RUNTIME_REVIEW_REQUIRED" };
    }
    return {
      ok: true,
      evidence: "sales_order_id presente; DROP condicional não executaria; SKIP+REPAIR seguro",
    };
  }
  if (m.category === "REPAIR_READY") {
    if (m.prod_status === "MISSING" && (m.checks_summary?.missing?.length || 0) > 2) {
      return { ok: false, reason: `prod_status MISSING com ${m.checks_summary.missing.length} gaps`, new_class: "RUNTIME_REVIEW_REQUIRED" };
    }
    return { ok: true, evidence: m.rationale || "schema final presente pós-2B1" };
  }
  if (m.category === "NOOP_CONFIRMED") {
    return { ok: true, evidence: m.rationale || "no-op comprovado" };
  }
  return { ok: false, reason: "categoria não autorizada", new_class: "RUNTIME_REVIEW_REQUIRED" };
}

function buildAuthorizedList(classificationDoc, prodSchema) {
  const candidates = classificationDoc.migrations
    .filter((m) => m.category === "REPAIR_READY" || m.category === "NOOP_CONFIRMED")
    .sort((a, b) => a.version.localeCompare(b.version));

  if (candidates.length !== 58) {
    throw new Error(`Esperado 58 candidatas, encontrado ${candidates.length}`);
  }

  const overlap = candidates.filter((m) => FORBIDDEN.has(m.version));
  if (overlap.length) {
    throw new Error(`Candidatas incluem versões proibidas: ${overlap.map((m) => m.version).join(", ")}`);
  }
  if (candidates.some((m) => m.version === "20260301000027")) {
    throw new Error("00027 já reparada no Batch 2B1 — não deve estar nas 58");
  }

  const removed = [];
  const authorized = [];
  for (const m of candidates) {
    const rev = revalidateCandidate(m, prodSchema);
    if (!rev.ok) {
      removed.push({ version: m.version, name: m.name, reason: rev.reason, new_classification: rev.new_class });
      continue;
    }
    authorized.push({
      version: m.version,
      name: m.name,
      classification: m.category,
      reason: m.rationale,
      evidence: rev.evidence,
      action: m.category === "NOOP_CONFIRMED" ? "SKIP+REPAIR" : "REPAIR",
    });
  }

  return { candidates, authorized, removed };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(CLASSIFICATION)) throw new Error(`Classificação ausente: ${CLASSIFICATION}`);

  const classificationDoc = JSON.parse(fs.readFileSync(CLASSIFICATION, "utf8"));
  const prodSchema = parseProdSchema();
  const { authorized, removed } = buildAuthorizedList(classificationDoc, prodSchema);

  const authorizedPath = path.join(OUT, `BATCH3A_AUTHORIZED_58_${DATE}.json`);
  fs.writeFileSync(
    authorizedPath,
    JSON.stringify(
      {
        captured_at: new Date().toISOString(),
        expected_count: 58,
        authorized_count: authorized.length,
        removed_runtime: removed,
        entries: authorized,
      },
      null,
      2,
    ),
  );

  if (authorized.length !== 58) {
    throw new Error(`Após revalidação runtime: ${authorized.length}/58 autorizadas — abortado antes do repair`);
  }

  console.log("[batch3a] link PROD...");
  linkProd();

  const backups = listBackups();
  const backupList = Array.isArray(backups) ? backups : backups?.backups || [];
  const backupOk = backupList.length > 0 && backupList.some((b) => b.status === "COMPLETED");
  if (!backupOk) throw new Error("Nenhum backup COMPLETED — Batch 3A abortado");

  const operationStartedAt = new Date().toISOString();
  console.log("[batch3a] BEFORE snapshots...");
  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_batch3a_${DATE}.sql`);
  dumpSchema(schemaBeforeFile);
  const fpBefore = fingerprintDump(schemaBeforeFile);

  const serviceKey = getServiceRoleKey();
  const countsBefore = await collectCounts(serviceKey);
  const historyBefore = getMigrationList();

  fs.writeFileSync(
    path.join(OUT, `MIGRATION_HISTORY_PROD_BEFORE_BATCH3A.json`),
    JSON.stringify({ project_ref: PROD_REF, project_name: PROD_NAME, captured_at: operationStartedAt, ...historyBefore }, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `SCHEMA_FINGERPRINT_PROD_BEFORE_BATCH3A.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: operationStartedAt, ...fpBefore }, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `PROD_COUNTS_BEFORE_BATCH3A.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: operationStartedAt, counts: countsBefore }, null, 2),
  );

  const versions = authorized.map((a) => a.version);
  const groups = chunk(versions, GROUP_SIZE);
  const groupResults = [];
  let aborted = false;
  let abortReason = null;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    console.log(`[batch3a] repair grupo ${i + 1}/${groups.length}: ${group.join(", ")}`);
    const repair = repairVersions(group);
    const historyMid = getMigrationList();
    const fpMidFile = path.join(OUT, `_prod_schema_mid_batch3a_g${i + 1}_${DATE}.sql`);
    dumpSchema(fpMidFile);
    const fpMid = fingerprintDump(fpMidFile);
    const countsMid = await collectCounts(serviceKey);

    const schemaChanged = fpBefore && fpMid && fpBefore.fingerprint !== fpMid.fingerprint;
    const countsChanged = JSON.stringify(countsBefore) !== JSON.stringify(countsMid);
    const newlyApplied = group.filter((v) => historyMid.remoteApplied.includes(v));
    const allApplied = newlyApplied.length === group.length;

    const gate = {
      schema_unchanged: !schemaChanged,
      counts_unchanged: !countsChanged,
      all_repaired: repair.ok && allApplied,
    };

    groupResults.push({ group: i + 1, versions: group, repair, gate, newly_applied: newlyApplied, pending_count: historyMid.pending.length });

    if (!gate.schema_unchanged || !gate.counts_unchanged || !gate.all_repaired) {
      aborted = true;
      abortReason = !gate.schema_unchanged ? "schema_fingerprint_changed" : !gate.counts_unchanged ? "data_counts_changed" : "repair_failed";
      console.error(`[batch3a] GATE FAIL grupo ${i + 1}: ${abortReason}`);
      break;
    }
  }

  console.log("[batch3a] AFTER snapshots...");
  const schemaAfterFile = path.join(OUT, `_prod_schema_after_batch3a_${DATE}.sql`);
  dumpSchema(schemaAfterFile);
  const fpAfter = fingerprintDump(schemaAfterFile);
  const countsAfter = await collectCounts(serviceKey);
  const historyAfter = getMigrationList();

  fs.writeFileSync(
    path.join(OUT, `MIGRATION_HISTORY_PROD_AFTER_BATCH3A.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...historyAfter }, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `SCHEMA_FINGERPRINT_PROD_AFTER_BATCH3A.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...fpAfter }, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `PROD_COUNTS_AFTER_BATCH3A.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), counts: countsAfter }, null, 2),
  );

  const repairedCount = versions.filter((v) => historyAfter.remoteApplied.includes(v)).length;
  const pendingAfter = historyAfter.pending;
  const pendingSorted = [...pendingAfter].sort();
  const expectedSorted = [...EXPECTED_REMAINING].sort();
  const pendingMatchesExpected = JSON.stringify(pendingSorted) === JSON.stringify(expectedSorted);

  fs.writeFileSync(
    path.join(OUT, `PENDING_AFTER_BATCH3A_${DATE}.json`),
    JSON.stringify(
      {
        pending_count: pendingAfter.length,
        pending: pendingSorted,
        expected_count: 14,
        expected: expectedSorted,
        matches_expected: pendingMatchesExpected,
        pre_checkpoint: pendingSorted.filter((v) => ["20260301000003", "20260301000008", "20260301000061"].includes(v)),
        billing: pendingSorted.filter((v) => v >= "20260301000043" && v <= "20260301000116" && v !== "20260301000061"),
        checkpoint: pendingSorted.filter((v) => v >= "20260301000118"),
      },
      null,
      2,
    ),
  );

  const repairReadyCount = authorized.filter((a) => a.classification === "REPAIR_READY").length;
  const noopCount = authorized.filter((a) => a.classification === "NOOP_CONFIRMED").length;

  const success =
    !aborted &&
    repairedCount === 58 &&
    fpBefore?.fingerprint === fpAfter?.fingerprint &&
    JSON.stringify(countsBefore) === JSON.stringify(countsAfter) &&
    countsBefore.legal_document_acceptances?.missing === true &&
    countsAfter.legal_document_acceptances?.missing === true &&
    historyBefore.pending.length === 72 &&
    pendingAfter.length === 14;

  const repairTable = authorized.map((a) => {
    const hit = groupResults.find((g) => g.versions.includes(a.version));
    const ok = historyAfter.remoteApplied.includes(a.version);
    return {
      version: a.version,
      name: a.name,
      classification: a.classification,
      repair: ok,
      postcheck: ok ? "APPLIED_REPAIR" : "NOT_APPLIED",
      group: hit?.group || null,
    };
  });

  const report = {
    pass: success,
    status: aborted ? "BATCH 3A INTERROMPIDO" : success ? "BATCH 3A CONCLUÍDO COM SUCESSO" : "BATCH 3A CONCLUÍDO PARCIALMENTE",
    captured_at: new Date().toISOString(),
    operation_started_at: operationStartedAt,
    environment: { project: PROD_NAME, project_ref: PROD_REF, backup_latest: backupList[0]?.inserted_at || null },
    authorized: { repair_ready: repairReadyCount, noop_confirmed: noopCount, total: authorized.length },
    repaired_count: repairedCount,
    removed_runtime: removed,
    repair_table: repairTable,
    groups: groupResults,
    history: {
      before: { pending_count: historyBefore.pending.length, applied_count: historyBefore.remoteApplied.length },
      after: { pending_count: historyAfter.pending.length, applied_count: historyAfter.remoteApplied.length },
    },
    schema_fingerprint: { before: fpBefore, after: fpAfter, identical: fpBefore?.fingerprint === fpAfter?.fingerprint },
    data_counts: { before: countsBefore, after: countsAfter, identical: JSON.stringify(countsBefore) === JSON.stringify(countsAfter) },
    legal: { before: countsBefore.legal_document_acceptances?.missing ? "MISSING" : "PRESENT", after: countsAfter.legal_document_acceptances?.missing ? "MISSING" : "PRESENT" },
    migration_00002: {
      revalidation: "NOOP_CONFIRMED — sales_order_id presente; SQL histórico NÃO executado",
      repair: historyAfter.remoteApplied.includes("20260301000002"),
      sql_executed: false,
    },
    pending_after: { count: pendingAfter.length, list: pendingSorted, matches_expected_14: pendingMatchesExpected },
    abort_reason: abortReason,
    gates: {
      history_repair: "SIM — 58 autorizadas",
      sql_migration: "NÃO",
      schema_write: "NÃO",
      data_write: "NÃO",
      checkpoint_118_122: "NÃO",
      billing: "NÃO",
    },
  };

  const jsonPath = path.join(OUT, `BATCH3A_HISTORY_REPAIR_EXECUTION_${DATE}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = `# BATCH 3A — History Repair ${DATE}

## A. STATUS

**${report.status}**

## B. AUTORIZADAS

| Tipo | Count |
|------|-------|
| REPAIR_READY | ${repairReadyCount} |
| NOOP_CONFIRMED | ${noopCount} |
| **TOTAL** | **${authorized.length}** |

## C. REPARADAS

${repairedCount}/${authorized.length}

## D. REMOVIDAS RUNTIME

${removed.length ? removed.map((r) => `- ${r.version}: ${r.reason}`).join("\n") : "Nenhuma"}

## E. HISTORY

Pending before: **${historyBefore.pending.length}** → after: **${pendingAfter.length}**

## F. SCHEMA

Fingerprint identical: **${report.schema_fingerprint.identical ? "SIM" : "NÃO"}**

## G. COUNTS

Identical: **${report.data_counts.identical ? "SIM" : "NÃO"}**

## H. 00002

Revalidação: NOOP_CONFIRMED · Repair: ${report.migration_00002.repair ? "SIM" : "NÃO"} · SQL: NÃO

## I. LEGAL

${report.legal.before} → ${report.legal.after}

## J. LISTA FINAL PENDING

${pendingSorted.map((v) => `- ${v}`).join("\n")}

## K. CONTAGEM FINAL

${pendingAfter.length} (esperado 14: ${pendingMatchesExpected ? "MATCH" : "DIFF"})

## L. CLASSIFICAÇÃO DAS ${pendingAfter.length}

**Pré-checkpoint:** ${report.pending_after.pre_checkpoint?.join(", ") || "—"}  
**Billing:** 00043, 112–116  
**Checkpoint:** 00118–00122

## M. GATES

History repair: SIM · SQL: NÃO · Schema/Data write: NÃO · 118–122: NÃO
`;
  fs.writeFileSync(path.join(OUT, `BATCH3A_HISTORY_REPAIR_EXECUTION_${DATE}.md`), md);

  console.log("[batch3a] relink DEV...");
  relinkDev();

  console.log(JSON.stringify({ pass: report.pass, status: report.status, repairedCount, pendingAfter: pendingAfter.length, jsonPath }, null, 2));
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
