#!/usr/bin/env node
/**
 * BATCH 5C1 — Shadow pós-112: migration 113 + fixtures sintéticas
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const BASELINE = path.join(OUT, "_prod_schema_after_112_20260818.sql");
const MIG113 = path.join(WORKSPACE, "supabase", "migrations", "20260301000113_s7_billing_billable_sale_admission_atomic_hardening_6_9a10.sql");
const DOCKER_DB = "supabase_db_supabase-local-replay-workspace";
const SHADOW_DB = "s7_shadow_batch5c1_113";

function dockerPsql(db, sql, file = null, tsv = false) {
  const args = ["exec", DOCKER_DB, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-d", db];
  if (tsv) args.push("-t", "-A");
  if (file) args.push("-f", file);
  else args.push("-c", sql);
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
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
  spawnSync("docker", ["cp", BASELINE, `${DOCKER_DB}:/tmp/c1_base112.sql`]);
  const load = dockerPsql(SHADOW_DB, null, "/tmp/c1_base112.sql");
  if (load.status !== 0) throw new Error(`baseline load fail: ${(load.stderr || "").slice(0, 400)}`);

  const catalogBootstrap = `
INSERT INTO public.plans (id, name, plan_key, sales_limit_monthly, is_active, price, limit_pricings, pricing_mode)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'Baby Fixture', 'baby', 3, true, 0, 0, 'fixed')
ON CONFLICT (id) DO NOTHING;
`;
  const bootCat = dockerPsql(SHADOW_DB, catalogBootstrap);
  if (bootCat.status !== 0) throw new Error(`catalog bootstrap fail: ${(bootCat.stderr || "").slice(0, 400)}`);
}

const FIXTURES = `
DO $$
DECLARE
  v_user uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
  v_sub uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid;
  v_sc uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid;
  v_ma uuid := 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid;
BEGIN
  INSERT INTO auth.users (id) VALUES (v_user) ON CONFLICT DO NOTHING;
  INSERT INTO public.seller_companies (id, user_id, company_name, document_cnpj, is_primary)
  VALUES (v_sc, v_user, 'Fixture Co C1', '00000000000000', true) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.marketplace_accounts (id, user_id, seller_company_id, marketplace, external_seller_id, status)
  VALUES (v_ma, v_user, v_sc, 'mercado_livre', 'ML-FIX-113', 'active') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.billing_billable_sale_admissions;
  DELETE FROM public.billing_subscriptions WHERE id = v_sub;
  INSERT INTO public.billing_subscriptions (id, user_id, plan_id, provider, status, metadata, is_active, plan_key)
  SELECT v_sub, v_user, p.id, 'internal', 'internal_free',
    jsonb_build_object('effective_entitlement','BABY_INTERNAL_FREE','suspension_fallback_active',true,'trial_state','NONE',
      'sync_state','FULL','quota_counting_started_at',(now()-interval '30 days')::text,'usage_limit_cycle_key','2026-08',
      'fallback_period_start','2026-08-01','fallback_period_end','2026-09-01','sales_limit_snapshot',3,'sales_limit_snapshot_cycle_key','2026-08'),
    true, 'baby'
  FROM public.plans p WHERE p.plan_key = 'baby' LIMIT 1;
  INSERT INTO public.billing_billable_sale_admissions (
    user_id, subscription_id, cycle_key, external_order_id, marketplace, marketplace_account_id,
    admission_result, idempotency_key, reservation_attempt_id, updated_at, created_at
  ) VALUES
    (v_user, v_sub, '2026-08', 'FX-RESERVED', 'mercado_livre', v_ma, 'RESERVED', 'fx:r:1', gen_random_uuid(), now(), now()),
    (v_user, v_sub, '2026-08', 'FX-PERSISTED', 'mercado_livre', v_ma, 'PERSISTED', 'fx:p:1', gen_random_uuid(), now(), now()),
    (v_user, v_sub, '2026-08', 'FX-REJECT', 'mercado_livre', v_ma, 'REJECTED_QUOTA', 'fx:q:1', gen_random_uuid(), now(), now()),
    (v_user, v_sub, '2026-08', 'FX-ROLL', 'mercado_livre', v_ma, 'ROLLED_BACK', 'fx:rb:1', gen_random_uuid(), now(), now()),
    (v_user, v_sub, '2026-08', 'FX-EXPIRED', 'mercado_livre', v_ma, 'EXPIRED', 'fx:e:1', gen_random_uuid(), now(), now()),
    (v_user, v_sub, '2026-07', 'FX-RECOVERY', 'mercado_livre', v_ma, 'RECOVERY_REQUIRED', 'fx:rc:1', gen_random_uuid(), now(), now());
END $$;
`;

export function runShadow113() {
  if (!fs.existsSync(BASELINE)) throw new Error(`Baseline pós-112 ausente: ${BASELINE}`);
  if (!fs.existsSync(MIG113)) throw new Error(`Migration 113 ausente: ${MIG113}`);

  bootShadow();
  spawnSync("docker", ["cp", MIG113, `${DOCKER_DB}:/tmp/c1_mig113.sql`]);
  const mig1 = dockerPsql(SHADOW_DB, null, "/tmp/c1_mig113.sql");
  if (mig1.status !== 0) {
    return { pass: false, stage: "migration_1", stderr: (mig1.stderr || mig1.stdout || "").slice(0, 2400) };
  }

  const mig2 = dockerPsql(SHADOW_DB, null, "/tmp/c1_mig113.sql");
  const checks = {};
  checks.plans_baby_active_uidx = (dockerPsql(SHADOW_DB, `SELECT COUNT(*)::text FROM pg_indexes WHERE indexname='plans_baby_active_uidx';`, null, true).stdout || "").trim() === "1";
  checks.reserve_v2 = (dockerPsql(SHADOW_DB, `SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_reserve_billable_sale_v2';`, null, true).stdout || "").trim() === "1";
  checks.admitted_zero = (dockerPsql(SHADOW_DB, `SELECT COUNT(*)::text FROM public.billing_billable_sale_admissions WHERE admission_result='ADMITTED';`, null, true).stdout || "").trim() === "0";
  checks.v1_wrapper = (dockerPsql(SHADOW_DB, `SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_admit_billable_sale_v1' LIMIT 1;`, null, true).stdout || "").includes("v1_wrapper_disabled_use_v2");
  checks.idempotent_second_run = mig2.status === 0;

  dockerPsql(SHADOW_DB, FIXTURES);
  const states = dockerPsql(
    SHADOW_DB,
    `SELECT string_agg(DISTINCT admission_result, ',' ORDER BY admission_result) FROM public.billing_billable_sale_admissions;`,
    null,
    true,
  );
  checks.fixture_states = (states.stdout || "").trim();
  checks.fixtures_ok = ["EXPIRED", "PERSISTED", "RECOVERY_REQUIRED", "REJECTED_QUOTA", "RESERVED", "ROLLED_BACK"].every((s) =>
    checks.fixture_states.includes(s),
  );

  const subFpBefore = dockerPsql(
    SHADOW_DB,
    `SELECT status||'|'||plan_key||'|'||provider||'|'||is_active::text FROM public.billing_subscriptions WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';`,
    null,
    true,
  );

  const reserve = dockerPsql(
    SHADOW_DB,
    `SELECT public.billing_reserve_billable_sale_v2('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,'2026-08','FX-NEW-1','11111111-1111-1111-1111-111111111111'::uuid,'mercado_livre','dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid,3,false,now(),'shadow113')::text;`,
    null,
    true,
  );
  checks.reserve_smoke = /"admit"\s*:\s*true/.test(reserve.stdout || "");
  checks.reserve_smoke_output = (reserve.stdout || "").trim().slice(0, 200);

  const subFpAfter = dockerPsql(
    SHADOW_DB,
    `SELECT status||'|'||plan_key||'|'||provider||'|'||is_active::text FROM public.billing_subscriptions WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';`,
    null,
    true,
  );
  checks.subscription_structural_preserved = (subFpBefore.stdout || "").trim() === (subFpAfter.stdout || "").trim();

  const pass =
    checks.plans_baby_active_uidx &&
    checks.reserve_v2 &&
    checks.admitted_zero &&
    checks.v1_wrapper &&
    checks.idempotent_second_run &&
    checks.fixtures_ok &&
    checks.reserve_smoke;

  return { pass, checks, dml_admitted_expected: 0, idempotent_second_run: checks.idempotent_second_run };
}

if (process.argv[1] && process.argv[1].endsWith("billing113_shadow_post112.mjs")) {
  const r = runShadow113();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.pass ? 0 : 1);
}
