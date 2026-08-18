#!/usr/bin/env node
/**
 * LOCAL_ONLY — CARD.CONFIGURATION.ONBOARDING.01B.1
 * Apply onboarding latch migration to Fresh DEV V2 hosted only.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const SECRETS_FILE = path.join(OUT, ".dev_v2_hosted_secrets.local");
const PROJECT_REF = "alkelcaoexxbamqddaqv";
const BACKEND_ROOT = path.join(__dirname, "..");

const CANONICAL_MIG = "20260814180000_profiles_onboarding_configuration_latches.sql";
const FLATTENED_MIG = "20260301000121_profiles_onboarding_configuration_latches.sql";

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 100 * 1024 * 1024, ...opts });
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
  if (!fs.existsSync(SECRETS_FILE)) throw new Error("missing secrets file");
  const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
  if (secrets.project_ref !== PROJECT_REF) {
    throw new Error(`project_ref mismatch: expected ${PROJECT_REF}, got ${secrets.project_ref}`);
  }
  return secrets;
}

function psqlRemote(sql, dbPassword) {
  const conn = `postgresql://postgres:${encodeURIComponent(dbPassword)}@db.${PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
  return spawnSync(
    "docker",
    ["run", "--rm", "postgres:17", "psql", conn, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
}

function parseMigrationList(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{14})\s*\|\s*(\d{14})?\s*/);
    if (!m) continue;
    rows.push({
      local: m[1],
      remote: m[2]?.trim() || null,
      status: !m[2]?.trim() ? "LOCAL_ONLY_PENDING" : m[1] === m[2]?.trim() ? "SYNCED" : "MISMATCH",
    });
  }
  return rows;
}

function prepareMigration() {
  const src = path.join(BACKEND_ROOT, "supabase", "migrations", CANONICAL_MIG);
  const content = fs.readFileSync(src, "utf8");
  if (/\bUPDATE\b/i.test(content) && !/ADD COLUMN IF NOT EXISTS/i.test(content)) {
    throw new Error("unexpected UPDATE in migration");
  }
  const destDir = path.join(WORKSPACE, "supabase", "migrations");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, FLATTENED_MIG);
  fs.writeFileSync(dest, content, "utf8");
  return { src, dest, sha256: sha256(content) };
}

const secrets = loadSecrets();
const dbPassword = secrets.db_password;
if (!dbPassword) throw new Error("missing db_password in secrets");

const preCounts = {
  auth_users: psqlRemote("SELECT count(*)::int FROM auth.users", dbPassword).stdout.trim(),
  profiles: psqlRemote("SELECT count(*)::int FROM public.profiles", dbPassword).stdout.trim(),
  seller_companies: psqlRemote("SELECT count(*)::int FROM public.seller_companies", dbPassword).stdout.trim(),
  marketplace_accounts: psqlRemote("SELECT count(*)::int FROM public.marketplace_accounts", dbPassword).stdout.trim(),
  sales_orders: psqlRemote("SELECT count(*)::int FROM public.sales_orders", dbPassword).stdout.trim(),
};

const preColumns = psqlRemote(
  `SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name IN ('operational_cycle_configured_at','first_marketplace_connected_at','initial_configuration_completed_at')`,
  dbPassword,
).stdout.trim();

const mig = prepareMigration();
const preList = supabaseArgs(["migration", "list", "--linked", "-p", dbPassword]);
const preRows = parseMigrationList(`${preList.stdout}\n${preList.stderr}`);
const prePending = preRows.filter((r) => r.status === "LOCAL_ONLY_PENDING");

const push = supabaseArgs(["db", "push", "--linked", "-p", dbPassword], {
  input: "y\n",
});

const postColumns = psqlRemote(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name IN ('operational_cycle_configured_at','first_marketplace_connected_at','initial_configuration_completed_at') ORDER BY 1`,
  dbPassword,
).stdout.trim().split(/\r?\n/).filter(Boolean);

const latchValues = psqlRemote(
  `SELECT operational_cycle_configured_at IS NULL, first_marketplace_connected_at IS NULL, initial_configuration_completed_at IS NULL FROM public.profiles LIMIT 1`,
  dbPassword,
).stdout.trim();

const postList = supabaseArgs(["migration", "list", "--linked", "-p", dbPassword]);
const postRows = parseMigrationList(`${postList.stdout}\n${postList.stderr}`);
const postPending = postRows.filter((r) => r.status === "LOCAL_ONLY_PENDING");

const result = {
  mission: "CARD.CONFIGURATION.ONBOARDING.01B.1",
  project_ref: PROJECT_REF,
  canonical_migration: CANONICAL_MIG,
  flattened_migration: FLATTENED_MIG,
  migration_sha256: mig.sha256,
  pre_migration: {
    counts: preCounts,
    latch_columns_present: Number(preColumns),
    pending_migrations: prePending.map((r) => r.local),
  },
  push: {
    exit_code: push.status,
    output_redacted: `${push.stdout}\n${push.stderr}`.replace(dbPassword, "***").slice(-2000),
  },
  post_migration: {
    latch_columns: postColumns,
    latch_columns_count: postColumns.length,
    seller_latch_null_triple: latchValues,
    pending_migrations: postPending.map((r) => r.local),
    synced_count: postRows.filter((r) => r.status === "SYNCED").length,
  },
  pass:
    push.status === 0 &&
    postColumns.length === 3 &&
    latchValues === "t|t|t" &&
    preCounts.auth_users === "1" &&
    preCounts.profiles === "1",
};

const outFile = path.join(OUT, "DEV_V2_ONBOARDING_LATCHES_HOSTED_APPLY_2026-08-14.json");
fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
