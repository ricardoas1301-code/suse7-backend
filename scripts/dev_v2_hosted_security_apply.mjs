#!/usr/bin/env node
/**
 * DEV.V2.SECURITY-HARDENING-HOSTED-APPLY.13
 * Apply security hardening migration to Fresh DEV V2 hosted only.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const RUN_DATE = process.env.RUN_DATE || "2026-08-13";
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const SECRETS_FILE = path.join(OUT, ".dev_v2_hosted_secrets.local");
const PROJECT_REF = "alkelcaoexxbamqddaqv";
const BASE = `https://${PROJECT_REF}.supabase.co`;

const EXPECTED_FE = "cae8ee731c19997f9bed57ce22d8e0f6b19c7148";
const EXPECTED_BE = "6539955da0c806db20ab84938bf6f383928e4eb4";
const CLEAN_FE = process.env.CLEAN_FRONTEND_ROOT || path.join(__dirname, "..", "..", "suse7-frontend");
const CLEAN_BE = process.env.CLEAN_BACKEND_ROOT || path.join(__dirname, "..");

const CANONICAL_MIG = "20260813180000_s7_security_exposure_preconnect_hardening.sql";
const CANONICAL_PATH = path.join(CLEAN_BE, "supabase", "migrations", CANONICAL_MIG);
const FLATTENED_MIG = "20260301000119_s7_security_exposure_preconnect_hardening.sql";

const RUNTIME_TABLES = [
  "profiles", "seller_companies", "marketplace_accounts", "sales_orders",
  "sales_order_items", "ml_webhook_events",
];

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

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function parseSupabaseJson(stdout) {
  const i = stdout.indexOf("[");
  const j = stdout.lastIndexOf("]");
  if (i < 0) return null;
  try {
    return JSON.parse(stdout.slice(i, j + 1));
  } catch {
    return null;
  }
}

function psqlRemote(sql, dbPassword) {
  const conn = `postgresql://postgres:${encodeURIComponent(dbPassword)}@db.${PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
  return spawnSync(
    "docker",
    ["run", "--rm", "postgres:17", "psql", conn, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
    { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
  );
}

function loadSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) throw new Error("missing secrets file");
  return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
}

function loadApiKeys() {
  const raw = fs.readFileSync(path.join(OUT, "_api_keys.json"), "utf8");
  const keys = parseSupabaseJson(raw);
  if (!keys) throw new Error("api keys parse failed");
  const anon = keys.find((k) => /anon/i.test(k.name))?.api_key;
  const service = keys.find((k) => /service_role/i.test(k.name))?.api_key;
  if (!anon || !service) throw new Error("missing anon/service keys");
  return { anon, service };
}

function verifyGit() {
  const fe = run(`git -C "${CLEAN_FE}" rev-parse HEAD`).stdout.trim();
  const be = run(`git -C "${CLEAN_BE}" rev-parse HEAD`).stdout.trim();
  return {
    pass: fe === EXPECTED_FE && be === EXPECTED_BE,
    frontend: fe,
    backend: be,
  };
}

function preparePendingMigration() {
  if (!fs.existsSync(CANONICAL_PATH)) throw new Error(`canonical migration missing: ${CANONICAL_PATH}`);
  const content = fs.readFileSync(CANONICAL_PATH, "utf8");
  const hash = sha256(content);
  const migDir = path.join(WORKSPACE, "supabase", "migrations");
  const dest = path.join(migDir, FLATTENED_MIG);
  fs.mkdirSync(migDir, { recursive: true });
  fs.writeFileSync(dest, content, "utf8");
  return {
    canonical_path: CANONICAL_PATH,
    flattened_path: dest,
    sha256: hash,
    mapping: { git: CANONICAL_MIG, hosted: FLATTENED_MIG },
  };
}

function parseMigrationList(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s*\|\s*(\S*)\s*\|/);
    if (!m) continue;
    const local = m[1];
    const remote = m[2]?.trim() || "";
    if (!/^\d{14}$/.test(local)) continue;
    rows.push({
      version: local,
      local,
      remote: remote || null,
      status: !remote ? "LOCAL_ONLY_PENDING" : local === remote ? "SYNCED" : "MISMATCH",
    });
  }
  return rows;
}

function migrationPrecheck(dbPassword) {
  const list = supabaseArgs(["migration", "list", "--linked", "-p", dbPassword]);
  const output = `${list.stdout}\n${list.stderr}`;
  const rows = parseMigrationList(output);
  const synced = rows.filter((r) => r.status === "SYNCED");
  const pending = rows.filter((r) => r.status === "LOCAL_ONLY_PENDING");
  const mismatch = rows.filter((r) => r.status === "MISMATCH");
  const remoteOnly = rows.filter((r) => r.remote && !rows.some((x) => x.local === r.remote && x.status === "SYNCED"));
  const expectedPending = pending.length === 1 && pending[0].version === "20260301000119";
  const pass =
    list.status === 0 &&
    synced.length === 118 &&
    expectedPending &&
    mismatch.length === 0 &&
    pending.every((p) => p.version === "20260301000119");
  return {
    pass,
    synced_count: synced.length,
    pending,
    mismatch,
    remote_only_unknown: mismatch.length + (synced.length < 118 ? 1 : 0),
    unexpected_pending: pending.filter((p) => p.version !== "20260301000119").length,
    expected_security_pending: expectedPending,
    rows,
    raw_tail: rows.slice(-5),
  };
}

function runtimeSnapshot(dbPassword) {
  const counts = {};
  for (const t of RUNTIME_TABLES) {
    const r = psqlRemote(`SELECT count(*)::int FROM public.${t}`, dbPassword);
    counts[t] = r.status === 0 ? parseInt(r.stdout.trim(), 10) : null;
  }
  counts.auth_users = parseInt(psqlRemote(`SELECT count(*)::int FROM auth.users`, dbPassword).stdout.trim(), 10);
  counts.plans = parseInt(psqlRemote(`SELECT count(*)::int FROM public.plans`, dbPassword).stdout.trim(), 10);
  const rlsErrors = psqlRemote(`
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
    ORDER BY c.relname
  `, dbPassword);
  const plansFp = psqlRemote(
    `SELECT md5(string_agg(plan_key||':'||coalesce(sales_limit_monthly::text,'')||':'||coalesce(price_cents::text,''), ',' ORDER BY plan_key)) FROM public.plans`,
    dbPassword,
  ).stdout.trim();
  return {
    counts,
    runtime_zero: RUNTIME_TABLES.every((t) => counts[t] === 0) && counts.auth_users === 0,
    plans_count: counts.plans,
    rls_disabled_tables: rlsErrors.stdout.trim().split(/\r?\n/).filter(Boolean),
    plans_fingerprint: plansFp,
  };
}

function privilegeSmoke(dbPassword) {
  const q = (fn, roles) => {
    const parts = roles.map((role) =>
      `has_function_privilege('${role}', '${fn}', 'EXECUTE') AS ${role}`,
    );
    const r = psqlRemote(`SELECT ${parts.join(", ")}`, dbPassword);
    if (r.status !== 0) return null;
    const vals = r.stdout.trim().split("|");
    const o = {};
    roles.forEach((role, i) => {
      o[role] = vals[i]?.trim() === "t";
    });
    return o;
  };
  return {
    get_ml_token_for_user: q("public.get_ml_token_for_user(uuid)", ["anon", "authenticated", "service_role"]),
    refresh_ml_tokens_for_user: q("public.refresh_ml_tokens_for_user(uuid)", ["anon", "authenticated", "service_role"]),
    billing_internal_resolve_access_precedence: q(
      "public.billing_internal_resolve_access_precedence(jsonb)",
      ["anon", "authenticated"],
    ),
    tables: {
      marketplace_account_sales_import_coverage: {
        rls: psqlRemote(
          `SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='marketplace_account_sales_import_coverage'`,
          dbPassword,
        ).stdout.trim() === "t",
      },
      billing_customer_notification_policy: {
        rls: psqlRemote(
          `SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='billing_customer_notification_policy'`,
          dbPassword,
        ).stdout.trim() === "t",
      },
    },
  };
}

async function restSmoke(keys) {
  const anon = createClient(BASE, keys.anon, { auth: { persistSession: false } });
  const service = createClient(BASE, keys.service, { auth: { persistSession: false } });
  const internalTables = [
    "marketplace_account_sales_import_coverage",
    "billing_customer_notification_policy",
    "ml_tokens",
  ];
  const anonTables = {};
  for (const t of internalTables) {
    const { error, status } = await anon.from(t).select("id").limit(1);
    anonTables[t] = { denied: !!error || status === 401 || status === 403, status, error: error?.message ?? null };
  }
  const rpcs = {};
  for (const fn of ["get_ml_token_for_user", "refresh_ml_tokens_for_user"]) {
    const res = await anon.rpc(fn, { in_user_id: "00000000-0000-0000-0000-000000000001" });
    rpcs[fn] = { denied: !!res.error, error: res.error?.message ?? null };
  }
  const svcCoverage = await service.from("marketplace_account_sales_import_coverage").select("id").limit(1);
  const svcCatalog = await service.rpc("get_catalog_rankings", {
    p_user_id: "00000000-0000-0000-0000-000000000001",
  });
  return {
    anon_tables: anonTables,
    anon_rpcs: rpcs,
    service_role: {
      coverage_ok: !svcCoverage.error,
      catalog_ok: !svcCatalog.error,
    },
  };
}

function securityAdvisorEquivalent(dbPassword) {
  const rlsDisabled = psqlRemote(`
    SELECT count(*)::int FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  `, dbPassword).stdout.trim();
  const anonSecDef = psqlRemote(`
    SELECT count(*)::int FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND p.proname IN ('get_ml_token_for_user','refresh_ml_tokens_for_user')
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  `, dbPassword).stdout.trim();
  return {
    rls_disabled_error_count: parseInt(rlsDisabled, 10),
    p0_anon_secdef_count: parseInt(anonSecDef, 10),
    error_equivalent: parseInt(rlsDisabled, 10) === 0 && parseInt(anonSecDef, 10) === 0,
  };
}

function storageCheck(dbPassword) {
  const bucket = psqlRemote(
    `SELECT id, public::text, file_size_limit::text FROM storage.buckets WHERE id='company-logos'`,
    dbPassword,
  );
  const objects = psqlRemote(`SELECT count(*)::int FROM storage.objects WHERE bucket_id='company-logos'`, dbPassword);
  return {
    bucket_exists: bucket.stdout.includes("company-logos"),
    objects: parseInt(objects.stdout.trim(), 10),
    pass: bucket.stdout.includes("company-logos") && parseInt(objects.stdout.trim(), 10) === 0,
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const secrets = loadSecrets();
  if (secrets.project_ref !== PROJECT_REF) throw new Error("project_ref mismatch");

  const git = verifyGit();
  if (!git.pass) throw new Error(`git hash mismatch: ${JSON.stringify(git)}`);

  const mig = preparePendingMigration();
  const preRuntime = runtimeSnapshot(secrets.db_password);
  const precheck = migrationPrecheck(secrets.db_password);

  fs.writeFileSync(
    path.join(OUT, `DEV_V2_HOSTED_MIGRATION_HISTORY_PRECHECK_${RUN_DATE}.json`),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        project_ref: PROJECT_REF,
        git,
        migration_mapping: mig.mapping,
        canonical_sha256: mig.sha256,
        precheck,
        pre_apply_runtime: preRuntime,
      },
      null,
      2,
    ),
  );

  if (!precheck.pass) {
    console.error(JSON.stringify({ status: "BLOCKED", reason: "migration precheck FAIL", precheck }, null, 2));
    process.exit(2);
  }

  const push = supabaseArgs(["db", "push", "--linked", "-p", secrets.db_password, "--yes"]);
  const pushOut = `${push.stdout}\n${push.stderr}`;
  const applyPass = push.status === 0;

  const postPrecheck = migrationPrecheck(secrets.db_password);
  const postRuntime = runtimeSnapshot(secrets.db_password);
  const priv = privilegeSmoke(secrets.db_password);
  const advisor = securityAdvisorEquivalent(secrets.db_password);
  const storage = storageCheck(secrets.db_password);
  const keys = loadApiKeys();
  const rest = await restSmoke(keys);

  const applyResult = {
    generated_at: new Date().toISOString(),
    project_ref: PROJECT_REF,
    apply_pass: applyPass,
    exit_code: push.status,
    output_redacted: pushOut.replace(secrets.db_password, "[REDACTED]"),
    migration_applied: FLATTENED_MIG,
    post_migration_list: postPrecheck,
  };
  fs.writeFileSync(path.join(OUT, `DEV_V2_HOSTED_SECURITY_APPLY_RESULT_${RUN_DATE}.json`), JSON.stringify(applyResult, null, 2));

  const advisorAfter = {
    generated_at: new Date().toISOString(),
    project_ref: PROJECT_REF,
    rls_disabled_errors: advisor.rls_disabled_error_count,
    p0_anon_secdef: advisor.p0_anon_secdef_count,
    gate_error_zero: advisor.error_equivalent,
    note: "Hosted dashboard may report additional WARN/INFO; SQL gate validates P0 ERROR classes",
  };
  fs.writeFileSync(path.join(OUT, `DEV_V2_HOSTED_SECURITY_ADVISOR_AFTER_${RUN_DATE}.json`), JSON.stringify(advisorAfter, null, 2));

  const permSmoke = {
    generated_at: new Date().toISOString(),
    sql_privileges: priv,
    rest_smoke: rest,
    pass:
      priv.get_ml_token_for_user?.anon === false &&
      priv.get_ml_token_for_user?.authenticated === false &&
      priv.get_ml_token_for_user?.service_role === true &&
      priv.refresh_ml_tokens_for_user?.anon === false &&
      priv.refresh_ml_tokens_for_user?.authenticated === false &&
      priv.refresh_ml_tokens_for_user?.service_role === true &&
      priv.tables.marketplace_account_sales_import_coverage.rls &&
      priv.tables.billing_customer_notification_policy.rls &&
      rest.anon_rpcs.get_ml_token_for_user.denied &&
      rest.anon_rpcs.refresh_ml_tokens_for_user.denied,
  };
  fs.writeFileSync(path.join(OUT, `DEV_V2_HOSTED_SECURITY_PERMISSION_SMOKE_${RUN_DATE}.json`), JSON.stringify(permSmoke, null, 2));

  fs.writeFileSync(
    path.join(OUT, `DEV_V2_HOSTED_RUNTIME_ZERO_POST_SECURITY_${RUN_DATE}.json`),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        pre: preRuntime,
        post: postRuntime,
        plans_fingerprint_unchanged: preRuntime.plans_fingerprint === postRuntime.plans_fingerprint,
        pass: postRuntime.runtime_zero && postRuntime.plans_count === 8,
      },
      null,
      2,
    ),
  );

  const overallPass =
    applyPass &&
    postPrecheck.synced_count === 119 &&
    postPrecheck.pending.length === 0 &&
    advisor.error_equivalent &&
    permSmoke.pass &&
    postRuntime.runtime_zero &&
    postRuntime.plans_count === 8 &&
    preRuntime.plans_fingerprint === postRuntime.plans_fingerprint &&
    storage.pass;

  console.log(
    JSON.stringify(
      {
        mission: "DEV.V2.SECURITY-HARDENING-HOSTED-APPLY.13",
        precheck: precheck.pass,
        apply: applyPass,
        advisor_errors: advisor.rls_disabled_error_count,
        perm_smoke: permSmoke.pass,
        runtime_zero: postRuntime.runtime_zero,
        overall: overallPass ? "PASS" : "FAIL",
      },
      null,
      2,
    ),
  );
  process.exit(overallPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
