#!/usr/bin/env node
/**
 * DEV.V2.ML-GLOBAL-ACCOUNT-UNIQUENESS-PRECHECK-MIGRATION.01E-F
 * Hosted apply via supabase-hosted-v2-workspace (flattened migration chain).
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
  ML_ACCOUNT_LINKED_ELSEWHERE_MESSAGE,
  marketplaceAccountBindingAtivo,
} from "../src/handlers/ml/_helpers/mlOAuthBindingGuards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "output");
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const SECRETS_FILE = path.join(OUT, ".dev_v2_hosted_secrets.local");
const PROJECT_REF = "alkelcaoexxbamqddaqv";
const CANONICAL_MIG = "20260821120000_marketplace_accounts_global_ml_external_active_uidx.sql";
const FLATTENED_MIG = "20260301000122_marketplace_accounts_global_ml_external_active_uidx.sql";
const INDEX_NAME = "marketplace_accounts_global_active_external_uidx";
const APPLY = !process.argv.includes("--precheck-only");

dotenv.config({ path: path.join(BACKEND_ROOT, ".env.dev-v2.local") });

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function supabaseArgs(args, opts = {}) {
  return spawnSync("supabase", args, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    shell: false,
    cwd: WORKSPACE,
    ...opts,
  });
}

function loadSecrets() {
  const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
  if (secrets.project_ref !== PROJECT_REF) {
    throw new Error(`project_ref mismatch: expected ${PROJECT_REF}`);
  }
  return secrets;
}

function parseMigrationList(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{14})\s*\|\s*(\S*)/);
    if (!m) continue;
    const remote = m[2]?.trim() || null;
    rows.push({
      local: m[1],
      remote: remote && remote !== "" ? remote : null,
      status: !remote ? "LOCAL_ONLY_PENDING" : m[1] === remote ? "SYNCED" : "MISMATCH",
    });
  }
  return rows;
}

async function analyzeHosted(sb) {
  const { data, error } = await sb
    .from("marketplace_accounts")
    .select("id, marketplace, external_seller_id, status");
  if (error) throw error;
  const rows = data || [];
  /** @type {Record<string, number>} */
  const statusCounts = {};
  let statusNull = 0;
  let externalNull = 0;
  let removed = 0;
  let active = 0;

  /** @type {Map<string, number>} */
  const groups = new Map();
  for (const r of rows) {
    const st = r.status;
    if (st == null || String(st).trim() === "") statusNull += 1;
    const sk = st != null ? String(st).trim().toLowerCase() : "(null)";
    statusCounts[sk] = (statusCounts[sk] || 0) + 1;
    if (sk === "removed") removed += 1;
    if (!marketplaceAccountBindingAtivo(st)) continue;
    active += 1;
    if (r.external_seller_id == null || String(r.external_seller_id).trim() === "") {
      externalNull += 1;
      continue;
    }
    if (r.marketplace == null || String(r.marketplace).trim() === "") continue;
    const key = `${String(r.marketplace).trim()}|${String(r.external_seller_id).trim()}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const duplicateGroups = [...groups.values()].filter((n) => n > 1);
  return {
    total: rows.length,
    status_counts: statusCounts,
    status_null_count: statusNull,
    removed_count: removed,
    active_participating_count: active,
    external_seller_id_null_count: externalNull,
    duplicate_group_count: duplicateGroups.length,
    duplicate_row_count: duplicateGroups.reduce((a, n) => a + n, 0),
  };
}

function prepareMigration() {
  const src = path.join(BACKEND_ROOT, "supabase", "migrations", CANONICAL_MIG);
  const content = fs.readFileSync(src, "utf8");
  const destDir = path.join(WORKSPACE, "supabase", "migrations");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, FLATTENED_MIG);
  fs.writeFileSync(dest, content, "utf8");
  return { src, dest, sha256: sha256(content), ddl: content.trim() };
}

function indexFromSchemaDump() {
  const dump = supabaseArgs(["db", "dump", "--linked", "--schema", "public"]);
  const text = `${dump.stdout}\n${dump.stderr}`;
  return text.includes(INDEX_NAME);
}

async function main() {
  const secrets = loadSecrets();
  const dbPassword = secrets.db_password;
  const supabaseUrl = process.env.SUPABASE_URL || secrets.supabase_url || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || secrets.service_role_key || "";
  if (!dbPassword) throw new Error("missing db_password");

  const mig = prepareMigration();
  supabaseArgs(["link", "--project-ref", PROJECT_REF, "--yes"]);

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const before = await analyzeHosted(sb);
  const preList = supabaseArgs(["migration", "list", "--linked", "-p", dbPassword]);
  const preRows = parseMigrationList(`${preList.stdout}\n${preList.stderr}`);
  const alreadySynced = preRows.some((r) => r.local === "20260301000122" && r.status === "SYNCED");
  const indexBefore = indexFromSchemaDump();

  /** @type {Record<string, unknown>} */
  const report = {
    mission: "DEV.V2.ML-GLOBAL-ACCOUNT-UNIQUENESS-PRECHECK-MIGRATION.01E-F",
    target_project_ref: PROJECT_REF,
    prod_touched: false,
    canonical_migration: CANONICAL_MIG,
    flattened_migration: FLATTENED_MIG,
    index_name: INDEX_NAME,
    predicate: "status IS DISTINCT FROM 'removed'",
    key_columns: ["marketplace", "external_seller_id"],
    generic_copy: ML_ACCOUNT_LINKED_ELSEWHERE_MESSAGE,
    migration_sha256: mig.sha256,
    hosted_final_precheck_pass: before.duplicate_group_count === 0,
    duplicate_group_count_before: before.duplicate_group_count,
    duplicate_row_count_before: before.duplicate_row_count,
    marketplace_accounts_count_before: before.total,
    status_values_found: before.status_counts,
    status_null_count: before.status_null_count,
    removed_count: before.removed_count,
    active_participating_count: before.active_participating_count,
    external_seller_id_null_count: before.external_seller_id_null_count,
    index_present_before: indexBefore,
    already_synced: alreadySynced,
  };

  if (before.duplicate_group_count > 0) {
    report.status = "BLOCKED";
    report.blockers = ["duplicate_active_groups"];
    fs.writeFileSync(path.join(OUT, "ML_01EF_GLOBAL_UNIQUE_MIGRATION_2026-08-15.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }

  if (APPLY && !alreadySynced && !indexBefore) {
    const push = supabaseArgs(["db", "push", "--linked", "-p", dbPassword, "--yes"]);
    report.push = {
      exit_code: push.status,
      output_redacted: `${push.stdout}\n${push.stderr}`.replaceAll(dbPassword, "***").slice(-2500),
    };
    report.migration_applied = push.status === 0;
  } else {
    report.migration_applied = alreadySynced || indexBefore ? "SKIPPED_ALREADY_PRESENT" : false;
  }

  const after = await analyzeHosted(sb);
  const postList = supabaseArgs(["migration", "list", "--linked", "-p", dbPassword]);
  const postRows = parseMigrationList(`${postList.stdout}\n${postList.stderr}`);
  const indexAfter = indexFromSchemaDump();

  Object.assign(report, {
    marketplace_accounts_count_after: after.total,
    duplicate_group_count_after: after.duplicate_group_count,
    seller_data_preserved: before.total === after.total,
    index_present_after: indexAfter,
    hosted_migration_version: FLATTENED_MIG,
    migration_history_synced: postRows.some((r) => r.local === "20260301000122" && r.status === "SYNCED"),
    oauth_real: 0,
    initial_sync: 0,
    tokens_changed: 0,
    code_changes: 0,
    commit: "NONE",
    push_git: "NONE",
    status:
      report.migration_applied === true || report.migration_applied === "SKIPPED_ALREADY_PRESENT"
        ? "COMPLETED"
        : APPLY
          ? "APPLY_FAILED"
          : "PRECHECK_PASS",
    ready_for_real_m6_oauth: indexAfter && after.duplicate_group_count === 0,
    ready_for_real_initial_sync: false,
  });

  fs.writeFileSync(path.join(OUT, "ML_01EF_GLOBAL_UNIQUE_MIGRATION_2026-08-15.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.status === "COMPLETED" ? 0 : 1);
}

main().catch((e) => {
  console.error(JSON.stringify({ status: "ERROR", message: e?.message || String(e) }, null, 2));
  process.exit(1);
});
