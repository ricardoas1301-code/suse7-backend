#!/usr/bin/env node
/**
 * BATCH 5C2 — Shadow pós-113: migration 114 trial lifecycle + fixtures
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeRlsPgCatalog, runRlsSelfTest, sqlProbeRls } from "./billing_rls_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const BASELINE = path.join(OUT, "_prod_schema_after_113_20260818.sql");
const MIG114 = path.join(WORKSPACE, "supabase", "migrations", "20260301000114_s7_billing_trial_lifecycle_atomic_6_9a11a.sql");
const DOCKER_DB = "supabase_db_supabase-local-replay-workspace";
const SHADOW_DB = "s7_shadow_batch5c2_114";

const TRIAL_TYPES = ["TRIAL_ENDING_D3", "TRIAL_ENDING_D2", "TRIAL_ENDING_D1", "TRIAL_EXPIRED"];

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
  spawnSync("docker", ["cp", BASELINE, `${DOCKER_DB}:/tmp/c2_base113.sql`]);
  const load = dockerPsql(SHADOW_DB, null, "/tmp/c2_base113.sql");
  if (load.status !== 0) throw new Error(`baseline load fail: ${(load.stderr || "").slice(0, 400)}`);

  const cat = `
INSERT INTO public.s7_notification_categories (code, label, description, is_active)
VALUES ('BILLING', 'Billing', 'Eventos billing', true)
ON CONFLICT (code) DO NOTHING;
INSERT INTO public.plans (id, name, plan_key, sales_limit_monthly, is_active, price, limit_pricings, pricing_mode)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid, 'Baby Fixture', 'baby', 3, true, 0, 0, 'fixed')
ON CONFLICT (id) DO NOTHING;
`;
  const bootCat = dockerPsql(SHADOW_DB, cat);
  if (bootCat.status !== 0) throw new Error(`bootstrap fail: ${(bootCat.stderr || "").slice(0, 400)}`);
}

const FIXTURES = `
DO $$
DECLARE
  v_user uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
  v_trial_sub uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid;
  v_baby_sub uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid;
BEGIN
  INSERT INTO auth.users (id) VALUES (v_user) ON CONFLICT DO NOTHING;
  DELETE FROM public.billing_trial_lifecycle_transitions;
  DELETE FROM public.billing_trial_lifecycle_job_locks;
  DELETE FROM public.billing_subscriptions WHERE user_id = v_user;

  INSERT INTO public.billing_subscriptions (id, user_id, plan_id, provider, status, metadata, is_active, plan_key)
  VALUES (
    v_trial_sub, v_user, (SELECT id FROM public.plans WHERE plan_key='baby' LIMIT 1),
    'suse7_entitlement', 'entitlement_only',
    jsonb_build_object(
      'trial_state', 'ACTIVE',
      'effective_entitlement', 'TRIAL',
      'sync_state', 'FULL',
      'trial_end_civil', '2026-08-25'
    ),
    true, 'baby'
  );

  INSERT INTO public.billing_subscriptions (id, user_id, plan_id, provider, status, metadata, is_active, plan_key)
  VALUES (
    v_baby_sub, v_user, (SELECT id FROM public.plans WHERE plan_key='baby' LIMIT 1),
    'internal', 'internal_free',
    jsonb_build_object(
      'effective_entitlement', 'BABY_INTERNAL_FREE',
      'hard_pause_owner', 'BABY_QUOTA_ENGINE',
      'sync_state', 'HARD_PAUSED',
      'trial_state', 'NONE'
    ),
    true, 'baby'
  );
END $$;
`;

function jsonOut(sql) {
  const r = dockerPsql(SHADOW_DB, sql, null, true);
  return (r.stdout || "").trim();
}

function parallelLockAcquire() {
  dockerPsql(SHADOW_DB, `DELETE FROM public.billing_trial_lifecycle_job_locks WHERE lock_key='trial:shadow:parallel';`);
  const mk = (owner) =>
    new Promise((res) => {
      const cmd = `SELECT public.billing_trial_lifecycle_try_acquire_job_lock('trial:shadow:parallel', '${owner}', 60)::text;`;
      const child = spawn("docker", ["exec", DOCKER_DB, "psql", "-U", "postgres", "-d", SHADOW_DB, "-t", "-A", "-c", cmd], {
        encoding: "utf8",
      });
      let stdout = "";
      child.stdout?.on("data", (d) => {
        stdout += d;
      });
      child.on("close", (code) => res({ owner, code, stdout: stdout.trim() }));
    });
  return Promise.all([mk("owner-a"), mk("owner-b")]).then((results) => {
    dockerPsql(SHADOW_DB, `DELETE FROM public.billing_trial_lifecycle_job_locks WHERE lock_key='trial:shadow:parallel';`);
    return results;
  });
}

export async function runShadow114() {
  if (!fs.existsSync(BASELINE)) throw new Error(`Baseline pós-113 ausente: ${BASELINE}`);
  if (!fs.existsSync(MIG114)) throw new Error(`Migration 114 ausente: ${MIG114}`);

  bootShadow();

  const catalogBefore = Number(jsonOut("SELECT COUNT(*)::text FROM public.s7_notification_event_types;") || "0");
  const trialBefore = {};
  for (const tk of TRIAL_TYPES) {
    trialBefore[tk] = Number(
      jsonOut(`SELECT COUNT(*)::text FROM public.s7_notification_event_types WHERE category_code='BILLING' AND type_key='${tk}';`) || "0",
    ) > 0
      ? "EXISTS"
      : "MISSING";
  }

  spawnSync("docker", ["cp", MIG114, `${DOCKER_DB}:/tmp/c2_mig114.sql`]);
  const mig1 = dockerPsql(SHADOW_DB, null, "/tmp/c2_mig114.sql");
  if (mig1.status !== 0) {
    return { pass: false, stage: "migration_1", stderr: (mig1.stderr || mig1.stdout || "").slice(0, 2400) };
  }
  const mig2 = dockerPsql(SHADOW_DB, null, "/tmp/c2_mig114.sql");

  const checks = {};
  checks.tables = {
    transitions: jsonOut("SELECT COUNT(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='billing_trial_lifecycle_transitions';") === "1",
    job_locks: jsonOut("SELECT COUNT(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='billing_trial_lifecycle_job_locks';") === "1",
  };
  checks.rpc = {
    acquire: jsonOut("SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_trial_lifecycle_try_acquire_job_lock';") === "1",
    release: jsonOut("SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_trial_lifecycle_release_job_lock';") === "1",
    apply: jsonOut("SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_trial_lifecycle_apply_transition';") === "1",
  };
  checks.idempotent_second_run = mig2.status === 0;

  const catalogAfter = Number(jsonOut("SELECT COUNT(*)::text FROM public.s7_notification_event_types;") || "0");
  checks.trial_types = {};
  for (const tk of TRIAL_TYPES) {
    const c = Number(
      jsonOut(`SELECT COUNT(*)::text FROM public.s7_notification_event_types WHERE category_code='BILLING' AND type_key='${tk}';`) || "0",
    );
    checks.trial_types[tk] = c === 1;
  }
  checks.catalog_delta = catalogAfter - catalogBefore;

  checks.rls = {
    transitions: probeRlsPgCatalog(dockerPsql(SHADOW_DB, sqlProbeRls("public", "billing_trial_lifecycle_transitions"), null, true).stdout),
    job_locks: probeRlsPgCatalog(dockerPsql(SHADOW_DB, sqlProbeRls("public", "billing_trial_lifecycle_job_locks"), null, true).stdout),
  };
  checks.rls_self_test = runRlsSelfTest((sql, tsv = false) => dockerPsql(SHADOW_DB, sql, null, tsv));

  dockerPsql(SHADOW_DB, FIXTURES);

  const uid = "'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid";
  const trialEnd = "'2026-08-25'::date";

  checks.transition_d3 = /"ok"\s*:\s*true/.test(
    jsonOut(`SELECT public.billing_trial_lifecycle_apply_transition(${uid}, 'ALERT_D3', ${trialEnd})::text;`),
  );
  checks.transition_d2 = /"ok"\s*:\s*true/.test(
    jsonOut(`SELECT public.billing_trial_lifecycle_apply_transition(${uid}, 'ALERT_D2', ${trialEnd})::text;`),
  );
  checks.transition_d1 = /"ok"\s*:\s*true/.test(
    jsonOut(`SELECT public.billing_trial_lifecycle_apply_transition(${uid}, 'ALERT_D1', ${trialEnd})::text;`),
  );
  checks.transition_expired_alert = /"ok"\s*:\s*true/.test(
    jsonOut(`SELECT public.billing_trial_lifecycle_apply_transition(${uid}, 'ALERT_EXPIRED', ${trialEnd})::text;`),
  );

  const expire1 = jsonOut(`SELECT public.billing_trial_lifecycle_apply_transition(${uid}, 'EXPIRE_RESTRICTED', ${trialEnd})::text;`);
  checks.transition_expire = /TRIAL_EXPIRED_RESTRICTED/.test(expire1);
  const metaAfterExpire = jsonOut(
    `SELECT metadata->>'trial_state'||'|'||COALESCE(metadata->>'access_owner','') FROM public.billing_subscriptions WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';`,
  );
  checks.cas_metadata =
    (/EXPIRED/.test(metaAfterExpire) && /TRIAL_LIFECYCLE_ENGINE/.test(metaAfterExpire)) ||
    (/TRIAL_EXPIRED_RESTRICTED/.test(expire1) && /TRIAL_LIFECYCLE_ENGINE/.test(expire1));
  const expire2 = jsonOut(`SELECT public.billing_trial_lifecycle_apply_transition(${uid}, 'EXPIRE_RESTRICTED', ${trialEnd})::text;`);
  checks.transition_idempotent = /"idempotent"\s*:\s*true/.test(expire2);

  const lock1 = jsonOut(`SELECT public.billing_trial_lifecycle_try_acquire_job_lock('trial:shadow:seq', 'owner-a', 120)::text;`);
  const lock2 = jsonOut(`SELECT public.billing_trial_lifecycle_try_acquire_job_lock('trial:shadow:seq', 'owner-b', 120)::text;`);
  checks.lock_first_acquire = /"acquired"\s*:\s*true/.test(lock1);
  checks.lock_second_blocked = /"acquired"\s*:\s*false/.test(lock2) && /lock_held/.test(lock2);
  dockerPsql(SHADOW_DB, `SELECT public.billing_trial_lifecycle_release_job_lock('trial:shadow:seq', 'owner-a');`);
  const lock3 = jsonOut(`SELECT public.billing_trial_lifecycle_try_acquire_job_lock('trial:shadow:seq', 'owner-b', 120)::text;`);
  checks.lock_after_release = /"acquired"\s*:\s*true/.test(lock3);

  const parallel = await parallelLockAcquire();
  const acquiredCount = parallel.filter((r) => /"acquired"\s*:\s*true/.test(r.stdout || "")).length;
  const blockedCount = parallel.filter((r) => /lock_held/.test(r.stdout || "")).length;
  checks.lock_parallel_one_wins = acquiredCount === 1 && blockedCount === 1;
  checks.lock_parallel_detail = { acquiredCount, blockedCount };

  const restore = jsonOut(
    `SELECT public.billing_trial_lifecycle_apply_transition(${uid}, 'RESTORE_PAID', ${trialEnd}, true)::text;`,
  );
  checks.restore_paid = /PAID_ACTIVE/.test(restore);
  const hp = jsonOut(
    `SELECT metadata->>'hard_pause_owner' FROM public.billing_subscriptions WHERE provider='internal' AND user_id=${uid} LIMIT 1;`,
  );
  checks.hard_pause_preserved = hp.includes("BABY_QUOTA_ENGINE");

  const pass =
    checks.tables.transitions &&
    checks.tables.job_locks &&
    checks.rpc.acquire &&
    checks.rpc.release &&
    checks.rpc.apply &&
    checks.idempotent_second_run &&
    Object.values(checks.trial_types).every(Boolean) &&
    checks.rls.transitions &&
    checks.rls.job_locks &&
    checks.rls_self_test.pass &&
    checks.transition_d3 &&
    checks.transition_d2 &&
    checks.transition_d1 &&
    checks.transition_expired_alert &&
    checks.transition_expire &&
    checks.transition_idempotent &&
    checks.cas_metadata &&
    checks.lock_first_acquire &&
    checks.lock_second_blocked &&
    checks.lock_after_release &&
    checks.restore_paid &&
    checks.hard_pause_preserved;

  return {
    pass,
    checks,
    catalog: { before: catalogBefore, after: catalogAfter, trial_before: trialBefore, trial_after: checks.trial_types },
    idempotent_second_run: checks.idempotent_second_run,
  };
}

if (process.argv[1]?.endsWith("billing114_shadow_post113.mjs")) {
  runShadow114().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.pass ? 0 : 1);
  });
}
