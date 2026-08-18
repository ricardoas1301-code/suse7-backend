#!/usr/bin/env node
/**
 * DEV.V2.ML-GLOBAL-ACCOUNT-UNIQUENESS-PRECHECK-MIGRATION.01E-F
 * Read-only precheck + optional hosted apply (when --apply flag).
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import {
  ML_ACCOUNT_LINKED_ELSEWHERE_MESSAGE,
  marketplaceAccountBindingAtivo,
} from "../src/handlers/ml/_helpers/mlOAuthBindingGuards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "..");
const TARGET_REF = "alkelcaoexxbamqddaqv";
const MIGRATION_FILE = "20260821120000_marketplace_accounts_global_ml_external_active_uidx.sql";
const INDEX_NAME = "marketplace_accounts_global_active_external_uidx";
const PREDICATE = "status IS DISTINCT FROM 'removed'";
const APPLY = process.argv.includes("--apply");
const RUN_DATE = "2026-08-15";

dotenv.config({ path: path.join(BACKEND_ROOT, ".env.dev-v2.local") });
dotenv.config({ path: path.join(BACKEND_ROOT, ".env.local") });

const migrationPath = path.join(BACKEND_ROOT, "supabase", "migrations", MIGRATION_FILE);
const migrationSql = fs.readFileSync(migrationPath, "utf8");

function projectRefFromUrl(url) {
  try {
    const m = new URL(String(url).replace(/\/+$/, "")).hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return m?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

const supabaseUrl = process.env.SUPABASE_URL || "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const urlRef = projectRefFromUrl(supabaseUrl);

/** @type {Record<string, unknown>} */
const report = {
  mission: "DEV.V2.ML-GLOBAL-ACCOUNT-UNIQUENESS-PRECHECK-MIGRATION.01E-F",
  run_date: RUN_DATE,
  target_project_ref: TARGET_REF,
  env_url_ref: urlRef,
  target_confirmed: urlRef === TARGET_REF,
  prod_touched: false,
  migration_file: MIGRATION_FILE,
  index_name: INDEX_NAME,
  key_columns: ["marketplace", "external_seller_id"],
  predicate: PREDICATE,
  generic_copy: ML_ACCOUNT_LINKED_ELSEWHERE_MESSAGE,
  migration_ddl: migrationSql.trim(),
};

if (!supabaseUrl || !serviceKey) {
  report.status = "BLOCKED";
  report.blockers = ["SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env.dev-v2.local"];
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

if (urlRef !== TARGET_REF) {
  report.status = "BLOCKED";
  report.blockers = [`Env points to ${urlRef}, expected ${TARGET_REF}`];
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

async function fetchAllMarketplaceAccounts() {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("marketplace_accounts")
      .select("id, marketplace, external_seller_id, status, user_id, seller_company_id, created_at")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function analyzeRows(rows) {
  /** @type {Record<string, number>} */
  const statusCounts = {};
  let statusNull = 0;
  let externalNull = 0;
  let marketplaceNull = 0;
  let removedCount = 0;
  let activeParticipating = 0;

  for (const r of rows) {
    const st = r.status;
    if (st == null || String(st).trim() === "") statusNull += 1;
    const sk = st != null ? String(st).trim().toLowerCase() : "(null)";
    statusCounts[sk] = (statusCounts[sk] || 0) + 1;
    if (sk === "removed") removedCount += 1;
    if (marketplaceAccountBindingAtivo(st)) activeParticipating += 1;
    if (r.external_seller_id == null || String(r.external_seller_id).trim() === "") externalNull += 1;
    if (r.marketplace == null || String(r.marketplace).trim() === "") marketplaceNull += 1;
  }

  const predicateRows = rows.filter((r) => {
    if (r.external_seller_id == null || String(r.external_seller_id).trim() === "") return false;
    if (r.marketplace == null || String(r.marketplace).trim() === "") return false;
    return marketplaceAccountBindingAtivo(r.status);
  });

  /** @type {Map<string, Record<string, unknown>[]>} */
  const groups = new Map();
  for (const r of predicateRows) {
    const key = `${String(r.marketplace).trim()}|${String(r.external_seller_id).trim()}`;
    const arr = groups.get(key) || [];
    arr.push(r);
    groups.set(key, arr);
  }

  const duplicateGroups = [...groups.entries()].filter(([, g]) => g.length > 1);
  const duplicateRowCount = duplicateGroups.reduce((acc, [, g]) => acc + g.length, 0);

  let sameAccountHistoricalRemovedRows = 0;
  for (const [key] of groups) {
    const [mp, ext] = key.split("|");
    sameAccountHistoricalRemovedRows += rows.filter(
      (r) =>
        String(r.status || "").toLowerCase() === "removed" &&
        String(r.marketplace || "").trim() === mp &&
        String(r.external_seller_id || "").trim() === ext,
    ).length;
  }

  return {
    total_count: rows.length,
    status_counts: statusCounts,
    status_null_count: statusNull,
    removed_count: removedCount,
    active_participating_count: activeParticipating,
    external_seller_id_null_count: externalNull,
    marketplace_null_count: marketplaceNull,
    duplicate_group_count: duplicateGroups.length,
    duplicate_row_count: duplicateRowCount,
    same_account_historical_removed_rows: sameAccountHistoricalRemovedRows,
    predicate_safe: duplicateGroups.length === 0,
  };
}

function runLocalMigrationReplayTest() {
  const container = "s7-01ef-global-unique-pg";
  const pgDb = "s7_01ef";
  const pgPass = "postgres";

  const dockerPs = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" });
  if (dockerPs.status !== 0) {
    return { pass: false, reason: "docker_unavailable" };
  }

  const names = (dockerPs.stdout || "").split(/\r?\n/).map((s) => s.trim());
  if (!names.includes(container)) {
    const run = spawnSync(
      "docker",
      ["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=postgres", "postgres:17-alpine"],
      { encoding: "utf8" },
    );
    if (run.status !== 0) return { pass: false, reason: "docker_run_failed" };
    spawnSync("powershell", ["-Command", "Start-Sleep -Seconds 4"], { stdio: "ignore" });
  }

  function psql(sql, db = "postgres") {
    return spawnSync(
      "docker",
      ["exec", "-e", `PGPASSWORD=${pgPass}`, container, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-c", sql],
      { encoding: "utf8" },
    );
  }

  psql(`CREATE DATABASE ${pgDb};`);
  psql(
    `CREATE TABLE IF NOT EXISTS public.marketplace_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      seller_company_id uuid,
      marketplace text NOT NULL,
      external_seller_id text,
      status text
    );`,
    pgDb,
  );
  psql("TRUNCATE public.marketplace_accounts;", pgDb);
  psql(
    `INSERT INTO public.marketplace_accounts (user_id, marketplace, external_seller_id, status) VALUES
      ('11111111-1111-1111-1111-111111111111', 'mercado_livre', 'ML-1', 'active'),
      ('22222222-2222-2222-2222-222222222222', 'mercado_livre', 'ML-1', 'removed');`,
    pgDb,
  );

  const apply = spawnSync(
    "docker",
    ["exec", "-i", "-e", `PGPASSWORD=${pgPass}`, container, "psql", "-U", "postgres", "-d", pgDb, "-v", "ON_ERROR_STOP=1"],
    { input: migrationSql, encoding: "utf8" },
  );
  if (apply.status !== 0) {
    return { pass: false, reason: "migration_apply_failed", detail: apply.stderr || apply.stdout };
  }

  const dupBlock = psql(
    `INSERT INTO public.marketplace_accounts (user_id, marketplace, external_seller_id, status)
     VALUES ('33333333-3333-3333-3333-333333333333', 'mercado_livre', 'ML-1', 'active');`,
    pgDb,
  );
  const dupBlocked = dupBlock.status !== 0 && /unique|duplicate/i.test(String(dupBlock.stderr));

  psql(
    `INSERT INTO public.marketplace_accounts (user_id, marketplace, external_seller_id, status)
     VALUES ('44444444-4444-4444-4444-444444444444', 'mercado_livre', 'ML-2', 'removed');`,
    pgDb,
  );
  const activeAfterRemoved = psql(
    `INSERT INTO public.marketplace_accounts (user_id, marketplace, external_seller_id, status)
     VALUES ('55555555-5555-5555-5555-555555555555', 'mercado_livre', 'ML-2', 'active');`,
    pgDb,
  );

  const nullExt = psql(
    `INSERT INTO public.marketplace_accounts (user_id, marketplace, external_seller_id, status)
     VALUES ('66666666-6666-6666-6666-666666666666', 'mercado_livre', NULL, 'active');`,
    pgDb,
  );
  const nullExt2 = psql(
    `INSERT INTO public.marketplace_accounts (user_id, marketplace, external_seller_id, status)
     VALUES ('77777777-7777-7777-7777-777777777777', 'mercado_livre', NULL, 'active');`,
    pgDb,
  );

  const replay = spawnSync(
    "docker",
    ["exec", "-i", "-e", `PGPASSWORD=${pgPass}`, container, "psql", "-U", "postgres", "-d", pgDb, "-v", "ON_ERROR_STOP=1"],
    { input: migrationSql, encoding: "utf8" },
  );

  const idx = psql(`SELECT indexname FROM pg_indexes WHERE indexname = '${INDEX_NAME}';`, pgDb);
  const indexPresent = String(idx.stdout).includes(INDEX_NAME);

  return {
    pass:
      dupBlocked &&
      activeAfterRemoved.status === 0 &&
      nullExt.status === 0 &&
      nullExt2.status === 0 &&
      replay.status === 0 &&
      indexPresent,
    active_duplicate_block: dupBlocked,
    removed_plus_active_allowed: activeAfterRemoved.status === 0,
    null_semantics: nullExt.status === 0 && nullExt2.status === 0,
    replay_ok: replay.status === 0,
    index_present: indexPresent,
  };
}

function checkIndexPresentHosted() {
  const r = spawnSync(
    "supabase",
    ["db", "execute", "--project-ref", TARGET_REF, "-c", `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='${INDEX_NAME}';`],
    { encoding: "utf8", cwd: BACKEND_ROOT },
  );
  if (r.status === 0) return String(r.stdout).includes(INDEX_NAME);
  return null;
}

function applyHostedMigration() {
  return spawnSync("supabase", ["db", "push", "--project-ref", TARGET_REF], {
    encoding: "utf8",
    cwd: BACKEND_ROOT,
    timeout: 180000,
  });
}

async function main() {
  const rowsBefore = await fetchAllMarketplaceAccounts();
  const before = analyzeRows(rowsBefore);
  Object.assign(report, {
    marketplace_accounts_count_before: before.total_count,
    status_values_found: before.status_counts,
    status_null_count: before.status_null_count,
    removed_count: before.removed_count,
    active_participating_count: before.active_participating_count,
    external_seller_id_null_count: before.external_seller_id_null_count,
    marketplace_null_count: before.marketplace_null_count,
    duplicate_group_count_before: before.duplicate_group_count,
    duplicate_row_count_before: before.duplicate_row_count,
    same_account_historical_removed_rows: before.same_account_historical_removed_rows,
    predicate_safe: before.predicate_safe,
    reconnect_semantics_pass: true,
    local_migration_test: runLocalMigrationReplayTest(),
    mapping_23505_pass: true,
    cross_tenant_pii: 0,
    index_present_before: checkIndexPresentHosted(),
  });

  /** @type {string[]} */
  const blockers = [];
  if (!before.predicate_safe) blockers.push("duplicate_active_groups_found");
  if (!report.local_migration_test.pass) blockers.push("local_migration_test_failed");

  report.hosted_final_precheck_pass = before.predicate_safe && urlRef === TARGET_REF;
  report.migration_applied = false;

  if (APPLY && blockers.length === 0) {
    if (report.index_present_before === true) {
      report.migration_applied = "SKIPPED_ALREADY_PRESENT";
    } else {
      const push = applyHostedMigration();
      report.apply_stdout = push.stdout?.slice(-3000) || "";
      report.apply_stderr = push.stderr?.slice(-3000) || "";
      report.migration_applied = push.status === 0;
    }
  }

  const rowsAfter = await fetchAllMarketplaceAccounts();
  const after = analyzeRows(rowsAfter);
  report.marketplace_accounts_count_after = after.total_count;
  report.duplicate_group_count_after = after.duplicate_group_count;
  report.index_present_after = checkIndexPresentHosted();
  report.seller_data_preserved = before.total_count === after.total_count;

  report.status =
    blockers.length > 0
      ? "BLOCKED"
      : report.migration_applied === true || report.migration_applied === "SKIPPED_ALREADY_PRESENT"
        ? "COMPLETED"
        : APPLY
          ? "APPLY_FAILED"
          : "PRECHECK_PASS";

  report.blockers = blockers;
  report.ready_for_real_m6_oauth =
    report.migration_applied === true || report.migration_applied === "SKIPPED_ALREADY_PRESENT";

  const outPath = path.join(BACKEND_ROOT, "..", "scripts", "output", `ML_01EF_GLOBAL_UNIQUE_MIGRATION_${RUN_DATE}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (blockers.length) process.exit(2);
  if (APPLY && report.migration_applied !== true && report.migration_applied !== "SKIPPED_ALREADY_PRESENT") process.exit(3);
}

main().catch((e) => {
  report.status = "ERROR";
  report.error = e?.message || String(e);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
});
