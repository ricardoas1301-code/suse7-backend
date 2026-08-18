#!/usr/bin/env node
/**
 * BATCH 1 PROD — REPAIR_HISTORY controlado (somente 34 versões do manifest).
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
const MANIFEST = path.join(OUT, `MIGRATION_EXECUTION_MANIFEST_${DATE}.json`);
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const PROD_REF = "bazibzquasbdgjwdcwbz";
const PROD_NAME = "Suse7-prod";
const GROUP_SIZE = 7;

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
  const linked = run("supabase projects list").includes(PROD_REF);
  if (!linked) throw new Error("CLI não confirmou link PROD");
}

function parseMigrationList(raw) {
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*\|\s*(\d*)\s*\|\s*(.*)$/);
    if (!m) continue;
    rows.push({
      local: m[1],
      remote: m[2]?.trim() ? m[2].trim() : null,
      name: m[3]?.trim() || null,
    });
  }
  const remoteApplied = rows.filter((r) => r.remote).map((r) => r.remote);
  const pending = rows.filter((r) => r.local && !r.remote).map((r) => r.local);
  return { rows, remoteApplied, pending, lastRemote: remoteApplied.sort().at(-1) || null };
}

function getMigrationList() {
  const raw = run("supabase migration list --linked");
  return parseMigrationList(raw);
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
  if (!m) {
    return { table, count: null, missing: false, status: res.status, error: body?.message || "no_count" };
  }
  return { table, count: Number(m[1]), missing: false, status: res.status };
}

async function probeLegal(serviceKey) {
  const r = await tableCount(serviceKey, "legal_document_acceptances");
  return { exists: !r.missing, count: r.count, status: r.status };
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
    "marketplace_account_sync_jobs",
    "legal_document_acceptances",
  ];
  const counts = {};
  for (const table of tables) {
    counts[table] = await tableCount(serviceKey, table);
  }
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
  const cmd = `supabase migration repair --status applied --linked --yes ${args}`;
  const r = spawnSync(cmd, {
    shell: true,
    cwd: WORKSPACE,
    encoding: "utf8",
    timeout: 180000,
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    status: r.status,
  };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildRepairTable(manifestRows, results) {
  return manifestRows.map((m) => {
    const hit = results.find((r) => r.versions.includes(m.version));
    const ok = Boolean(hit?.gate?.all_repaired);
    return {
      version: m.version,
      name: m.name,
      category: m.category,
      repair: ok,
      resultado: ok ? "APPLIED_REPAIR" : hit ? "FAIL" : "NOT_RUN",
      evidence: {
        action: m.action,
        current_classification: m.current_classification,
        objects_prod: m.objects_prod,
      },
    };
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(MANIFEST)) throw new Error(`Manifest ausente: ${MANIFEST}`);

  const manifestDoc = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const repairRows = manifestDoc.manifest
    .filter((m) => m.action === "REPAIR_HISTORY")
    .sort((a, b) => a.version.localeCompare(b.version));

  if (repairRows.length !== 34) {
    throw new Error(`Esperado 34 REPAIR_HISTORY, encontrado ${repairRows.length}`);
  }

  const forbidden = new Set([
    "20260301000118",
    "20260301000119",
    "20260301000120",
    "20260301000121",
    "20260301000122",
  ]);
  if (repairRows.some((m) => forbidden.has(m.version))) {
    throw new Error("Manifest contém versão proibida no Batch 1");
  }

  console.log("[batch1] link PROD...");
  linkProd();

  const backups = listBackups();
  const backupList = Array.isArray(backups) ? backups : backups?.backups || [];
  const backupOk = backupList.length > 0 && backupList.some((b) => b.status === "COMPLETED");
  if (!backupOk) {
    throw new Error("Nenhum backup COMPLETED disponível — Batch 1 abortado antes do repair");
  }

  console.log("[batch1] BEFORE snapshots...");
  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_repair_${DATE}.sql`);
  dumpSchema(schemaBeforeFile);
  const fpBefore = fingerprintDump(schemaBeforeFile);

  const serviceKey = getServiceRoleKey();
  const countsBefore = await collectCounts(serviceKey);
  const legalBefore = await probeLegal(serviceKey);
  const historyBefore = getMigrationList();

  fs.writeFileSync(
    path.join(OUT, `MIGRATION_HISTORY_PROD_BEFORE_REPAIR_${DATE}.json`),
    JSON.stringify({ project_ref: PROD_REF, project_name: PROD_NAME, captured_at: new Date().toISOString(), ...historyBefore }, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `SCHEMA_FINGERPRINT_PROD_BEFORE_REPAIR_${DATE}.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...fpBefore }, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `PROD_COUNTS_BEFORE_REPAIR_${DATE}.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), counts: countsBefore, legal: legalBefore }, null, 2),
  );

  for (const m of repairRows) {
    if (m.action !== "REPAIR_HISTORY") throw new Error(`Pré-check falhou: ${m.version} action=${m.action}`);
    if (m.DML) {
      console.warn(`[batch1] WARN ${m.version} tem flag DML no manifest — removendo do batch por segurança`);
    }
  }
  const eligible = repairRows.filter((m) => !m.DML);
  if (eligible.length !== repairRows.length) {
    throw new Error("Pré-check: migration com DML detectada — abortando Batch 1");
  }

  const versions = eligible.map((m) => m.version);
  const groups = chunk(versions, GROUP_SIZE);
  const groupResults = [];
  let aborted = false;
  let abortReason = null;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    console.log(`[batch1] repair grupo ${i + 1}/${groups.length}: ${group.join(", ")}`);
    const repair = repairVersions(group);
    const historyMid = getMigrationList();
    const fpMidFile = path.join(OUT, `_prod_schema_mid_g${i + 1}_${DATE}.sql`);
    dumpSchema(fpMidFile);
    const fpMid = fingerprintDump(fpMidFile);
    const countsMid = await collectCounts(serviceKey);

    const schemaChanged = fpBefore && fpMid && fpBefore.fingerprint !== fpMid.fingerprint;
    const countsChanged = JSON.stringify(countsBefore) !== JSON.stringify(countsMid);
    const unauthorized = group.some((v) => !versions.includes(v));
    const newlyApplied = group.filter((v) => historyMid.remoteApplied.includes(v));
    const allApplied = newlyApplied.length === group.length;

    const gate = {
      schema_unchanged: !schemaChanged,
      counts_unchanged: !countsChanged,
      all_repaired: repair.ok && allApplied,
      no_unauthorized: !unauthorized,
    };

    groupResults.push({
      group: i + 1,
      versions: group,
      repair,
      gate,
      newly_applied: newlyApplied,
      history_pending_count: historyMid.pending.length,
    });

    if (!gate.schema_unchanged || !gate.counts_unchanged || !gate.all_repaired) {
      aborted = true;
      abortReason = !gate.schema_unchanged
        ? "schema_fingerprint_changed"
        : !gate.counts_unchanged
          ? "data_counts_changed"
          : "repair_failed";
      console.error(`[batch1] GATE FAIL grupo ${i + 1}: ${abortReason}`);
      break;
    }
  }

  console.log("[batch1] AFTER snapshots...");
  const schemaAfterFile = path.join(OUT, `_prod_schema_after_repair_${DATE}.sql`);
  dumpSchema(schemaAfterFile);
  const fpAfter = fingerprintDump(schemaAfterFile);
  const countsAfter = await collectCounts(serviceKey);
  const legalAfter = await probeLegal(serviceKey);
  const historyAfter = getMigrationList();

  fs.writeFileSync(
    path.join(OUT, `MIGRATION_HISTORY_PROD_AFTER_REPAIR_${DATE}.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...historyAfter }, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `SCHEMA_FINGERPRINT_PROD_AFTER_REPAIR_${DATE}.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...fpAfter }, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT, `PROD_COUNTS_AFTER_REPAIR_${DATE}.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), counts: countsAfter, legal: legalAfter }, null, 2),
  );

  const repairedCount = historyAfter.remoteApplied.filter((v) => versions.includes(v)).length;
  const expectedRepaired = aborted
    ? groupResults.reduce((n, g) => n + (g.gate.all_repaired ? g.versions.length : 0), 0)
    : 34;

  const success =
    !aborted &&
    repairedCount === 34 &&
    fpBefore?.fingerprint === fpAfter?.fingerprint &&
    JSON.stringify(countsBefore) === JSON.stringify(countsAfter) &&
    legalBefore.exists === legalAfter.exists &&
    legalBefore.exists === false;

  const report = {
    pass: success,
    status: aborted
      ? "BATCH 1 INTERROMPIDO"
      : success
        ? "BATCH 1 REPAIR_HISTORY CONCLUÍDO COM SUCESSO"
        : "BATCH 1 INTERROMPIDO",
    captured_at: new Date().toISOString(),
    environment: {
      project: PROD_NAME,
      project_ref: PROD_REF,
      cli_linked: PROD_REF,
      backup: { count: backupList.length, latest: backupList[0]?.inserted_at || null, status: backupList[0]?.status || null },
      backup_policy: "Supabase managed backups/PITR — ver backups list ou dashboard",
    },
    repair_table: buildRepairTable(repairRows, groupResults),
    groups: groupResults,
    history: {
      before: { last_remote: historyBefore.lastRemote, applied_count: historyBefore.remoteApplied.length, pending_count: historyBefore.pending.length },
      after: { last_remote: historyAfter.lastRemote, applied_count: historyAfter.remoteApplied.length, pending_count: historyAfter.pending.length },
      repaired_count: repairedCount,
      expected: 34,
    },
    schema_fingerprint: {
      before: fpBefore,
      after: fpAfter,
      identical: fpBefore?.fingerprint === fpAfter?.fingerprint,
    },
    data_counts: {
      identical: JSON.stringify(countsBefore) === JSON.stringify(countsAfter),
      before: countsBefore,
      after: countsAfter,
    },
    legal_table: { before: legalBefore, after: legalAfter, expected: "MISSING" },
    abort_reason: abortReason,
    remaining_pending_after_batch1: historyAfter.pending.length,
    gates: {
      repair_history_authorized: "SIM — somente 34",
      migration_sql: "NÃO",
      forward_fix: "NÃO",
      migration_00118_122: "NÃO",
    },
  };

  const jsonPath = path.join(OUT, `BATCH1_REPAIR_HISTORY_EXECUTION_${DATE}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const md = `# BATCH 1 REPAIR_HISTORY — ${DATE}

## Status: ${report.status}

## Ambiente
- Project: **${PROD_NAME}**
- Ref: \`${PROD_REF}\`

## Repaired: ${repairedCount}/34

## Schema fingerprint identical: ${report.schema_fingerprint.identical ? "SIM" : "NÃO"}

## Data counts identical: ${report.data_counts.identical ? "SIM" : "NÃO"}

## Legal table: ${legalAfter.exists ? "EXISTS (unexpected)" : "MISSING (expected)"}

## Remaining pending: ${historyAfter.pending.length}
`;
  fs.writeFileSync(path.join(OUT, `BATCH1_REPAIR_HISTORY_EXECUTION_${DATE}.md`), md);
  fs.writeFileSync(
    path.join(OUT, `MIGRATION_HISTORY_PROD_BEFORE_REPAIR_${DATE}.md`),
    `# Migration history BEFORE\n\nPending: ${historyBefore.pending.length}\nLast remote: ${historyBefore.lastRemote}\n`,
  );
  fs.writeFileSync(
    path.join(OUT, `MIGRATION_HISTORY_PROD_AFTER_REPAIR_${DATE}.md`),
    `# Migration history AFTER\n\nPending: ${historyAfter.pending.length}\nLast remote: ${historyAfter.lastRemote}\nRepaired in batch1: ${repairedCount}\n`,
  );

  console.log("[batch1] relink DEV...");
  run("supabase link --project-ref alkelcaoexxbamqddaqv --yes", { stdio: "ignore" });

  console.log(JSON.stringify({ pass: report.pass, status: report.status, repairedCount, jsonPath }, null, 2));
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  try {
    execSync("supabase link --project-ref alkelcaoexxbamqddaqv --yes", {
      cwd: WORKSPACE,
      stdio: "ignore",
    });
  } catch {
    /* ignore */
  }
  console.error(JSON.stringify({ pass: false, error: String(err.message || err) }));
  process.exit(1);
});
