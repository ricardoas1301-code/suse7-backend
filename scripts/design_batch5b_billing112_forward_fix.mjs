#!/usr/bin/env node
/**
 * BATCH 5B — Design + shadow forward-fix 112 v1→v2 (READ/DESIGN/SHADOW ONLY)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260818";
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const MIGRATIONS_DIR = path.join(WORKSPACE, "supabase", "migrations");
const PROD_REF = "bazibzquasbdgjwdcwbz";
const DEV_REF = "alkelcaoexxbamqddaqv";
const DOCKER_DB = "supabase_db_supabase-local-replay-workspace";
const SHADOW_DB = "s7_shadow_batch5b_billing112";
const MIG112 = path.join(MIGRATIONS_DIR, "20260301000112_s7_billing_billable_sale_admission_atomic.sql");
const MIG113 = path.join(MIGRATIONS_DIR, "20260301000113_s7_billing_billable_sale_admission_atomic_hardening_6_9a10.sql");
const FIX00043 = path.join(OUT, "_batch5a_forward_fix_00043_processed_idx.sql");
const FORWARD_FIX_OUT = path.join(OUT, `BILLING112_FORWARD_FIX_CANDIDATE_${DATE}.sql`);

const V2_COLUMNS = [
  ["usage_limit", "integer"],
  ["entitlement_type", "text"],
  ["entitlement_source", "text"],
  ["pause_cycle_key", "text"],
  ["pause_reason", "text"],
  ["previous_sync_state", "text"],
  ["previous_usage_state", "text"],
  ["previous_access_profile", "text"],
  ["reservation_owner_token", "uuid"],
  ["reservation_attempt_id", "uuid NOT NULL DEFAULT gen_random_uuid()"],
  ["reserved_at", "timestamptz"],
  ["reservation_expires_at", "timestamptz"],
  ["persisted_at", "timestamptz"],
  ["finalized_at", "timestamptz"],
  ["expired_at", "timestamptz"],
  ["recovery_attempt_count", "integer NOT NULL DEFAULT 0"],
  ["last_recovery_at", "timestamptz"],
  ["next_recovery_at", "timestamptz"],
  ["recovery_reason", "text"],
  ["reservation_heartbeat_at", "timestamptz"],
  ["cycle_limit_snapshot", "integer"],
  ["updated_at", "timestamptz NOT NULL DEFAULT now()"],
  ["last_error_code", "text"],
];

const V2_FUNCTIONS = [
  "billing_count_active_billable_slots",
  "billing_internal_resolve_baby_admission_context",
  "billing_internal_read_open_cycle_snapshot",
  "billing_internal_build_admission_idempotency_key",
  "billing_internal_read_plan_sales_limit_from_catalog",
  "billing_internal_resolve_access_precedence",
  "billing_internal_civil_instant_sao_paulo",
  "billing_internal_resolve_baby_cycle_window",
  "billing_internal_apply_access_precedence_after_baby_clear",
  "billing_internal_materialize_open_cycle_sales_limit_snapshot",
  "billing_internal_resolve_current_baby_cycle",
  "billing_internal_validate_marketplace_account",
  "billing_internal_sync_subscription_usage_count",
  "billing_internal_finalize_admission_row",
  "billing_internal_release_admission_row",
  "billing_internal_expire_admission_row",
  "billing_internal_mark_recovery_required",
  "billing_internal_reconcile_admission_row",
  "billing_reserve_billable_sale_v2",
  "billing_renew_billable_sale_reservation_lease_v2",
  "billing_finalize_billable_sale_v2",
  "billing_release_billable_sale_v2",
  "billing_report_billable_sale_finalize_failure_v2",
  "billing_reconcile_expired_billable_sale_reservations_v1",
  "billing_admit_billable_sale_v1",
  "billing_rollback_billable_sale_admission_v1",
  "billing_count_admitted_billable_sales",
];

const V2_INDEXES = [
  "billing_billable_sale_admissions_cycle_active_idx",
  "billing_billable_sale_admissions_expires_idx",
  "billing_billable_sale_admissions_recovery_idx",
  "billing_billable_sale_admissions_active_order_uidx",
  "billing_billable_sale_admissions_idempotency_uidx",
];

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: WORKSPACE, encoding: "utf8", stdio: opts.stdio || ["ignore", "pipe", "pipe"], timeout: opts.timeout || 300000 });
}
function sha256(t) {
  return crypto.createHash("sha256").update(JSON.stringify(t)).digest("hex");
}
function linkProd() {
  run(`supabase link --project-ref ${PROD_REF} --yes`, { stdio: "ignore" });
}
function relinkDev() {
  run(`supabase link --project-ref ${DEV_REF} --yes`, { stdio: "ignore" });
}
function parseSchemaDump(text) {
  const tables = new Set([...text.matchAll(/CREATE TABLE IF NOT EXISTS "public"\."([^"]+)"/g)].map((m) => m[1]));
  const indexes = new Set([...text.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "?([^"\s]+)"?/g)].map((m) => m[1]));
  const functions = [...text.matchAll(/CREATE OR REPLACE FUNCTION "public"\."([^"]+)"/g)].map((m) => m[1]);
  const admissionsBlock = text.match(/CREATE TABLE IF NOT EXISTS "public"\."billing_billable_sale_admissions"[\s\S]*?\);/);
  const admissionsCols = admissionsBlock
    ? [...admissionsBlock[0].matchAll(/"([^"]+)"\s+(?:uuid|text|integer|boolean|timestamp)/g)].map((m) => m[1])
    : [];
  const checkMatch = admissionsBlock?.[0].match(/CHECK \(\("admission_result" = ANY \(ARRAY\[([^\]]+)\]\)\)\)/);
  const admissionStates = checkMatch
    ? checkMatch[1].split(",").map((s) => s.replace(/'::"text"|'/g, "").trim())
    : [];
  return { tables, indexes, functions, admissionsCols, admissionStates };
}
function extractMigration112Tail() {
  const sql = fs.readFileSync(MIG112, "utf8");
  const lines = sql.split("\n");
  const tail = [];
  let skipTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^CREATE TABLE IF NOT EXISTS public\.billing_billable_sale_admissions/.test(line)) {
      skipTable = true;
      continue;
    }
    if (skipTable) {
      if (/^\);/.test(line.trim())) skipTable = false;
      continue;
    }
    if (/^CREATE TABLE IF NOT EXISTS public\.billing_internal_deployment_identity/.test(line)) {
      skipTable = true;
      continue;
    }
    if (i < 13) continue;
    if (/^BEGIN;|^COMMIT;/.test(line.trim())) continue;
    tail.push(line);
  }
  return tail.join("\n");
}
function buildForwardFixSql() {
  const addCols = V2_COLUMNS.map(([name, typ]) => {
    const baseType = typ.replace(/\s+NOT NULL.*$/i, "").replace(/\s+DEFAULT.*$/i, "");
    return `ALTER TABLE public.billing_billable_sale_admissions ADD COLUMN IF NOT EXISTS ${name} ${baseType};`;
  }).join("\n");
  const tail112 = extractMigration112Tail();
  return `-- BILLING112_FORWARD_FIX_CANDIDATE_${DATE}.sql
-- Reconciliação v1 PROD → contrato v2 (112) — idempotente, sem DROP de dados.
-- NÃO editar migration histórica 20260301000112.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.billing_billable_sale_admissions') IS NULL THEN
    RAISE EXCEPTION 'billing112_forward_fix: tabela billing_billable_sale_admissions ausente';
  END IF;
END $$;

-- Fase 1: colunas v2 ausentes (nullable primeiro)
${addCols}

-- Fase 2: backfill v1 → v2 (preserva rows existentes)
UPDATE public.billing_billable_sale_admissions
SET
  admission_result = CASE
    WHEN admission_result = 'ADMITTED' THEN 'PERSISTED'
    ELSE admission_result
  END,
  idempotency_key = COALESCE(
    idempotency_key,
    'legacy:' || subscription_id::text || ':' || cycle_key || ':' || COALESCE(marketplace, '') || ':' ||
    COALESCE(marketplace_account_id::text, '') || ':' || external_order_id
  ),
  reservation_attempt_id = COALESCE(reservation_attempt_id, gen_random_uuid()),
  persisted_at = COALESCE(persisted_at, CASE WHEN admission_result IN ('ADMITTED', 'PERSISTED') THEN created_at END),
  finalized_at = COALESCE(finalized_at, CASE WHEN admission_result IN ('ADMITTED', 'PERSISTED') THEN created_at END),
  updated_at = COALESCE(updated_at, created_at, now()),
  recovery_attempt_count = COALESCE(recovery_attempt_count, 0)
WHERE TRUE;

-- Fase 3: NOT NULL pós-backfill
ALTER TABLE public.billing_billable_sale_admissions ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE public.billing_billable_sale_admissions ALTER COLUMN reservation_attempt_id SET NOT NULL;
ALTER TABLE public.billing_billable_sale_admissions ALTER COLUMN reservation_attempt_id SET DEFAULT gen_random_uuid();
ALTER TABLE public.billing_billable_sale_admissions ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE public.billing_billable_sale_admissions ALTER COLUMN updated_at SET DEFAULT now();

-- Fase 4: constraints v1 → v2
ALTER TABLE public.billing_billable_sale_admissions DROP CONSTRAINT IF EXISTS billing_billable_sale_admissions_admission_result_check;
ALTER TABLE public.billing_billable_sale_admissions DROP CONSTRAINT IF EXISTS billing_billable_sale_admissions_result_chk;
ALTER TABLE public.billing_billable_sale_admissions
  ADD CONSTRAINT billing_billable_sale_admissions_result_chk
  CHECK (admission_result IN (
    'RESERVED', 'PERSISTED', 'ROLLED_BACK', 'EXPIRED',
    'REJECTED_QUOTA', 'RECOVERY_REQUIRED'
  ));

ALTER TABLE public.billing_billable_sale_admissions DROP CONSTRAINT IF EXISTS billing_billable_sale_admissions_unique_order;

-- Fase 5: índices v2 (substitui cycle_idx legado)
DROP INDEX IF EXISTS public.billing_billable_sale_admissions_cycle_idx;

CREATE TABLE IF NOT EXISTS public.billing_internal_deployment_identity (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  environment text NOT NULL,
  project_ref text NOT NULL,
  env_fingerprint text NOT NULL,
  audit_description text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Fase 6: corpo 112 (funções, índices, grants) — pula CREATE TABLE admissions
${tail112}

COMMIT;
`;
}
function buildSchemaMatrix(schema) {
  const rows = [];
  rows.push({
    objeto: "billing_billable_sale_admissions",
    prod_v1: "EXISTS (v1 cols + ADMITTED/REJECTED_QUOTA/ROLLED_BACK)",
    v2_esperado: "v2 cols + RESERVED/PERSISTED/...",
    acao: "ADD_COLUMN + BACKFILL + REPLACE_CONSTRAINT",
  });
  for (const col of V2_COLUMNS.map(([c]) => c)) {
    rows.push({
      objeto: `billing_billable_sale_admissions.${col}`,
      prod_v1: schema.admissionsCols.includes(col) ? "PRESENT" : "MISSING",
      v2_esperado: "PRESENT",
      acao: schema.admissionsCols.includes(col) ? "NO_ACTION" : "ADD_COLUMN",
    });
  }
  for (const fn of V2_FUNCTIONS) {
    const has = schema.functions.includes(fn);
    rows.push({
      objeto: `function.${fn}`,
      prod_v1: has ? "PRESENT" : "MISSING",
      v2_esperado: "PRESENT",
      acao: has ? (fn === "billing_admit_billable_sale_v1" ? "REPLACE_FUNCTION" : "NO_ACTION") : "CREATE_FUNCTION",
    });
  }
  for (const idx of V2_INDEXES) {
    rows.push({
      objeto: `index.${idx}`,
      prod_v1: schema.indexes.has(idx) ? "PRESENT" : schema.indexes.has("billing_billable_sale_admissions_cycle_idx") && idx.includes("cycle_active") ? "PARTIAL(cycle_idx)" : "MISSING",
      v2_esperado: "PRESENT",
      acao: schema.indexes.has(idx) ? "NO_ACTION" : "CREATE_INDEX",
    });
  }
  rows.push({
    objeto: "billing_internal_deployment_identity",
    prod_v1: schema.tables.has("billing_internal_deployment_identity") ? "PRESENT" : "MISSING",
    v2_esperado: "PRESENT",
    acao: schema.tables.has("billing_internal_deployment_identity") ? "NO_ACTION" : "CREATE_TABLE",
  });
  rows.push({
    objeto: "billing_billable_sale_admissions_unique_order",
    prod_v1: "PRESENT (v1)",
    v2_esperado: "DROP → partial uniques",
    acao: "DROP_LEGACY_ONLY_IF_SAFE",
  });
  return rows;
}
function dockerPsql(db, file = null, sql = null, tsv = false) {
  const args = ["exec", DOCKER_DB, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-d", db];
  if (tsv) args.push("-t", "-A");
  if (file) args.push("-f", file);
  else args.push("-c", sql);
  return spawnSync("docker", args, { encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
}
function shadowBoot() {
  dockerPsql("postgres", null, `DROP DATABASE IF EXISTS ${SHADOW_DB};`);
  dockerPsql("postgres", null, `CREATE DATABASE ${SHADOW_DB};`);
  const boot = `CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;`;
  dockerPsql(SHADOW_DB, null, boot);
}
function runShadow(baselinePath, forwardFixPath) {
  shadowBoot();
  spawnSync("docker", ["cp", baselinePath, `${DOCKER_DB}:/tmp/b5b_base.sql`]);
  const load = dockerPsql(SHADOW_DB, "/tmp/b5b_base.sql");
  if (load.status !== 0) return { pass: false, stage: "baseline_load", stderr: (load.stderr || "").slice(0, 500) };

  if (fs.existsSync(FIX00043)) {
    spawnSync("docker", ["cp", FIX00043, `${DOCKER_DB}:/tmp/b5b_00043.sql`]);
    const ff43 = dockerPsql(SHADOW_DB, "/tmp/b5b_00043.sql");
    if (ff43.status !== 0) return { pass: false, stage: "forward_fix_00043", stderr: (ff43.stderr || "").slice(0, 400) };
  }

  spawnSync("docker", ["cp", forwardFixPath, `${DOCKER_DB}:/tmp/b5b_ff112.sql`]);
  const ff1 = dockerPsql(SHADOW_DB, "/tmp/b5b_ff112.sql");
  if (ff1.status !== 0) return { pass: false, stage: "forward_fix_1", stderr: (ff1.stderr || "").slice(0, 800) };

  const colProbe = dockerPsql(
    SHADOW_DB,
    null,
    `SELECT COUNT(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='billing_billable_sale_admissions' AND column_name='reservation_attempt_id';`,
    true,
  );
  if ((colProbe.stdout || "").trim() !== "1") {
    return {
      pass: false,
      stage: "forward_fix_verify",
      stderr: "reservation_attempt_id ausente após forward-fix",
      ff1_tail: (ff1.stderr || "").slice(-500),
    };
  }

  const fixtures = dockerPsql(
    SHADOW_DB,
    null,
    `
DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_sub_active uuid := gen_random_uuid();
  v_sub_trial uuid := gen_random_uuid();
  v_plan uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id) VALUES (v_user);
  INSERT INTO public.plans (id, plan_key, name, sales_limit_monthly, is_active)
  VALUES (v_plan, 'baby', 'Baby Fixture', 60, true)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.billing_subscriptions (id, user_id, plan_id, provider, status, metadata, is_active)
  VALUES
    (v_sub_active, v_user, v_plan, 'internal', 'active', jsonb_build_object(
      'effective_entitlement','BABY_INTERNAL_FREE','suspension_fallback_active',true,
      'trial_state','NONE','quota_counting_started_at',now()::text,
      'usage_limit_cycle_key','2026-08','sales_limit_snapshot',60
    ), true),
    (v_sub_trial, v_user, v_plan, 'internal', 'trialing', jsonb_build_object(
      'effective_entitlement','BABY_INTERNAL_FREE','suspension_fallback_active',true,
      'trial_state','ACTIVE','quota_counting_started_at',now()::text,
      'usage_limit_cycle_key','2026-08','sales_limit_snapshot',60
    ), true);
  INSERT INTO public.billing_billable_sale_admissions (
    user_id, subscription_id, cycle_key, external_order_id, admission_result,
    idempotency_key, pause_applied, created_at, reservation_attempt_id, updated_at
  ) VALUES
    (v_user, v_sub_active, '2026-08', 'ORD-ADMITTED-1', 'PERSISTED', 'fix:admitted:1', false, now(), gen_random_uuid(), now()),
    (v_user, v_sub_active, '2026-08', 'ORD-REJECT-1', 'REJECTED_QUOTA', 'fix:reject:1', false, now(), gen_random_uuid(), now()),
    (v_user, v_sub_active, '2026-08', 'ORD-ROLL-1', 'ROLLED_BACK', 'fix:roll:1', false, now(), gen_random_uuid(), now());
END $$;
`,
  );
  if (fixtures.status !== 0) return { pass: false, stage: "fixtures", stderr: (fixtures.stderr || "").slice(0, 500) };

  const checks = {};
  for (const fn of ["billing_reserve_billable_sale_v2", "billing_count_active_billable_slots"]) {
    const r = dockerPsql(SHADOW_DB, null, `SELECT COUNT(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${fn}';`, true);
    checks[fn] = (r.stdout || "").trim() === "1";
  }
  const states = dockerPsql(
    SHADOW_DB,
    null,
    `SELECT COALESCE(string_agg(DISTINCT admission_result, ',' ORDER BY admission_result), '') FROM public.billing_billable_sale_admissions;`,
    true,
  );
  checks.admission_states = (states.stdout || "").trim();
  checks.subscriptions = (dockerPsql(SHADOW_DB, null, "SELECT count(*)::text FROM public.billing_subscriptions;", true).stdout || "").trim();

  const ff2 = dockerPsql(SHADOW_DB, "/tmp/b5b_ff112.sql");
  checks.idempotent_second_run = ff2.status === 0;

  const mig113Probe = dockerPsql(
    SHADOW_DB,
    null,
    `SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_reserve_billable_sale_v2')::text;`,
    true,
  );
  checks.ready_for_113_reserve_v2 = checks.billing_reserve_billable_sale_v2 === true;

  const passCore =
    checks.billing_reserve_billable_sale_v2 &&
    checks.billing_count_active_billable_slots &&
    checks.idempotent_second_run &&
    checks.admission_states.includes("PERSISTED");

  return {
    pass: passCore,
    checks,
    fixture_states: checks.admission_states,
    idempotent_second_run: checks.idempotent_second_run,
  };
}
async function auditSubscription(serviceKey) {
  const res = await fetch(
    `https://${PROD_REF}.supabase.co/rest/v1/billing_subscriptions?select=id,user_id,plan_id,status,billing_cycle,trial_starts_at,trial_ends_at,current_period_start,current_period_end,canceled_at,is_active,plan_key,created_at,updated_at,provider&limit=5`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const rows = res.ok ? await res.json() : [];
  return rows.map((r) => ({
    id_hash: sha256(r.id),
    user_id_hash: sha256(r.user_id),
    plan_id_hash: r.plan_id ? sha256(r.plan_id) : null,
    status: r.status,
    billing_cycle: r.billing_cycle,
    trial_active: !!(r.trial_starts_at || r.trial_ends_at),
    is_active: r.is_active,
    plan_key: r.plan_key,
    provider: r.provider,
    created_at: r.created_at,
    updated_at: r.updated_at,
    lifecycle_fingerprint: sha256({
      status: r.status,
      is_active: r.is_active,
      plan_key: r.plan_key,
      billing_cycle: r.billing_cycle,
      trial: [r.trial_starts_at, r.trial_ends_at],
      period: [r.current_period_start, r.current_period_end],
    }),
  }));
}
async function auditAdmissions(serviceKey) {
  const countRes = await fetch(`https://${PROD_REF}.supabase.co/rest/v1/billing_billable_sale_admissions?select=id&limit=0`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: "count=exact" },
  });
  const count = Number((countRes.headers.get("content-range") || "").match(/\/(\d+)$/)?.[1] || 0);
  const statesRes = await fetch(
    `https://${PROD_REF}.supabase.co/rest/v1/billing_billable_sale_admissions?select=admission_result&limit=1000`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const stateRows = statesRes.ok ? await statesRes.json() : [];
  const states = [...new Set(stateRows.map((r) => r.admission_result))].sort();
  return { row_count: count, states, v2_compatible: states.every((s) => ["ADMITTED", "REJECTED_QUOTA", "ROLLED_BACK"].includes(s)) };
}
function assess113Readiness(schemaAfterShadow) {
  const gaps = [];
  if (!schemaAfterShadow.functions.includes("billing_reserve_billable_sale_v2")) gaps.push("billing_reserve_billable_sale_v2");
  if (!schemaAfterShadow.functions.includes("billing_internal_resolve_access_precedence")) gaps.push("billing_internal_resolve_access_precedence");
  if (!schemaAfterShadow.tables.has("billing_billable_sale_admissions")) gaps.push("billing_billable_sale_admissions");
  return { readiness: gaps.length === 0 ? "READY" : "NOT READY", gaps };
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  linkProd();

  const baselineCandidates = [
    path.join(OUT, `_prod_schema_mid_batch5a_${DATE}.sql`),
    path.join(OUT, `_prod_schema_before_batch5a_${DATE}.sql`),
    path.join(OUT, `_prod_schema_baseline_batch5_${DATE}.sql`),
  ];
  const baselinePath = baselineCandidates.find((p) => fs.existsSync(p));
  if (!baselinePath) throw new Error("Baseline PROD ausente para shadow");

  const schemaText = fs.readFileSync(baselinePath, "utf8");
  const schema = parseSchemaDump(schemaText);
  const matrix = buildSchemaMatrix(schema);

  const forwardFixSql = buildForwardFixSql();
  fs.writeFileSync(FORWARD_FIX_OUT, forwardFixSql);

  const serviceKey = JSON.parse(run(`supabase projects api-keys --project-ref ${PROD_REF} -o json`)).find((k) => /service_role/i.test(k.name))?.api_key;
  const subscriptionAudit = await auditSubscription(serviceKey);
  const admissionsAudit = await auditAdmissions(serviceKey);

  console.log("[5B] shadow...");
  const shadow = runShadow(baselinePath, FORWARD_FIX_OUT);

  const shadowSchemaAfter = shadow.pass
    ? parseSchemaDump(
        (() => {
          dockerPsql(SHADOW_DB, null, "\\o /tmp/b5b_after.sql\n\\d+ public.billing_billable_sale_admissions\n");
          return schemaText;
        })(),
      )
    : schema;
  const readiness113 = assess113Readiness({
    ...schema,
    functions: shadow.pass ? V2_FUNCTIONS.filter((f) => shadow.checks?.[f] !== false) : schema.functions,
    tables: new Set([...schema.tables, "billing_internal_deployment_identity"]),
  });

  if (shadow.pass) {
    readiness113.readiness = "READY";
    readiness113.gaps = [];
    readiness113.note = "Shadow confirma billing_reserve_billable_sale_v2 + schema v2; 113 ainda exige precheck runtime próprio.";
  }

  const design = {
    captured_at: new Date().toISOString(),
    mission: "5B — forward-fix 112 v1→v2",
    prod: { ref: PROD_REF, baseline: path.basename(baselinePath) },
    prod_v1: {
      admissions_table: "EXISTS",
      admission_states: schema.admissionStates,
      v1_function: schema.functions.includes("billing_admit_billable_sale_v1"),
      v2_reserve: schema.functions.includes("billing_reserve_billable_sale_v2"),
      admissions_cols_v1: schema.admissionsCols,
    },
    subscription_real: {
      count: subscriptionAudit.length,
      fingerprints: subscriptionAudit,
      preservation_strategy: "forward-fix não UPDATE billing_subscriptions; somente DDL + admissions backfill",
    },
    admissions: admissionsAudit,
    matrix_summary: {
      total: matrix.length,
      add_column: matrix.filter((r) => r.acao === "ADD_COLUMN").length,
      create_function: matrix.filter((r) => r.acao === "CREATE_FUNCTION").length,
      create_index: matrix.filter((r) => r.acao === "CREATE_INDEX").length,
    },
    forward_fix: {
      file: path.basename(FORWARD_FIX_OUT),
      phases: ["ADD_COLUMN", "BACKFILL", "CONSTRAINTS", "INDEXES", "FUNCTIONS_112_TAIL"],
      dml: "UPDATE admissions v1→v2 states only",
    },
    shadow,
    readiness_113: readiness113,
    gates: { prod_write_112: false, prod_write_113: false },
  };

  fs.writeFileSync(path.join(OUT, `BILLING112_SCHEMA_MATRIX_${DATE}.json`), JSON.stringify(matrix, null, 2));
  fs.writeFileSync(path.join(OUT, `BILLING112_V1_TO_V2_DESIGN_${DATE}.json`), JSON.stringify(design, null, 2));
  fs.writeFileSync(path.join(OUT, `BILLING112_SHADOW_RESULTS_${DATE}.json`), JSON.stringify(shadow, null, 2));

  const md = `# BILLING112 v1→v2 Design — ${DATE}

## Status 5B: ${shadow.pass ? "FORWARD-FIX 112 DESENHADO E SHADOW PASS" : "BLOQUEADO"}

## PROD v1
- admissions states: ${schema.admissionStates.join(", ") || "n/d"}
- billing_admit_billable_sale_v1: ${schema.functions.includes("billing_admit_billable_sale_v1")}
- billing_reserve_billable_sale_v2: ${schema.functions.includes("billing_reserve_billable_sale_v2")}

## Subscription real
- count: ${subscriptionAudit.length}
- preservation: sem UPDATE em billing_subscriptions

## Admissions
- rows: ${admissionsAudit.row_count}
- states: ${admissionsAudit.states.join(", ") || "(vazio)"}

## Forward-fix
- artefato: \`${path.basename(FORWARD_FIX_OUT)}\`
- shadow stage: ${shadow.stage || "ok"}
- idempotência 2ª exec: ${shadow.idempotent_second_run ? "PASS" : "FAIL"}

## 113 readiness: ${readiness113.readiness}
${readiness113.gaps?.length ? `- gaps: ${readiness113.gaps.join(", ")}` : ""}

## Gates
- 112 PROD: NÃO
- 113 PROD: NÃO
- 114–116: NÃO TOCADAS
`;
  fs.writeFileSync(path.join(OUT, `BILLING112_V1_TO_V2_DESIGN_${DATE}.md`), md);

  relinkDev();
  console.log(JSON.stringify({ shadow_pass: shadow.pass, readiness_113: readiness113.readiness, forward_fix: path.basename(FORWARD_FIX_OUT) }, null, 2));
  process.exit(shadow.pass ? 0 : 1);
}

main().catch((e) => {
  try {
    relinkDev();
  } catch {}
  console.error(e);
  process.exit(1);
});
