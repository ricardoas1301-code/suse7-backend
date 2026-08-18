#!/usr/bin/env node
/**
 * BATCH 5C4 — Shadow pós-115: migration 116 + security forward-fix
 * READ/DESIGN/SHADOW ONLY — sem PROD write.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeRlsPgCatalog, runRlsSelfTest, sqlProbeRls } from "./billing_rls_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const BASELINE = path.join(OUT, "_prod_schema_after_115_20260818.sql");
const MIG116 = path.join(WORKSPACE, "supabase", "migrations", "20260301000116_s7_billing_asaas_customer_notification_policy.sql");
const FORWARD_FIX = path.join(OUT, "BILLING116_FORWARD_FIX_CANDIDATE_20260818.sql");
const DOCKER_DB = "supabase_db_supabase-local-replay-workspace";
const SHADOW_DB = "s7_shadow_batch5c4_116";

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function dockerPsql(db, sql, file = null, tsv = false) {
  const args = ["exec", DOCKER_DB, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-d", db];
  if (tsv) args.push("-t", "-A");
  if (file) args.push("-f", file);
  else args.push("-c", sql);
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
}

function jsonOut(sql) {
  return (dockerPsql(SHADOW_DB, sql, null, true).stdout || "").trim();
}

function bootShadow() {
  dockerPsql("postgres", `DROP DATABASE IF EXISTS ${SHADOW_DB} WITH (FORCE);`);
  dockerPsql("postgres", `CREATE DATABASE ${SHADOW_DB};`);
  const boot = `CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;`;
  dockerPsql(SHADOW_DB, boot);
  spawnSync("docker", ["cp", BASELINE, `${DOCKER_DB}:/tmp/c4_base115.sql`]);
  const load = dockerPsql(SHADOW_DB, null, "/tmp/c4_base115.sql");
  if (load.status !== 0) throw new Error(`baseline load fail: ${(load.stderr || "").slice(0, 400)}`);
}

function buildCombinedApplySql() {
  const mig = fs.readFileSync(MIG116, "utf8");
  return `-- combined 116 + forward-fix (shadow/prod executor)
BEGIN;
${mig}
SELECT s7_private.apply_service_role_only_lockdown('billing_customer_notification_policy');
COMMIT;
`;
}

const FIXTURES = `
DO $$
BEGIN
  INSERT INTO auth.users (id) VALUES ('${USER_A}'::uuid), ('${USER_B}'::uuid) ON CONFLICT DO NOTHING;
  DELETE FROM public.billing_customer_notification_policy;

  INSERT INTO public.billing_customer_notification_policy (
    user_id, provider, environment, provider_customer_id, policy_version, policy_status, source
  ) VALUES
    ('${USER_A}'::uuid, 'asaas', 'sandbox', 'cus_a_fixture', 'v1', 'CONFIRMED_DISABLED', 'shadow'),
    ('${USER_B}'::uuid, 'asaas', 'sandbox', 'cus_b_fixture', 'v1', 'UNKNOWN', 'shadow');
END $$;
`;

export async function runShadow116() {
  if (!fs.existsSync(BASELINE)) throw new Error(`Baseline pós-115 ausente: ${BASELINE}`);
  if (!fs.existsSync(MIG116)) throw new Error(`Migration 116 ausente: ${MIG116}`);

  bootShadow();

  const tableBefore = jsonOut(
    "SELECT COUNT(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='billing_customer_notification_policy';",
  );

  const combined = buildCombinedApplySql();
  const combinedPath = path.join(OUT, "_shadow116_combined_apply.sql");
  fs.writeFileSync(combinedPath, combined);
  spawnSync("docker", ["cp", combinedPath, `${DOCKER_DB}:/tmp/c4_combined116.sql`]);

  const apply1 = dockerPsql(SHADOW_DB, null, "/tmp/c4_combined116.sql");
  if (apply1.status !== 0) {
    return { pass: false, stage: "combined_apply_1", stderr: (apply1.stderr || apply1.stdout || "").slice(0, 2400) };
  }
  const apply2 = dockerPsql(SHADOW_DB, null, "/tmp/c4_combined116.sql");

  const checks = {};
  checks.table_before_prod_equivalent = tableBefore === "0";
  checks.table_after = jsonOut(
    "SELECT COUNT(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='billing_customer_notification_policy';",
  ) === "1";
  checks.idempotent_second_run = apply2.status === 0;
  checks.row_count_baseline = jsonOut("SELECT COUNT(*)::text FROM public.billing_customer_notification_policy;") === "0";

  checks.pk = jsonOut("SELECT COUNT(*)::text FROM pg_constraint WHERE conname='billing_customer_notification_policy_pkey';") === "1";
  checks.unique = jsonOut("SELECT COUNT(*)::text FROM pg_constraint WHERE conname='billing_customer_notification_policy_provider_env_customer_uidx';") === "1";
  checks.check_status = jsonOut("SELECT COUNT(*)::text FROM pg_constraint WHERE conname='billing_customer_notification_policy_status_chk';") === "1";
  checks.index_user = jsonOut("SELECT COUNT(*)::text FROM pg_indexes WHERE schemaname='public' AND indexname='billing_customer_notification_policy_user_idx';") === "1";
  checks.index_status = jsonOut("SELECT COUNT(*)::text FROM pg_indexes WHERE schemaname='public' AND indexname='billing_customer_notification_policy_status_idx';") === "1";

  checks.rls_enabled = probeRlsPgCatalog(dockerPsql(SHADOW_DB, sqlProbeRls("public", "billing_customer_notification_policy"), null, true).stdout);
  checks.policy_count = Number(jsonOut("SELECT COUNT(*)::text FROM pg_policies WHERE schemaname='public' AND tablename='billing_customer_notification_policy';") || "0");
  checks.rls_self_test = runRlsSelfTest((sql, tsv = false) => dockerPsql(SHADOW_DB, sql, null, tsv));

  checks.grants = {
    anon_select_denied: /permission denied|42501/i.test(
      (dockerPsql(SHADOW_DB, `SET ROLE anon; SELECT COUNT(*) FROM public.billing_customer_notification_policy;`).stderr || "") +
        (dockerPsql(SHADOW_DB, `SET ROLE anon; SELECT COUNT(*) FROM public.billing_customer_notification_policy;`).stdout || ""),
    ) || dockerPsql(SHADOW_DB, `SET ROLE anon; SELECT COUNT(*) FROM public.billing_customer_notification_policy;`).status !== 0,
    authenticated_select_denied:
      dockerPsql(SHADOW_DB, `SET ROLE authenticated; SELECT COUNT(*) FROM public.billing_customer_notification_policy;`).status !== 0,
    service_role_select_ok:
      dockerPsql(SHADOW_DB, `SET ROLE service_role; SELECT COUNT(*) FROM public.billing_customer_notification_policy;`).status === 0,
  };

  dockerPsql(SHADOW_DB, FIXTURES);
  checks.fixture_rows = Number(jsonOut("SELECT COUNT(*)::text FROM public.billing_customer_notification_policy;") || "0") === 2;

  const crossA = dockerPsql(
    SHADOW_DB,
    `SET ROLE authenticated;
     SELECT set_config('request.jwt.claim.sub', '${USER_B}', true);
     CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${USER_B}'::uuid $$;
     SELECT COUNT(*)::text FROM public.billing_customer_notification_policy WHERE user_id='${USER_A}'::uuid;`,
    null,
    true,
  );
  checks.multi_tenant_authenticated_blocked = crossA.status !== 0 || (crossA.stdout || "").trim() === "0";

  const svcReadA = jsonOut(`SET ROLE service_role; SELECT COUNT(*)::text FROM public.billing_customer_notification_policy WHERE user_id='${USER_A}'::uuid;`);
  const svcReadB = jsonOut(`SET ROLE service_role; SELECT COUNT(*)::text FROM public.billing_customer_notification_policy WHERE user_id='${USER_B}'::uuid;`);
  checks.service_role_can_read_by_user_filter = svcReadA === "1" && svcReadB === "1";

  const badStatus = dockerPsql(
    SHADOW_DB,
    `INSERT INTO public.billing_customer_notification_policy (user_id, provider, environment, provider_customer_id, policy_version, policy_status)
     VALUES ('${USER_A}'::uuid, 'asaas', 'sandbox', 'cus_bad', 'v1', 'INVALID_STATUS');`,
  );
  checks.check_status_rejects_invalid = badStatus.status !== 0;

  const dupUnique = dockerPsql(
    SHADOW_DB,
    `INSERT INTO public.billing_customer_notification_policy (user_id, provider, environment, provider_customer_id, policy_version, policy_status)
     VALUES ('${USER_B}'::uuid, 'asaas', 'sandbox', 'cus_a_fixture', 'v1', 'UNKNOWN');`,
  );
  checks.unique_provider_env_customer = dupUnique.status !== 0;

  checks.historical_alone_unsafe = {
    note: "116 histórica sem forward-fix: RLS comentado + DEFAULT PRIVILEGES anon/authenticated = exposição PostgREST",
    simulated: true,
  };

  const pass =
    checks.table_after &&
    checks.idempotent_second_run &&
    checks.row_count_baseline &&
    checks.rls_enabled &&
    checks.policy_count === 0 &&
    checks.rls_self_test.pass &&
    checks.grants.anon_select_denied &&
    checks.grants.authenticated_select_denied &&
    checks.grants.service_role_select_ok &&
    checks.multi_tenant_authenticated_blocked &&
    checks.service_role_can_read_by_user_filter &&
    checks.check_status_rejects_invalid &&
    checks.unique_provider_env_customer &&
    checks.pk &&
    checks.unique &&
    checks.check_status &&
    checks.index_user &&
    checks.index_status;

  return {
    pass,
    checks,
    strategy: "116 historical DDL + apply_service_role_only_lockdown same transaction",
    forward_fix_helper: "s7_private.apply_service_role_only_lockdown",
  };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("billing116_shadow_post115.mjs")) {
  runShadow116()
    .then((r) => {
      fs.writeFileSync(path.join(OUT, "BILLING116_SHADOW_RESULTS_20260818.json"), JSON.stringify(r, null, 2));
      console.log(JSON.stringify({ pass: r.pass, checks: r.checks }, null, 2));
      process.exit(r.pass ? 0 : 1);
    })
    .catch((e) => {
      console.error(JSON.stringify({ pass: false, error: String(e.message || e) }));
      process.exit(1);
    });
}
