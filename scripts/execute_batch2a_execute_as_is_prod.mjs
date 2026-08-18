#!/usr/bin/env node
/**
 * BATCH 2A PROD — EXECUTE_AS_IS seguras (manifest SSOT).
 * Executa SQL histórico + repair history. Não inclui 00118–00122, billing 112–116, FORWARD_FIX.
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
const MIGRATIONS_DIR = path.join(WORKSPACE, "supabase", "migrations");
const PROD_REF = "bazibzquasbdgjwdcwbz";
const PROD_NAME = "Suse7-prod";
const DEV_REF = "alkelcaoexxbamqddaqv";

const BLOCKED = new Set([
  "20260301000118",
  "20260301000119",
  "20260301000120",
  "20260301000121",
  "20260301000122",
  "20260301000112",
  "20260301000113",
  "20260301000114",
  "20260301000115",
  "20260301000116",
]);

const FORWARD_FIX_VERSIONS = [
  "20260301000004",
  "20260301000005",
  "20260301000009",
  "20260301000027",
  "20260301000043",
];

const GROUP_SIZE = 3;

/** Senha postgres PROD — somente memória; nunca persistir/logar. */
let prodDbPasswordMem = null;

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/PGPASSWORD="[^"]+"/g, 'PGPASSWORD="[REDACTED]"')
    .replace(/PGPASSWORD=[^\s]+/g, "PGPASSWORD=[REDACTED]")
    .replace(/postgresql:\/\/[^@\s]+@/g, "postgresql://[REDACTED]@");
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
  if (r.status !== 0 || !pass) {
    throw new Error("Senha postgres PROD nao informada — Batch 2A abortado");
  }
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
  if (!host || !user || !password) {
    throw new Error(`Falha ao obter credenciais efêmeras CLI: ${redactSecrets(raw.slice(0, 400))}`);
  }
  return { host, port, user, password, database, role: user };
}

function getDbCreds() {
  const dbPassword = resolveProdPassword();
  if (!dbPassword) {
    throw new Error("Credencial postgres PROD ausente — solicite interativamente e reexecute");
  }
  return {
    host: `db.${PROD_REF}.supabase.co`,
    port: "5432",
    user: "postgres",
    password: dbPassword,
    database: "postgres",
    role: "postgres",
  };
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
  return spawnSync("docker", psqlSpawnArgs(creds, ["-t", "-A", "-c", sql]), {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
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
    {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      input: fs.readFileSync(filePath, "utf8"),
    },
  );
}

function isMigration00002NoOp(schemaDumpText) {
  return (
    schemaDumpText.includes('CREATE TABLE IF NOT EXISTS "public"."sales_order_items"') &&
    /"sales_order_id"\s+"uuid"/.test(schemaDumpText)
  );
}

function confirmLinkedProd() {
  const raw = run("supabase projects list 2>&1");
  if (!raw.includes(PROD_REF)) throw new Error(`Project ref ${PROD_REF} nao encontrado na conta CLI`);
  const linked = raw.split(/\r?\n/).find((l) => l.includes("●") && l.includes(PROD_REF));
  if (!linked) throw new Error(`CLI nao linkado a ${PROD_REF} apos linkProd()`);
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
  return {
    ok: r.status === 0,
    stdout: redactSecrets((r.stdout || "").trim()),
    stderr: redactSecrets((r.stderr || "").trim()),
  };
}

async function getServiceRoleKey() {
  const raw = run(`supabase projects api-keys --project-ref ${PROD_REF} -o json`);
  const keys = JSON.parse(raw);
  return keys.find((k) => /service_role/i.test(k.name))?.api_key;
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
  return { table, count: m ? Number(m[1]) : null, missing: false, status: res.status };
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
  for (const t of tables) counts[t] = await tableCount(serviceKey, t);
  const creds = getDbCreds();
  const auth = psqlExec(creds, "SELECT count(*)::int FROM auth.users;");
  counts.auth_users = {
    table: "auth.users",
    count: parseInt((auth.stdout || "").trim() || "0", 10),
    missing: false,
    status: auth.status,
  };
  return counts;
}

function listBackups() {
  const raw = run(`supabase backups list --project-ref ${PROD_REF} -o json`, { timeout: 120000 });
  const parsed = JSON.parse(raw);
  return parsed.backups || parsed;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function verifyObjects(creds, entry) {
  const checks = [];
  for (const tbl of entry.objects_expected?.tables || []) {
    const short = tbl.split(".").pop();
    const r = psqlExec(
      creds,
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='${short}');`,
    );
    checks.push({ kind: "table", name: tbl, present: (r.stdout || "").trim() === "t" });
  }
  for (const idx of entry.objects_expected?.indexes || []) {
    const r = psqlExec(
      creds,
      `SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='${idx}');`,
    );
    checks.push({ kind: "index", name: idx, present: (r.stdout || "").trim() === "t" });
  }
  for (const fn of entry.objects_expected?.functions || []) {
    const short = fn.split(".").pop();
    const r = psqlExec(
      creds,
      `SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${short}');`,
    );
    checks.push({ kind: "function", name: fn, present: (r.stdout || "").trim() === "t" });
  }
  for (const col of entry.objects_expected?.columns || []) {
    const r = psqlExec(
      creds,
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND column_name='${col}');`,
    );
    checks.push({ kind: "column", name: col, present: (r.stdout || "").trim() === "t" });
  }
  return checks;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifestDoc = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

  const allExec = manifestDoc.manifest
    .filter((m) => m.action === "EXECUTE_AS_IS")
    .sort((a, b) => a.version.localeCompare(b.version));

  const authorized = allExec.filter((m) => !BLOCKED.has(m.version));
  const blockedCheckpoint = allExec.filter((m) =>
    ["20260301000118", "20260301000119", "20260301000120", "20260301000121", "20260301000122"].includes(m.version),
  );

  const plan = {
    captured_at: new Date().toISOString(),
    authorized_batch_2a: authorized.map((m) => ({
      version: m.version,
      name: m.name,
      file: m.file || `${m.version}_${m.name}.sql`,
      category: m.category,
      risk: m.risk,
      shadow: m.shadow_status,
      batch: "2A",
      dml: m.DML,
    })),
    blocked_checkpoint: blockedCheckpoint.map((m) => ({ version: m.version, name: m.name, batch: "BLOCKED_118_122" })),
    blocked_billing: ["20260301000112", "20260301000113", "20260301000114", "20260301000115", "20260301000116"],
    forward_fix_deferred: FORWARD_FIX_VERSIONS,
  };

  fs.writeFileSync(path.join(OUT, `BATCH2A_EXECUTE_AS_IS_PLAN_${DATE}.json`), JSON.stringify(plan, null, 2));

  if (authorized.length === 0) throw new Error("Nenhuma migration autorizada para Batch 2A");
  if (authorized.some((m) => m.DML)) {
    throw new Error("Migration com DML detectada no Batch 2A — abortado");
  }

  linkProd();
  confirmLinkedProd();
  promptProdPasswordInteractive();

  const backups = listBackups();
  if (!backups.length || !backups.some((b) => b.status === "COMPLETED")) {
    throw new Error("Backup COMPLETED indisponível — Batch 2A bloqueado");
  }

  const credProbe = getDbCreds();
  const authProbe = psqlExec(credProbe, "SELECT 1;");
  const postgresAuthPass = authProbe.status === 0 && (authProbe.stdout || "").trim() === "1";
  if (!postgresAuthPass) {
    throw new Error("Postgres authentication FAIL — Batch 2A abortado");
  }

  const ddlProbe = psqlExec(
    credProbe,
    "CREATE OR REPLACE FUNCTION public.__s7_batch2a_ddl_probe() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;",
  );
  const ddlProbePass = ddlProbe.status === 0;
  if (!ddlProbePass) {
    const probeErr = redactSecrets((ddlProbe.stderr || ddlProbe.stdout || "").slice(0, 300));
    throw new Error(`DDL probe FAIL — Batch 2A abortado (${probeErr})`);
  }
  psqlExec(credProbe, "DROP FUNCTION IF EXISTS public.__s7_batch2a_ddl_probe();");

  const schemaBeforeFile = path.join(OUT, `_prod_schema_before_batch2a_${DATE}.sql`);
  dumpSchema(schemaBeforeFile);
  const fpBefore = fingerprintDump(schemaBeforeFile);
  fs.writeFileSync(
    path.join(OUT, `SCHEMA_FINGERPRINT_PROD_BEFORE_BATCH2A.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...fpBefore }, null, 2),
  );

  const serviceKey = await getServiceRoleKey();
  const countsBefore = await collectCounts(serviceKey);
  fs.writeFileSync(
    path.join(OUT, `PROD_COUNTS_BEFORE_BATCH2A.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), counts: countsBefore }, null, 2),
  );

  const historyBefore = getMigrationList();
  fs.writeFileSync(
    path.join(OUT, `MIGRATION_HISTORY_PROD_BEFORE_BATCH2A.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...historyBefore }, null, 2),
  );

  const schemaBeforeText = fs.readFileSync(schemaBeforeFile, "utf8");
  const migration00002NoOp = isMigration00002NoOp(schemaBeforeText);

  const executed = [];
  const skipped = [];
  const groups = chunk(authorized, GROUP_SIZE);
  let aborted = false;
  let abortReason = null;

  for (let gi = 0; gi < groups.length && !aborted; gi++) {
    const group = groups[gi];
    const groupLog = { group: gi + 1, versions: group.map((m) => m.version), migrations: [] };

    for (const entry of group) {
      const sqlFile = path.join(MIGRATIONS_DIR, entry.file || `${entry.version}_${entry.name}.sql`);
      if (!fs.existsSync(sqlFile)) {
        skipped.push({ version: entry.version, reason: "SQL file missing" });
        aborted = true;
        abortReason = "missing_sql_file";
        break;
      }

      if (entry.version === "20260301000002" && migration00002NoOp) {
        const rec = {
          version: entry.version,
          name: entry.name,
          sql_ok: null,
          sql_skipped: true,
          skip_reason:
            "MANUAL_REVIEW_RUNTIME: PROD ja possui sales_order_id — efeito estrutural no-op comprovado no dump BEFORE; SQL/repair nao autorizados neste batch",
          history_ok: false,
          pre_missing: [],
          post_present: [],
          seller_counts_ok: true,
          legal_still_missing: true,
        };
        groupLog.migrations.push(rec);
        skipped.push({ version: entry.version, reason: rec.skip_reason, rec });
        continue;
      }

      const creds = getDbCreds();
      const preChecks = verifyObjects(creds, entry);
      const preMissing = preChecks.filter((c) => !c.present);

      const sqlResult = psqlFile(creds, sqlFile);
      const sqlOk = sqlResult.status === 0;

      const postChecks = sqlOk ? verifyObjects(getDbCreds(), entry) : [];
      const postPresent = postChecks.filter((c) => c.present);
      const expectedObjects =
        (entry.objects_expected?.tables?.length || 0) +
        (entry.objects_expected?.indexes?.length || 0) +
        (entry.objects_expected?.functions?.length || 0) +
        (entry.objects_expected?.columns?.length || 0);
      const objectsOk = expectedObjects === 0 || postPresent.length === expectedObjects;

      let historyResult = null;
      if (sqlOk && objectsOk) {
        historyResult = repairVersion(entry.version);
        if (!historyResult.ok) {
          aborted = true;
          abortReason = "history_repair_failed";
        }
      } else if (!sqlOk) {
        aborted = true;
        abortReason = "sql_execution_failed";
      } else {
        aborted = true;
        abortReason = "postcheck_objects_missing";
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
        sql_ok: sqlOk,
        sql_error: sqlOk ? null : redactSecrets((sqlResult.stderr || sqlResult.stdout || "").slice(0, 500)),
        history_ok: historyResult?.ok ?? false,
        pre_missing: preMissing,
        post_present: postPresent,
        seller_counts_ok: sellerOk,
        legal_still_missing: legalOk,
      };
      groupLog.migrations.push(rec);

      if (sqlOk && historyResult?.ok && sellerOk && legalOk && objectsOk) {
        executed.push(rec);
      } else {
        skipped.push({ version: entry.version, reason: abortReason, rec });
        aborted = true;
        break;
      }
    }
  }

  const schemaAfterFile = path.join(OUT, `_prod_schema_after_batch2a_${DATE}.sql`);
  dumpSchema(schemaAfterFile);
  const fpAfter = fingerprintDump(schemaAfterFile);
  fs.writeFileSync(
    path.join(OUT, `SCHEMA_FINGERPRINT_PROD_AFTER_BATCH2A.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...fpAfter }, null, 2),
  );

  const countsAfter = await collectCounts(serviceKey);
  fs.writeFileSync(
    path.join(OUT, `PROD_COUNTS_AFTER_BATCH2A.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), counts: countsAfter }, null, 2),
  );

  const historyAfter = getMigrationList();
  fs.writeFileSync(
    path.join(OUT, `MIGRATION_HISTORY_PROD_AFTER_BATCH2A.json`),
    JSON.stringify({ project_ref: PROD_REF, captured_at: new Date().toISOString(), ...historyAfter }, null, 2),
  );

  const plannedSkips = skipped.filter((s) => s.rec?.sql_skipped).length;
  const allSuccess = !aborted && executed.length + plannedSkips === authorized.length;
  const partial = !allSuccess && executed.length > 0;

  const batch2bRecommendation = {
    preference: "A — migration de reconciliação idempotente versionada",
    artifacts: FORWARD_FIX_VERSIONS.map((v) => `_shadow_forward_fix_${v}.sql`),
    note: "Não executar SQL ad hoc; formalizar forward-fix como migration versionada + evidence + repair",
  };

  const report = {
    pass: allSuccess,
    status: allSuccess
      ? "BATCH 2A CONCLUÍDO COM SUCESSO"
      : partial
        ? "BATCH 2A CONCLUÍDO PARCIALMENTE"
        : aborted && executed.length === 0
          ? "BATCH 2A BLOQUEADO ANTES DA EXECUÇÃO"
          : "BATCH 2A INTERROMPIDO",
    captured_at: new Date().toISOString(),
    credential: {
      postgres_authentication: postgresAuthPass ? "PASS" : "FAIL",
      ddl_probe: ddlProbePass ? "PASS" : "FAIL",
    },
    environment: {
      project: PROD_NAME,
      project_ref: PROD_REF,
      backup_latest: backups[0]?.inserted_at,
      backup_status: backups[0]?.status,
      pitr: "Supabase managed — backups list + dashboard restore",
    },
    authorized_count: authorized.length,
    executed_count: executed.length,
    skipped,
    executed,
    schema_fingerprint: {
      before: fpBefore,
      after: fpAfter,
      changed: fpBefore?.fingerprint !== fpAfter?.fingerprint,
    },
    data_counts: {
      before: countsBefore,
      after: countsAfter,
      seller_identical:
        countsBefore.profiles.count === countsAfter.profiles.count &&
        countsBefore.seller_companies.count === countsAfter.seller_companies.count,
    },
    legal_table: {
      before_missing: countsBefore.legal_document_acceptances.missing,
      after_missing: countsAfter.legal_document_acceptances.missing,
    },
    history: {
      before_pending: historyBefore.pending.length,
      after_pending: historyAfter.pending.length,
      newly_applied: executed.map((e) => e.version),
    },
    checkpoint_118_122_touched: false,
    batch_2b_recommendation: batch2bRecommendation,
    abort_reason: abortReason,
  };

  fs.writeFileSync(path.join(OUT, `BATCH2A_EXECUTE_AS_IS_EXECUTION_${DATE}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(OUT, `BATCH2A_EXECUTE_AS_IS_EXECUTION_${DATE}.md`),
    `# BATCH 2A — ${DATE}\n\nStatus: **${report.status}**\n\nExecuted: ${executed.length}/${authorized.length}\nPending after: ${historyAfter.pending.length}\n`,
  );

  relinkDev();
  clearProdPasswordMem();
  console.log(JSON.stringify({ pass: report.pass, status: report.status, executed: executed.length, total: authorized.length }, null, 2));
  process.exit(allSuccess ? 0 : 1);
}

main().catch((err) => {
  try {
    relinkDev();
  } catch {
    /* ignore */
  }
  clearProdPasswordMem();
  console.error(JSON.stringify({ pass: false, error: redactSecrets(String(err.message || err)) }));
  process.exit(1);
});
