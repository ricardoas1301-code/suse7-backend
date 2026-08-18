#!/usr/bin/env node
/**
 * BATCH 5C3 — Shadow pós-114: migration 115 paid lifecycle + concurrency
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeRlsPgCatalog, runRlsSelfTest, sqlProbeRls } from "./billing_rls_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const BASELINE = path.join(OUT, "_prod_schema_after_114_20260818.sql");
const MIG115 = path.join(WORKSPACE, "supabase", "migrations", "20260301000115_s7_billing_paid_lifecycle_atomic_6_9a12.sql");
const DOCKER_DB = "supabase_db_supabase-local-replay-workspace";
const SHADOW_DB = "s7_shadow_batch5c3_115";

export const PAID_NOTIFICATION_TYPES = [
  "RENEWAL_AVAILABLE",
  "PAYMENT_PENDING",
  "PAYMENT_DUE",
  "GRACE_LAST_DAY",
  "BABY_FALLBACK_ACTIVATED",
  "PAYMENT_CONFIRMED",
  "ENTERED_GRACE",
  "SUSPENDED",
  "REACTIVATED",
  "PAYMENT_FAILED",
];

const SUB_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const BABY_SUB_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

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
  spawnSync("docker", ["cp", BASELINE, `${DOCKER_DB}:/tmp/c3_base114.sql`]);
  const load = dockerPsql(SHADOW_DB, null, "/tmp/c3_base114.sql");
  if (load.status !== 0) throw new Error(`baseline load fail: ${(load.stderr || "").slice(0, 400)}`);

  const cat = `
INSERT INTO public.s7_notification_categories (code, label, description, is_active)
VALUES ('BILLING', 'Billing', 'Eventos billing', true)
ON CONFLICT (code) DO NOTHING;
INSERT INTO public.plans (id, name, plan_key, sales_limit_monthly, is_active, price, limit_pricings, pricing_mode)
VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid, 'Pro Fixture', 'pro', 100, true, 99, 0, 'fixed')
ON CONFLICT (id) DO NOTHING;
`;
  const bootCat = dockerPsql(SHADOW_DB, cat);
  if (bootCat.status !== 0) throw new Error(`bootstrap fail: ${(bootCat.stderr || "").slice(0, 400)}`);
}

const FIXTURES = `
DO $$
BEGIN
  INSERT INTO auth.users (id) VALUES ('${USER_ID}'::uuid) ON CONFLICT DO NOTHING;
  DELETE FROM public.billing_paid_lifecycle_ledger;
  DELETE FROM public.billing_paid_lifecycle_job_locks;
  DELETE FROM public.billing_subscriptions WHERE user_id = '${USER_ID}'::uuid;

  INSERT INTO public.billing_subscriptions (id, user_id, plan_id, provider, status, metadata, is_active, plan_key)
  VALUES (
    '${SUB_ID}'::uuid, '${USER_ID}'::uuid,
    (SELECT id FROM public.plans WHERE plan_key='pro' LIMIT 1),
    'asaas', 'active',
    jsonb_build_object(
      'effective_entitlement', 'PAID_PLAN',
      'sync_state', 'FULL',
      'hard_pause_owner', 'BABY_QUOTA_ENGINE',
      'access_profile', 'FULL_ACCESS'
    ),
    true, 'pro'
  );

  INSERT INTO public.billing_subscriptions (id, user_id, plan_id, provider, status, metadata, is_active, plan_key)
  VALUES (
    '${BABY_SUB_ID}'::uuid, '${USER_ID}'::uuid,
    (SELECT id FROM public.plans WHERE plan_key='pro' LIMIT 1),
    'internal', 'internal_free',
    jsonb_build_object(
      'effective_entitlement', 'BABY_INTERNAL_FREE',
      'hard_pause_owner', 'BABY_QUOTA_ENGINE',
      'sync_state', 'HARD_PAUSED'
    ),
    true, 'pro'
  );
END $$;
`;

function jsonOut(sql) {
  return (dockerPsql(SHADOW_DB, sql, null, true).stdout || "").trim();
}

function applyTransition(provider, eventId, paymentId, eventType, paidConfirmed = false, correlation = "shadow115") {
  return jsonOut(
    `SELECT public.billing_paid_lifecycle_apply_transition(
      '${provider}', '${eventId}', '${paymentId}',
      '${SUB_ID}'::uuid, '2026-08', '${eventType}',
      ${paidConfirmed}, '${correlation}'
    )::text;`,
  );
}

function parallelSql(sql) {
  return new Promise((resolve) => {
    const child = spawn("docker", ["exec", DOCKER_DB, "psql", "-U", "postgres", "-d", SHADOW_DB, "-t", "-A", "-c", sql], {
      encoding: "utf8",
    });
    let stdout = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.on("close", (code) => resolve({ code, stdout: stdout.trim() }));
  });
}

export async function runShadow115() {
  if (!fs.existsSync(BASELINE)) throw new Error(`Baseline pós-114 ausente: ${BASELINE}`);
  if (!fs.existsSync(MIG115)) throw new Error(`Migration 115 ausente: ${MIG115}`);

  bootShadow();

  const catalogBefore = Number(jsonOut("SELECT COUNT(*)::text FROM public.s7_notification_event_types;") || "0");
  const paidBefore = {};
  for (const tk of PAID_NOTIFICATION_TYPES) {
    paidBefore[tk] =
      Number(jsonOut(`SELECT COUNT(*)::text FROM public.s7_notification_event_types WHERE category_code='BILLING' AND type_key='${tk}';`) || "0") > 0
        ? "EXISTS"
        : "MISSING";
  }

  spawnSync("docker", ["cp", MIG115, `${DOCKER_DB}:/tmp/c3_mig115.sql`]);
  const mig1 = dockerPsql(SHADOW_DB, null, "/tmp/c3_mig115.sql");
  if (mig1.status !== 0) {
    return { pass: false, stage: "migration_1", stderr: (mig1.stderr || mig1.stdout || "").slice(0, 2400) };
  }
  const mig2 = dockerPsql(SHADOW_DB, null, "/tmp/c3_mig115.sql");

  const checks = {};
  checks.tables = {
    ledger: jsonOut("SELECT COUNT(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='billing_paid_lifecycle_ledger';") === "1",
    job_locks: jsonOut("SELECT COUNT(*)::text FROM information_schema.tables WHERE table_schema='public' AND table_name='billing_paid_lifecycle_job_locks';") === "1",
  };
  checks.rpc = {
    acquire: jsonOut("SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_paid_lifecycle_try_acquire_job_lock';") === "1",
    release: jsonOut("SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_paid_lifecycle_release_job_lock';") === "1",
    apply: jsonOut("SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_paid_lifecycle_apply_transition';") === "1",
  };
  checks.idempotent_second_run = mig2.status === 0;
  checks.ledger_unique = jsonOut("SELECT COUNT(*)::text FROM pg_constraint WHERE conname='billing_paid_lifecycle_ledger_uq';") === "1";

  checks.paid_types = {};
  for (const tk of PAID_NOTIFICATION_TYPES) {
    checks.paid_types[tk] =
      Number(jsonOut(`SELECT COUNT(*)::text FROM public.s7_notification_event_types WHERE category_code='BILLING' AND type_key='${tk}';`) || "0") === 1;
  }
  checks.catalog_after = Number(jsonOut("SELECT COUNT(*)::text FROM public.s7_notification_event_types;") || "0");
  checks.catalog_delta = checks.catalog_after - catalogBefore;

  checks.rls = {
    ledger: probeRlsPgCatalog(dockerPsql(SHADOW_DB, sqlProbeRls("public", "billing_paid_lifecycle_ledger"), null, true).stdout),
    job_locks: probeRlsPgCatalog(dockerPsql(SHADOW_DB, sqlProbeRls("public", "billing_paid_lifecycle_job_locks"), null, true).stdout),
  };
  checks.rls_self_test = runRlsSelfTest((sql, tsv = false) => dockerPsql(SHADOW_DB, sql, null, tsv));

  dockerPsql(SHADOW_DB, FIXTURES);

  const transitions = {};
  transitions.renewal = /"ok"\s*:\s*true/.test(applyTransition("asaas", "evt-renew-1", "pay-0", "RENEWAL_AVAILABLE"));
  transitions.payment_pending = /"ok"\s*:\s*true/.test(applyTransition("asaas", "evt-pend-1", "pay-1", "PAYMENT_PENDING"));
  transitions.payment_due = /"ok"\s*:\s*true/.test(applyTransition("asaas", "evt-due-1", "pay-2", "PAYMENT_DUE"));
  transitions.entered_grace = /"ok"\s*:\s*true/.test(applyTransition("asaas", "evt-grace-1", "pay-3", "ENTERED_GRACE"));
  transitions.grace_last_day = /"ok"\s*:\s*true/.test(applyTransition("asaas", "evt-grace-last-1", "pay-4", "GRACE_LAST_DAY"));
  transitions.suspend = /PAID_SUSPENDED/.test(applyTransition("asaas", "evt-susp-1", "pay-5", "SUSPEND"));
  transitions.payment_failed = /"ok"\s*:\s*true/.test(applyTransition("asaas", "evt-fail-1", "pay-6", "PAYMENT_FAILED"));
  transitions.payment_confirmed = /PAID_REACTIVATED_OR_SCHEDULED/.test(
    applyTransition("asaas", "evt-conf-1", "pay-7", "PAYMENT_CONFIRMED", true),
  );
  transitions.baby_fallback = /"ok"\s*:\s*true/.test(applyTransition("asaas", "evt-baby-1", "pay-8", "BABY_FALLBACK_ACTIVATED"));
  transitions.reactivated = /"ok"\s*:\s*true/.test(applyTransition("asaas", "evt-react-1", "pay-9", "REACTIVATED"));

  const dup = applyTransition("asaas", "evt-dup-1", "pay-dup", "PAYMENT_DUE");
  const dup2 = applyTransition("asaas", "evt-dup-1", "pay-dup", "PAYMENT_DUE");
  transitions.idempotent_retry = /"claimed"\s*:\s*true/.test(dup) && /"idempotent"\s*:\s*true/.test(dup2);

  const ledgerDupCount = Number(
    jsonOut(`SELECT COUNT(*)::text FROM public.billing_paid_lifecycle_ledger WHERE provider_event_id='evt-dup-1';`) || "0",
  );
  checks.ledger_single_row_dup = ledgerDupCount === 1;

  const lock1 = jsonOut(`SELECT public.billing_paid_lifecycle_try_acquire_job_lock('paid:shadow:seq', 'owner-a', 120)::text;`);
  const lock2 = jsonOut(`SELECT public.billing_paid_lifecycle_try_acquire_job_lock('paid:shadow:seq', 'owner-b', 120)::text;`);
  checks.lock_first_acquire = /"acquired"\s*:\s*true/.test(lock1);
  checks.lock_second_blocked = /lock_held/.test(lock2);
  dockerPsql(SHADOW_DB, `SELECT public.billing_paid_lifecycle_release_job_lock('paid:shadow:seq', 'owner-a');`);
  checks.lock_after_release = /"acquired"\s*:\s*true/.test(
    jsonOut(`SELECT public.billing_paid_lifecycle_try_acquire_job_lock('paid:shadow:seq', 'owner-b', 120)::text;`),
  );

  dockerPsql(SHADOW_DB, `DELETE FROM public.billing_paid_lifecycle_job_locks WHERE lock_key='paid:shadow:exp';`);
  dockerPsql(
    SHADOW_DB,
    `INSERT INTO public.billing_paid_lifecycle_job_locks (lock_key, owner, acquired_at, expires_at)
     VALUES ('paid:shadow:exp', 'stale-owner', now()-interval '1 hour', now()-interval '30 minutes');`,
  );
  checks.lock_after_expiry = /"acquired"\s*:\s*true/.test(
    jsonOut(`SELECT public.billing_paid_lifecycle_try_acquire_job_lock('paid:shadow:exp', 'owner-new', 60)::text;`),
  );

  dockerPsql(SHADOW_DB, `DELETE FROM public.billing_paid_lifecycle_job_locks WHERE lock_key='paid:shadow:parallel';`);
  const parallelLock = await Promise.all([
    parallelSql(`SELECT public.billing_paid_lifecycle_try_acquire_job_lock('paid:shadow:parallel', 'owner-a', 60)::text;`),
    parallelSql(`SELECT public.billing_paid_lifecycle_try_acquire_job_lock('paid:shadow:parallel', 'owner-b', 60)::text;`),
  ]);
  const lockAcquired = parallelLock.filter((r) => /"acquired"\s*:\s*true/.test(r.stdout)).length;
  const lockBlocked = parallelLock.filter((r) => /lock_held/.test(r.stdout)).length;
  checks.lock_parallel = lockAcquired === 1 && lockBlocked === 1;

  const ledgerSql = `SELECT public.billing_paid_lifecycle_apply_transition('asaas','evt-race-1','pay-race','${SUB_ID}'::uuid,'2026-08','PAYMENT_PENDING',false,'race')::text;`;
  const parallelLedger = await Promise.all([parallelSql(ledgerSql), parallelSql(ledgerSql)]);
  const claimedCount = parallelLedger.filter((r) => /"claimed"\s*:\s*true/.test(r.stdout)).length;
  const idempotentCount = parallelLedger.filter((r) => /"idempotent"\s*:\s*true/.test(r.stdout)).length;
  checks.ledger_parallel = claimedCount === 1 && idempotentCount === 1;
  checks.ledger_race_rows =
    Number(jsonOut(`SELECT COUNT(*)::text FROM public.billing_paid_lifecycle_ledger WHERE provider_event_id='evt-race-1';`) || "0") === 1;

  const subFpBefore = jsonOut(
    `SELECT status||'|'||plan_key||'|'||provider||'|'||is_active::text||'|'||COALESCE(metadata->>'hard_pause_owner','') FROM public.billing_subscriptions WHERE id='${SUB_ID}';`,
  );
  applyTransition("asaas", "evt-meta-1", "pay-meta", "SUSPEND");
  const subFpAfter = jsonOut(
    `SELECT status||'|'||plan_key||'|'||provider||'|'||is_active::text||'|'||COALESCE(metadata->>'hard_pause_owner','') FROM public.billing_subscriptions WHERE id='${SUB_ID}';`,
  );
  checks.subscription_fixture_unchanged_by_rpc = subFpBefore === subFpAfter;

  const babyHp = jsonOut(`SELECT metadata->>'hard_pause_owner' FROM public.billing_subscriptions WHERE id='${BABY_SUB_ID}';`);
  checks.hard_pause_baby_preserved = babyHp.includes("BABY_QUOTA_ENGINE");

  checks.transitions = transitions;

  const pass =
    checks.tables.ledger &&
    checks.tables.job_locks &&
    checks.rpc.acquire &&
    checks.rpc.release &&
    checks.rpc.apply &&
    checks.idempotent_second_run &&
    checks.ledger_unique &&
    Object.values(checks.paid_types).every(Boolean) &&
    checks.rls.ledger &&
    checks.rls.job_locks &&
    checks.rls_self_test.pass &&
    Object.values(transitions).every(Boolean) &&
    checks.ledger_single_row_dup &&
    checks.lock_first_acquire &&
    checks.lock_second_blocked &&
    checks.lock_after_release &&
    checks.lock_after_expiry &&
    checks.lock_parallel &&
    checks.ledger_parallel &&
    checks.ledger_race_rows &&
    checks.subscription_fixture_unchanged_by_rpc &&
    checks.hard_pause_baby_preserved;

  return {
    pass,
    checks,
    catalog: { before: catalogBefore, after: checks.catalog_after, delta: checks.catalog_delta, paid_before: paidBefore },
    concurrency: {
      job_lock_parallel: checks.lock_parallel,
      ledger_parallel: checks.ledger_parallel,
      ledger_race_rows: checks.ledger_race_rows,
    },
    idempotent_second_run: checks.idempotent_second_run,
  };
}

if (process.argv[1]?.endsWith("billing115_shadow_post114.mjs")) {
  runShadow115().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.pass ? 0 : 1);
  });
}
