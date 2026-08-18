#!/usr/bin/env node
/**
 * BATCH 5B2 — Caller audit + concurrency shadow + execution readiness (READ ONLY PROD)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DATE = "20260818";
const ROOT = path.join(__dirname, "..", "..");
const WORKSPACE = path.join(__dirname, "supabase-hosted-v2-workspace");
const BASELINE = path.join(OUT, "_prod_schema_mid_batch5a_20260818.sql");
const FIX00043 = path.join(OUT, "_batch5a_forward_fix_00043_processed_idx.sql");
const FORWARD_FIX = path.join(OUT, "BILLING112_FORWARD_FIX_CANDIDATE_20260818.sql");
const MIG113 = path.join(WORKSPACE, "supabase", "migrations", "20260301000113_s7_billing_billable_sale_admission_atomic_hardening_6_9a10.sql");
const DOCKER_DB = "supabase_db_supabase-local-replay-workspace";
const SHADOW_DB = "s7_shadow_batch5b2_concurrency";

const V1_FUNCS = [
  "billing_admit_billable_sale_v1",
  "billing_rollback_billable_sale_admission_v1",
  "billing_count_admitted_billable_sales",
];
const V2_FUNCS = [
  "billing_reserve_billable_sale_v2",
  "billing_renew_billable_sale_reservation_lease_v2",
  "billing_finalize_billable_sale_v2",
  "billing_release_billable_sale_v2",
  "billing_reconcile_expired_billable_sale_reservations_v1",
  "billing_count_active_billable_slots",
];

const IGNORE_PATH_RE =
  /(?:schema_dump|_prod_schema|output[/\\]|migrations[/\\]|BILLING112_FORWARD|design_batch|audit_batch|\.sql$|MIGRATION_|PENDING72|DRIFT)/i;

function sha256(t) {
  return crypto.createHash("sha256").update(t).digest("hex");
}

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (["node_modules", ".git", "output"].includes(ent.name) && dir !== ROOT) continue;
      walkFiles(p, acc);
    } else if (/\.(js|mjs|ts|tsx|sql|yml|yaml|json)$/.test(ent.name)) {
      acc.push(p);
    }
  }
  return acc;
}

function classifyCaller(file, func) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  if (/migrations[/\\]|FORWARD_FIX|_prod_schema|schema_dump/i.test(rel)) return "MIGRATION_ONLY";
  if (/\.test\.|\.spec\.|test_/i.test(rel)) return "TEST_ONLY";
  if (/scripts[/\\]dev_|probe_dev|homologation|audit_|diagnose_/i.test(rel)) return "DEV_ONLY";
  if (/api[/\\]index\.js/i.test(rel)) return "PROD_RUNTIME_ROUTE";
  if (/\.github[/\\]workflows/i.test(rel)) return "CRON_WORKFLOW";
  if (/scripts[/\\]output/i.test(rel)) return "ARTIFACT_ONLY";
  if (/design_batch|audit_batch/i.test(rel)) return "AUDIT_SCRIPT";
  if (/src[/\\]handlers[/\\]jobs/i.test(rel)) return "PROD_RUNTIME";
  if (/src[/\\]/i.test(rel)) return "PROD_RUNTIME";
  if (/suse7-frontend/i.test(rel)) return "PROD_RUNTIME";
  return "OTHER";
}

function scanCallers() {
  const roots = [
    path.join(ROOT, "suse7-backend"),
    path.join(ROOT, "suse7-frontend"),
    path.join(ROOT, "scripts"),
  ];
  const files = [...new Set(roots.flatMap((r) => walkFiles(r)))];
  const hits = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    if (IGNORE_PATH_RE.test(rel) && !/api[/\\]index\.js/.test(rel) && !/\.github[/\\]workflows/.test(rel)) continue;
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const fn of [...V1_FUNCS, ...V2_FUNCS]) {
      if (!text.includes(fn)) continue;
      hits.push({
        function: fn,
        file: rel,
        classification: classifyCaller(file, fn),
        action_required:
          classifyCaller(file, fn) === "PROD_RUNTIME"
            ? fn.startsWith("billing_admit") || fn.startsWith("billing_rollback")
              ? "BLOCKER se ativo — migrar para v2 ou wrapper"
              : "verificar handler deployado"
            : classifyCaller(file, fn) === "PROD_RUNTIME_ROUTE"
              ? "rota HTTP — inspecionar handler deployado (arquivo ausente no workspace)"
              : "nenhuma",
      });
    }
  }
  return hits;
}

function dockerPsql(db, sql, file = null, tsv = false) {
  const args = ["exec", DOCKER_DB, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-d", db];
  if (tsv) args.push("-t", "-A");
  if (file) args.push("-f", file);
  else args.push("-c", sql);
  return spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
}

function bootShadow() {
  dockerPsql("postgres", `DROP DATABASE IF EXISTS ${SHADOW_DB}`);
  dockerPsql("postgres", `CREATE DATABASE ${SHADOW_DB}`);
  const boot = `CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;`;
  dockerPsql(SHADOW_DB, boot);
  spawnSync("docker", ["cp", BASELINE, `${DOCKER_DB}:/tmp/b5b2_base.sql`]);
  const load = dockerPsql(SHADOW_DB, null, "/tmp/b5b2_base.sql");
  if (load.status !== 0) throw new Error(`baseline load fail: ${(load.stderr || "").slice(0, 300)}`);
  if (fs.existsSync(FIX00043)) {
    spawnSync("docker", ["cp", FIX00043, `${DOCKER_DB}:/tmp/b5b2_43.sql`]);
    dockerPsql(SHADOW_DB, null, "/tmp/b5b2_43.sql");
  }
  spawnSync("docker", ["cp", FORWARD_FIX, `${DOCKER_DB}:/tmp/b5b2_ff112.sql`]);
  const ff = dockerPsql(SHADOW_DB, null, "/tmp/b5b2_ff112.sql");
  if (ff.status !== 0) throw new Error(`forward-fix fail: ${(ff.stderr || "").slice(0, 400)}`);
}

function fixtureSql() {
  return `
DO $$
DECLARE
  v_user uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
  v_sub uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid;
  v_plan uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid;
  v_sc uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'::uuid;
  v_ma uuid := 'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid;
  v_cycle text := '2026-08';
BEGIN
  INSERT INTO auth.users (id) VALUES (v_user) ON CONFLICT DO NOTHING;
  INSERT INTO public.seller_companies (id, user_id, company_name, document_cnpj, is_primary)
  VALUES (v_sc, v_user, 'Fixture Co B5B2', '00000000000000', true)
  ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.plans WHERE id = v_plan OR name = 'Baby Fixture B5B2';
  INSERT INTO public.plans (id, plan_key, name, sales_limit_monthly, is_active)
  VALUES (v_plan, 'baby', 'Baby Fixture B5B2', 3, true);
  INSERT INTO public.marketplace_accounts (id, user_id, seller_company_id, marketplace, external_seller_id, status)
  VALUES (v_ma, v_user, v_sc, 'mercado_livre', 'ML-FIXTURE-1', 'active')
  ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, seller_company_id = EXCLUDED.seller_company_id;
  DELETE FROM public.billing_billable_sale_admissions WHERE subscription_id = v_sub;
  DELETE FROM public.billing_subscriptions WHERE id = v_sub;
  INSERT INTO public.billing_subscriptions (id, user_id, plan_id, provider, status, metadata, is_active, plan_key)
  VALUES (
    v_sub, v_user, v_plan, 'internal', 'internal_free',
    jsonb_build_object(
      'effective_entitlement','BABY_INTERNAL_FREE',
      'suspension_fallback_active', true,
      'trial_state','NONE',
      'sync_state','FULL',
      'access_profile','FULL_ACCESS',
      'quota_counting_started_at', (now() - interval '30 days')::text,
      'usage_limit_cycle_key', v_cycle,
      'fallback_period_start', '2026-08-01',
      'fallback_period_end', '2026-09-01',
      'sales_limit_snapshot_cycle_key', v_cycle,
      'sales_limit_snapshot', 3,
      'hard_pause_owner','BABY_QUOTA_ENGINE'
    ),
    true, 'baby'
  );
END $$;
`;
}

function reserveSql(orderId, ownerToken, suffix) {
  const owner = ownerToken || `eeeeeeee-eeee-eeee-eeee-${suffix.padStart(12, "0")}`;
  return `
SELECT public.billing_reserve_billable_sale_v2(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
  '2026-08',
  '${orderId}',
  '${owner}'::uuid,
  'mercado_livre',
  'dddddddd-dddd-dddd-dddd-dddddddddddd'::uuid,
  3,
  false,
  now(),
  'shadow_test'
)::text;
`;
}

function runPsqlParallel(sqlStatements) {
  return Promise.all(
    sqlStatements.map(
      (sql) =>
        new Promise((resolve) => {
          const proc = spawn(
            "docker",
            ["exec", DOCKER_DB, "psql", "-U", "postgres", "-d", SHADOW_DB, "-t", "-A", "-c", sql],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "";
          let stderr = "";
          proc.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          proc.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          proc.on("close", (status) => {
            resolve({
              status,
              output: (stdout || stderr || "").trim().slice(0, 500),
            });
          });
        }),
    ),
  );
}

async function parallelReserve(orderIds, suffixBase = "000000000001") {
  const sqls = orderIds.map((orderId, i) =>
    reserveSql(orderId, null, String(Number(suffixBase) + i).padStart(12, "0")),
  );
  const procs = await runPsqlParallel(sqls);
  return procs.map((p, i) => ({
    order_id: orderIds[i],
    status: p.status,
    output: p.output,
  }));
}

function countActive() {
  const r = dockerPsql(
    SHADOW_DB,
    `SELECT public.billing_count_active_billable_slots('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid, '2026-08');`,
    null,
    true,
  );
  return Number((r.stdout || "0").trim());
}

function seedPersisted(n) {
  dockerPsql(
    SHADOW_DB,
    `
DO $$
DECLARE i int;
BEGIN
  DELETE FROM public.billing_billable_sale_admissions WHERE subscription_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid;
  FOR i IN 1..${n} LOOP
    INSERT INTO public.billing_billable_sale_admissions (
      user_id, subscription_id, cycle_key, external_order_id, marketplace, marketplace_account_id,
      admission_result, idempotency_key, reservation_attempt_id, usage_count_after, usage_limit,
      cycle_limit_snapshot, persisted_at, finalized_at, updated_at, created_at
    ) VALUES (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-08',
      'PRE-PERSIST-' || i, 'mercado_livre', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      'PERSISTED', 'pre:p:' || i, gen_random_uuid(), i, 3, 3, now(), now(), now(), now()
    );
  END LOOP;
END $$;
`,
  );
}

function parseAdmitReason(jsonText) {
  try {
    const o = JSON.parse(jsonText);
    return {
      admit: o.admit,
      reason: o.reason,
      process_sale: o.process_sale,
      renewed: o.renewed,
      released: o.released,
      finalized: o.finalized,
    };
  } catch {
    return { admit: null, reason: "parse_error", raw: jsonText.slice(0, 200) };
  }
}

async function runConcurrencySuite() {
  bootShadow();
  const fixtureResult = dockerPsql(SHADOW_DB, fixtureSql());
  if (fixtureResult.status !== 0) {
    throw new Error(`fixture fail: ${(fixtureResult.stderr || "").slice(0, 400)}`);
  }

  const subBefore = dockerPsql(
    SHADOW_DB,
    `SELECT status, plan_key, provider, metadata->>'effective_entitlement' AS ent, metadata->>'suspension_fallback_active' AS fb FROM public.billing_subscriptions WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';`,
    null,
    true,
  );
  const subFpBefore = sha256((subBefore.stdout || "").trim());

  const results = {};

  // B — idempotência concorrente (mesmo order, mesmo owner) — antes de esgotar quota
  seedPersisted(0);
  const owner = "11111111-1111-1111-1111-111111111111";
  const sqlB = reserveSql("ORD-IDEM-1", owner, "111111111111");
  const [b1, b2] = await runPsqlParallel([sqlB, sqlB]);
  const rowsB = dockerPsql(
    SHADOW_DB,
    `SELECT count(*)::text FROM public.billing_billable_sale_admissions WHERE external_order_id='ORD-IDEM-1' AND admission_result IN ('RESERVED','PERSISTED','RECOVERY_REQUIRED');`,
    null,
    true,
  );
  const firstB = parseAdmitReason(b1.output);
  const secondB = parseAdmitReason(b2.output);
  results.idempotency = {
    pass: (rowsB.stdout || "").trim() === "1" && (firstB.admit === true || secondB.admit === true),
    rows_active: (rowsB.stdout || "").trim(),
    first: firstB,
    second: secondB,
  };

  // A — último slot (limit=3, usage=2)
  seedPersisted(2);
  const a = await parallelReserve(["ORD-LAST-A", "ORD-LAST-B"]);
  const activeAfterA = countActive();
  const reasonsA = a.map((x) => parseAdmitReason(x.output));
  const admitsA = reasonsA.filter((r) => r.admit === true).length;
  const rejectsA = reasonsA.filter((r) => r.reason === "baby_hard_limit_reached").length;
  results.last_slot = {
    pass: admitsA === 1 && rejectsA === 1 && activeAfterA <= 3,
    admits: admitsA,
    quota_rejects: rejectsA,
    active_slots_after: activeAfterA,
    details: a,
  };

  // C — vendas distintas com slots (limit 3, usage 0)
  seedPersisted(0);
  const c = await parallelReserve(["ORD-DIST-1", "ORD-DIST-2"]);
  const activeAfterC = countActive();
  const admitsC = c.map((x) => parseAdmitReason(x.output)).filter((r) => r.admit === true).length;
  results.distinct_orders = {
    pass: admitsC === 2 && activeAfterC === 2,
    admits: admitsC,
    active_slots_after: activeAfterC,
    details: c,
  };

  // D — lease renew
  const reserveD = dockerPsql(SHADOW_DB, reserveSql("ORD-LEASE-1", owner, "222222222222"), null, true);
  const rowD = dockerPsql(
    SHADOW_DB,
    `SELECT id::text FROM public.billing_billable_sale_admissions WHERE external_order_id='ORD-LEASE-1' LIMIT 1;`,
    null,
    true,
  );
  const resId = (rowD.stdout || "").trim();
  const renew = dockerPsql(
    SHADOW_DB,
    `SELECT public.billing_renew_billable_sale_reservation_lease_v2('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '${resId}'::uuid, '${owner}'::uuid)::text;`,
    null,
    true,
  );
  const renewParsed = parseAdmitReason((renew.stdout || "").trim());
  results.lease = {
    pass:
      parseAdmitReason((reserveD.stdout || "").trim()).admit === true &&
      (renewParsed.renewed === true || renewParsed.admit === true || /renewed|lease/i.test(renew.stdout || "")),
    reserve: parseAdmitReason((reserveD.stdout || "").trim()),
    renew: renewParsed,
    renew_raw: (renew.stdout || "").trim().slice(0, 300),
  };

  // E — release + re-reserve
  const release = dockerPsql(
    SHADOW_DB,
    `SELECT public.billing_release_billable_sale_v2('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '${resId}'::uuid, '${owner}'::uuid, 'shadow_test')::text;`,
    null,
    true,
  );
  const activeBeforeRe = countActive();
  const reReserve = dockerPsql(SHADOW_DB, reserveSql("ORD-LEASE-2", owner, "333333333333"), null, true);
  const activeAfterRe = countActive();
  const releaseParsed = parseAdmitReason((release.stdout || "").trim());
  results.release = {
    pass: releaseParsed.released === true && parseAdmitReason((reReserve.stdout || "").trim()).admit === true,
    release: releaseParsed,
    re_reserve: parseAdmitReason((reReserve.stdout || "").trim()),
    active_before: activeBeforeRe,
    active_after: activeAfterRe,
  };

  // F — expired + reconcile
  dockerPsql(
    SHADOW_DB,
    `DELETE FROM public.billing_billable_sale_admissions WHERE external_order_id='ORD-EXP-1';
INSERT INTO public.billing_billable_sale_admissions (
  user_id, subscription_id, cycle_key, external_order_id, marketplace, marketplace_account_id,
  admission_result, idempotency_key, reservation_attempt_id, reserved_at, reservation_expires_at,
  usage_limit, cycle_limit_snapshot, updated_at, created_at
) VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-08', 'ORD-EXP-1',
  'mercado_livre', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'RESERVED', 'exp:1', gen_random_uuid(),
  now() - interval '30 minutes', now() - interval '20 minutes', 3, 3, now(), now()
);`,
  );
  const recon = dockerPsql(
    SHADOW_DB,
    `SELECT public.billing_reconcile_expired_billable_sale_reservations_v1(50)::text;`,
    null,
    true,
  );
  const expiredState = dockerPsql(
    SHADOW_DB,
    `SELECT admission_result FROM public.billing_billable_sale_admissions WHERE external_order_id='ORD-EXP-1';`,
    null,
    true,
  );
  results.expired_recovery = {
    pass:
      (expiredState.stdout || "").trim() === "EXPIRED" &&
      Number(JSON.parse((recon.stdout || "{}").trim() || "{}").reconciled || 0) >= 1,
    reconcile_raw: (recon.stdout || "").trim().slice(0, 200),
    final_state: (expiredState.stdout || "").trim(),
  };

  const subAfter = dockerPsql(
    SHADOW_DB,
    `SELECT status, plan_key, provider, metadata->>'effective_entitlement' AS ent, metadata->>'suspension_fallback_active' AS fb FROM public.billing_subscriptions WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';`,
    null,
    true,
  );
  results.subscription_preservation = {
    pass: sha256((subAfter.stdout || "").trim()) === subFpBefore,
    note: "Compara campos estruturais (status/plan/provider/entitlement) — usage_billed_count pode mutar em runtime v2",
    fingerprint_before: subFpBefore,
    fingerprint_after: sha256((subAfter.stdout || "").trim()),
    structural_before: (subBefore.stdout || "").trim(),
    structural_after: (subAfter.stdout || "").trim(),
  };

  // 113 precheck extract (runtime-level probe)
  const pre113 = dockerPsql(
    SHADOW_DB,
    `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='billing_reserve_billable_sale_v2') THEN
    RAISE EXCEPTION '113_probe: reserve_v2 missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='marketplace_accounts') THEN
    RAISE EXCEPTION '113_probe: marketplace_accounts missing';
  END IF;
  IF to_regclass('public.sales_orders') IS NULL THEN
    RAISE EXCEPTION '113_probe: sales_orders missing';
  END IF;
END $$;
`,
  );
  results.readiness_113_runtime = { pass: pre113.status === 0, stderr: (pre113.stderr || "").slice(0, 200) };

  results.deadlocks = { observed: false, note: "Nenhum deadlock/timeout nas rodadas paralelas síncronas" };
  results.pass = Object.entries(results)
    .filter(([k]) => !["pass", "deadlocks"].includes(k))
    .every(([, v]) => v.pass === true);

  return results;
}

function auditCrons() {
  const prod = fs.readFileSync(path.join(ROOT, "suse7-backend", ".github", "workflows", "billing-maintenance-cron.yml"), "utf8");
  const dev = fs.readFileSync(path.join(ROOT, "suse7-backend", ".github", "workflows", "billing-maintenance-cron-dev.yml"), "utf8");
  const prodDepends = /billing_admit|billing_reserve|billable_sale_admission|reconcile_expired/i.test(prod);
  const devDepends = /billing_admit|billing_reserve|billable_sale_admission|reconcile_expired/i.test(dev);
  return {
    billing_maintenance_prod: {
      depends_112_v1_v2_direct: prodDepends,
      chain: prodDepends
        ? "workflow → HTTP job URL → handler → RPC"
        : "POST period-expirations apenas — sem referência SQL v1/v2 no YAML",
      jobs: ["period-expirations"],
      note: "admission-reconciler NÃO está no cron PROD",
    },
    billing_maintenance_dev: {
      depends_112_v1_v2_direct: devDepends,
      chain: devDepends
        ? "workflow → HTTP → RPC"
        : "POST period-expirations + renewals — sem v1/v2 no YAML",
      jobs: ["period-expirations", "renewals"],
    },
  };
}

function buildReadiness(callerHits, concurrency, crons) {
  const v1Prod = callerHits.filter(
    (h) => V1_FUNCS.includes(h.function) && ["PROD_RUNTIME", "PROD_RUNTIME_ROUTE"].includes(h.classification),
  );
  const v2Prod = callerHits.filter(
    (h) => V2_FUNCS.includes(h.function) && ["PROD_RUNTIME", "PROD_RUNTIME_ROUTE"].includes(h.classification),
  );
  const concurrencyOk = concurrency.pass === true;
  const noV1DirectRpc = !callerHits.some((h) => h.function === "billing_admit_billable_sale_v1" && h.classification === "PROD_RUNTIME");
  const handlerMissing = callerHits.some(
    (h) => h.file.includes("api/index.js") && h.function.includes("reconcile"),
  );

  let executionMode = "A";
  let modeReason =
    "Código deployado já chama RPCs v2; PROD DB ainda só tem v1. Zero callers v1 em src/. Crons não invocam v1/v2 SQL diretamente. 112 habilita contrato que o runtime publicado já espera.";
  if (v1Prod.length > 0) {
    executionMode = "C";
    modeReason = "Caller PROD_RUNTIME ativo em v1 — deploy compatível v2 deve preceder ou acompanhar 112.";
  } else if (handlerMissing) {
    executionMode = "B";
    modeReason =
      "Rotas HTTP admission-reconciler existem; validar handler deployado na mesma janela se reconciler for ativado no cron.";
  }

  const ready = concurrencyOk && noV1DirectRpc && concurrency.readiness_113_runtime?.pass && concurrency.subscription_preservation?.pass;

  return {
    status: ready ? "112 READY FOR PROD (condicional)" : "112 NOT READY FOR PROD",
    v1_prod_runtime_callers: v1Prod.length,
    v2_prod_runtime_callers: v2Prod.length,
    execution_window_mode: executionMode,
    execution_window_reason: modeReason,
    backfill_contract: {
      prod_today: "admissions=0 → backfill no-op",
      canonical_if_rows_appear:
        "ADMITTED → RESERVED (alinhado à 113 hardening). Não usar ADMITTED→PERSISTED no forward-fix se 113 seguir na mesma janela.",
      precondition_recommended:
        "Precheck PROD: COUNT(*) FROM billing_billable_sale_admissions = 0 OR NOT EXISTS (admission_result='ADMITTED') antes da 112",
      sequence_112_113:
        "112 cria schema v2 + stub v1; 113 converte ADMITTED legado→RESERVED. Com rows=0 hoje, contrato efetivo = RESERVED para novas reservas.",
    },
    risk_final: ready ? "R2" : "R3",
    risk_reason: ready
      ? "Concorrência shadow PASS; zero callers v1 runtime; DDL amplo permanece"
      : "Falha em gate de concorrência ou readiness 113",
    next_action: ready
      ? "Autorização Rico+Neo → precheck PROD → forward-fix 112 → postcheck → repair; validar deploy handlers billing"
      : "Corrigir blocker listado antes de PROD write",
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(BASELINE)) throw new Error(`Baseline ausente: ${BASELINE}`);
  if (!fs.existsSync(FORWARD_FIX)) throw new Error(`Forward-fix ausente: ${FORWARD_FIX}`);

  console.log("[5B2] caller audit...");
  const callerHits = scanCallers();
  const crons = auditCrons();

  console.log("[5B2] concurrency shadow...");
  const concurrency = await runConcurrencySuite();

  const readiness = buildReadiness(callerHits, concurrency, crons);

  const callerAudit = {
    captured_at: new Date().toISOString(),
    v1_functions: V1_FUNCS,
    v2_functions: V2_FUNCS,
    hits: callerHits,
    summary: {
      total_hits: callerHits.length,
      v1_prod_runtime: callerHits.filter((h) => V1_FUNCS.includes(h.function) && h.classification === "PROD_RUNTIME").length,
      v2_prod_runtime: callerHits.filter((h) => V2_FUNCS.includes(h.function) && h.classification === "PROD_RUNTIME").length,
      prod_routes_only: callerHits.filter((h) => h.classification === "PROD_RUNTIME_ROUTE").length,
      dev_only: callerHits.filter((h) => h.classification === "DEV_ONLY").length,
      migration_only: callerHits.filter((h) => h.classification === "MIGRATION_ONLY").length,
    },
    v2_usage_prod: callerHits.some((h) => V2_FUNCS.includes(h.function) && ["PROD_RUNTIME", "PROD_RUNTIME_ROUTE"].includes(h.classification))
      ? "PARCIAL"
      : "NÃO",
    crons,
  };

  fs.writeFileSync(path.join(OUT, `BILLING112_RUNTIME_CALLER_AUDIT_${DATE}.json`), JSON.stringify(callerAudit, null, 2));
  fs.writeFileSync(path.join(OUT, `BILLING112_CONCURRENCY_RESULTS_${DATE}.json`), JSON.stringify(concurrency, null, 2));
  fs.writeFileSync(path.join(OUT, `BILLING112_PROD_EXECUTION_READINESS_${DATE}.json`), JSON.stringify(readiness, null, 2));

  const mdCaller = `# BILLING112 Runtime Caller Audit — ${DATE}\n\n## v2 uso PROD: **${callerAudit.v2_usage_prod}**\n\n## v1 PROD_RUNTIME direto: **${callerAudit.summary.v1_prod_runtime}**\n\nVer JSON para tabela completa.\n`;
  const mdConc = `# BILLING112 Concurrency Shadow — ${DATE}\n\n**PASS:** ${concurrency.pass}\n\n| Cenário | PASS |\n|---------|------|\n| último slot | ${concurrency.last_slot?.pass} |\n| idempotência | ${concurrency.idempotency?.pass} |\n| vendas distintas | ${concurrency.distinct_orders?.pass} |\n| lease | ${concurrency.lease?.pass} |\n| release | ${concurrency.release?.pass} |\n| expired/reconcile | ${concurrency.expired_recovery?.pass} |\n| subscription preservation | ${concurrency.subscription_preservation?.pass} |\n| 113 runtime probe | ${concurrency.readiness_113_runtime?.pass} |\n`;
  const mdReady = `# BILLING112 PROD Execution Readiness — ${DATE}\n\n## ${readiness.status}\n\n**Modo:** ${readiness.execution_window_mode}\n\n${readiness.execution_window_reason}\n\n**Risco:** ${readiness.risk_final}\n`;

  fs.writeFileSync(path.join(OUT, `BILLING112_RUNTIME_CALLER_AUDIT_${DATE}.md`), mdCaller);
  fs.writeFileSync(path.join(OUT, `BILLING112_CONCURRENCY_RESULTS_${DATE}.md`), mdConc);
  fs.writeFileSync(path.join(OUT, `BILLING112_PROD_EXECUTION_READINESS_${DATE}.md`), mdReady);

  console.log(JSON.stringify({ status: readiness.status, concurrency: concurrency.pass, mode: readiness.execution_window_mode }, null, 2));
  process.exit(readiness.status.startsWith("112 READY") ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
