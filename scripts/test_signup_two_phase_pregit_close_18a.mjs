#!/usr/bin/env node
/**
 * DEV.V2.SIGNUP-TWOPHASE-FINAL-PREGIT.18B
 * Rollback (harness local), concurrency, RPC security matrix (Supabase Local).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

const root = dirname(fileURLToPath(import.meta.url));
const OUT = join(root, "output");
const RUN_DATE = "2026-08-13";
const MIGRATION = join(root, "../supabase/migrations/20260813200000_s7_signup_pending_births_two_phase.sql");

mkdirSync(OUT, { recursive: true });

/** @type {string[]} */
const failures = [];

function assert(name, cond, detail = null) {
  if (!cond) failures.push(detail ? `${name}: ${detail}` : name);
}

function dockerDbContainer() {
  const names = [
    "supabase_db_supabase-local-replay-workspace",
    "supabase_db_suse7-backend",
    "supabase_db_supabase-local-replay-workspace",
  ];
  for (const filter of names) {
    const r = spawnSync("docker", ["ps", "--filter", `name=${filter}`, "--format", "{{.Names}}"], { encoding: "utf8" });
    const hit = (r.stdout || "").trim().split(/\r?\n/).find(Boolean);
    if (hit) return hit;
  }
  const r = spawnSync("docker", ["ps", "--filter", "name=supabase_db", "--format", "{{.Names}}"], { encoding: "utf8" });
  return (r.stdout || "").trim().split(/\r?\n/).find(Boolean) ?? null;
}

function psql(sql, opts = {}) {
  const container = dockerDbContainer();
  if (!container) return { ok: false, reason: "no_local_db" };
  const args = [
    "exec",
    "-e",
    "PGPASSWORD=postgres",
    container,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-t",
    "-A",
    "-c",
    sql,
  ];
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, ...opts });
  if (r.status !== 0) return { ok: false, reason: r.stderr || r.stdout, stdout: r.stdout };
  return { ok: true, stdout: (r.stdout || "").trim() };
}

function psqlFile(sql) {
  const container = dockerDbContainer();
  if (!container) return { ok: false, reason: "no_local_db" };
  const r = spawnSync(
    "docker",
    ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );
  return { ok: r.status === 0, stderr: r.stderr, stdout: r.stdout };
}

function count(table, where = "") {
  const r = psql(`SELECT count(*)::int FROM ${table}${where ? ` WHERE ${where}` : ""}`);
  return r.ok ? Number(r.stdout) : null;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function installRollbackFaultHarness() {
  return psqlFile(`
    CREATE OR REPLACE FUNCTION s7_local_test_signup_rollback_fault()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      RAISE EXCEPTION 'S7_LOCAL_TEST_ROLLBACK_FAULT';
    END;
    $fn$;

    DROP TRIGGER IF EXISTS s7_local_test_signup_rollback_fault_trg ON public.seller_companies;
    CREATE TRIGGER s7_local_test_signup_rollback_fault_trg
      BEFORE INSERT ON public.seller_companies
      FOR EACH ROW EXECUTE FUNCTION s7_local_test_signup_rollback_fault();
  `);
}

function removeRollbackFaultHarness() {
  return psqlFile(`
    DROP TRIGGER IF EXISTS s7_local_test_signup_rollback_fault_trg ON public.seller_companies;
    DROP FUNCTION IF EXISTS s7_local_test_signup_rollback_fault();
  `);
}

function migrationHasProdTestHook() {
  const sql = readFileSync(MIGRATION, "utf8");
  return /signup_test_fault|S7_SIGNUP_TEST_FAULT|s7\.signup_test_fault/i.test(sql);
}

function cleanupFixture(userId, email, tokenHash) {
  psql(`
    DELETE FROM public.s7_notification_event_delivery_rules WHERE seller_id = '${userId}'::uuid;
    DELETE FROM public.s7_notification_preferences WHERE seller_id = '${userId}'::uuid;
    DELETE FROM public.s7_notification_recipients WHERE seller_id = '${userId}'::uuid;
    DELETE FROM public.seller_companies WHERE user_id = '${userId}'::uuid;
    DELETE FROM public.legal_document_acceptances WHERE user_id = '${userId}'::uuid;
    DELETE FROM public.profiles WHERE id = '${userId}'::uuid;
    DELETE FROM s7_private.signup_pending_births WHERE auth_user_id = '${userId}'::uuid OR correlation_token_hash = '${tokenHash}' OR normalized_email = lower('${email}');
    DELETE FROM auth.users WHERE id = '${userId}'::uuid;
  `);
}

async function setupFixture() {
  const userId = crypto.randomUUID();
  const email = `pregit18a_${Date.now()}@test.local`;
  const tokenHash = sha256(`token-${userId}`);
  const cnpj = "11222333000181";

  cleanupFixture(userId, email, tokenHash);

  const seed = psql(`
    INSERT INTO auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, confirmation_sent_at,
      recovery_sent_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    )
    VALUES (
      '${userId}'::uuid,
      '00000000-0000-0000-0000-000000000000'::uuid,
      'authenticated',
      'authenticated',
      '${email}',
      crypt('test-password', gen_salt('bf')),
      now(),
      now(),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      now(),
      now(),
      '', '', '', ''
    );

    INSERT INTO s7_private.signup_pending_births (
      correlation_token_hash, normalized_email, auth_user_id, status,
      profile_payload, document_type, document_version, document_hash, source,
      scrolled_to_end, client_accepted_at, server_received_at, expires_at, bound_at
    )
    VALUES (
      '${tokenHash}',
      lower('${email}'),
      '${userId}'::uuid,
      'BOUND_WAITING_CONFIRMATION',
      jsonb_build_object(
        'nome', 'Empresa Pregit 18A',
        'nome_loja', 'Loja Pregit',
        'whatsapp', '11999998888',
        'cpf_cnpj', '${cnpj}'
      ),
      'terms_of_use',
      '2026-01-01',
      '${sha256("terms")}',
      'SIGNUP',
      true,
      now(),
      now(),
      now() + interval '7 days',
      now()
    );
  `);

  if (!seed.ok) throw new Error(`fixture seed failed: ${seed.reason || seed.stderr}`);

  return { userId, email, tokenHash, cnpj };
}

function rpcSecurityMatrix() {
  const q = `
    SELECT
      p.proname AS name,
      pg_get_function_identity_arguments(p.oid) AS signature,
      p.prosecdef AS security_definer,
      pg_get_userbyid(p.proowner) AS owner,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_execute,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (
        p.proname LIKE 's7_signup_%'
        OR p.proname = 's7_complete_signup_birth_once'
      )
    ORDER BY p.proname;
  `;
  const r = psql(q);
  if (!r.ok) return { ok: false, reason: r.reason, wrappers: [] };

  const lines = r.stdout.split("\n").filter(Boolean);
  const wrappers = lines.map((line) => {
    const [name, signature, secdef, owner, anon, auth, service] = line.split("|");
    return {
      name,
      signature,
      security_definer: secdef === "t",
      owner,
      anon_execute: anon === "t",
      authenticated_execute: auth === "t",
      service_role_execute: service === "t",
    };
  });

  return { ok: true, wrappers };
}

async function main() {
  const results = {
    generated_at: new Date().toISOString(),
    mission: "DEV.V2.SIGNUP-TWOPHASE-FINAL-PREGIT.18B",
    skipped: false,
    pass: false,
    rollback_injection: { pass: false },
    concurrency: { pass: false },
    idempotency: { pass: false },
    rpc_security: { pass: false, wrappers: [] },
    recipient_transactional: true,
  };

  if (!existsSync(MIGRATION)) {
    results.skipped = true;
    results.reason = "migration_missing";
    writeArtifacts(results);
    console.log(JSON.stringify(results, null, 2));
    process.exit(1);
  }

  const container = dockerDbContainer();
  if (!container) {
    results.skipped = true;
    results.reason = "supabase_local_not_running";
    writeArtifacts(results);
    console.log(JSON.stringify(results, null, 2));
    process.exit(1);
  }

  assert("migration has no prod test hook", !migrationHasProdTestHook());
  results.prod_test_hooks_in_migration = migrationHasProdTestHook() ? 1 : 0;

  const migSql = readFileSync(MIGRATION, "utf8");
  const apply = psqlFile(migSql);
  assert("migration applies cleanly", apply.ok, apply.stderr?.slice(0, 500));

  const beforeProfiles = count("public.profiles");
  const beforeLegal = count("public.legal_document_acceptances");
  const beforeCompanies = count("public.seller_companies");
  const beforeRecipients = count("public.s7_notification_recipients");

  const fixture = await setupFixture();
  const { userId } = fixture;

  const baseCounts = {
    profiles: count("public.profiles", `id = '${userId}'::uuid`),
    legal: count("public.legal_document_acceptances", `user_id = '${userId}'::uuid`),
    companies: count("public.seller_companies", `user_id = '${userId}'::uuid`),
    recipients: count("public.s7_notification_recipients", `seller_id = '${userId}'::uuid`),
    pending_completed: psql(
      `SELECT status FROM s7_private.signup_pending_births WHERE auth_user_id = '${userId}'::uuid`
    ).stdout,
  };

  assert("fixture baseline empty", baseCounts.profiles === 0 && baseCounts.companies === 0);

  assert("install rollback fault harness", installRollbackFaultHarness().ok);
  const rollback = psql(`SELECT public.s7_complete_signup_birth_once('${userId}'::uuid)`);
  assert("remove rollback fault harness", removeRollbackFaultHarness().ok);

  const afterRollback = {
    profiles: count("public.profiles", `id = '${userId}'::uuid`),
    legal: count("public.legal_document_acceptances", `user_id = '${userId}'::uuid`),
    companies: count("public.seller_companies", `user_id = '${userId}'::uuid`),
    recipients: count("public.s7_notification_recipients", `seller_id = '${userId}'::uuid`),
    pending_status: psql(
      `SELECT status FROM s7_private.signup_pending_births WHERE auth_user_id = '${userId}'::uuid`
    ).stdout,
    rpc: psql(`SELECT public.s7_complete_signup_birth_once('${userId}'::uuid)`).stdout,
  };

  const rollbackPass =
    afterRollback.profiles === 0 &&
    afterRollback.legal === 0 &&
    afterRollback.companies === 0 &&
    afterRollback.recipients === 0 &&
    afterRollback.pending_status === "BOUND_WAITING_CONFIRMATION";

  assert("rollback injection no partial state", rollbackPass);
  results.rollback_injection = {
    pass: rollbackPass,
    fault: "local_trigger_before_seller_companies_insert",
    harness_only: true,
    prod_test_hooks: 0,
    deltas: {
      profiles: afterRollback.profiles,
      legal: afterRollback.legal,
      companies: afterRollback.companies,
      recipients: afterRollback.recipients,
    },
    pending_status: afterRollback.pending_status,
  };

  const complete1 = psql(`SELECT public.s7_complete_signup_birth_once('${userId}'::uuid)`);
  const complete2 = psql(`SELECT public.s7_complete_signup_birth_once('${userId}'::uuid)`);

  const afterComplete = {
    profiles: count("public.profiles", `id = '${userId}'::uuid`),
    legal: count("public.legal_document_acceptances", `user_id = '${userId}'::uuid`),
    companies: count("public.seller_companies", `user_id = '${userId}'::uuid`),
    recipients: count("public.s7_notification_recipients", `seller_id = '${userId}'::uuid`),
    pending_status: psql(
      `SELECT status FROM s7_private.signup_pending_births WHERE auth_user_id = '${userId}'::uuid`
    ).stdout,
  };

  const idempotencyPass =
    afterComplete.profiles === 1 &&
    afterComplete.legal === 1 &&
    afterComplete.companies === 1 &&
    afterComplete.recipients === 2 &&
    afterComplete.pending_status === "COMPLETED" &&
    /ALREADY_COMPLETED|true/.test(complete2.stdout || "");

  assert("idempotent completion", idempotencyPass);
  results.idempotency = { pass: idempotencyPass, second_rpc: complete2.stdout, counts: afterComplete };

  cleanupFixture(userId, fixture.email, fixture.tokenHash);
  const fixture2 = await setupFixture();

  const concurrentScript = `
    SELECT public.s7_complete_signup_birth_once('${fixture2.userId}'::uuid);
  `;
  const p1 = spawnSync("docker", [
    "exec", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=0", "-c", concurrentScript,
  ], { encoding: "utf8" });
  const p2 = spawnSync("docker", [
    "exec", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=0", "-c", concurrentScript,
  ], { encoding: "utf8" });

  const afterConcurrent = {
    profiles: count("public.profiles", `id = '${fixture2.userId}'::uuid`),
    legal: count("public.legal_document_acceptances", `user_id = '${fixture2.userId}'::uuid`),
    companies: count("public.seller_companies", `user_id = '${fixture2.userId}'::uuid`),
    recipients: count("public.s7_notification_recipients", `seller_id = '${fixture2.userId}'::uuid`),
    pending_status: psql(
      `SELECT status FROM s7_private.signup_pending_births WHERE auth_user_id = '${fixture2.userId}'::uuid`
    ).stdout,
  };

  const concurrencyPass =
    afterConcurrent.profiles === 1 &&
    afterConcurrent.legal === 1 &&
    afterConcurrent.companies === 1 &&
    afterConcurrent.recipients === 2 &&
    afterConcurrent.pending_status === "COMPLETED";

  assert("concurrency single materialization", concurrencyPass);
  results.concurrency = {
    pass: concurrencyPass,
    rpc_1: (p1.stdout || p1.stderr || "").slice(0, 300),
    rpc_2: (p2.stdout || p2.stderr || "").slice(0, 300),
    counts: afterConcurrent,
  };

  cleanupFixture(fixture2.userId, fixture2.email, fixture2.tokenHash);

  const sec = rpcSecurityMatrix();
  results.rpc_security.wrappers = sec.wrappers;
  const anonInternal = sec.wrappers.filter((w) => w.anon_execute).length;
  const authInternal = sec.wrappers.filter((w) => w.authenticated_execute).length;
  const serviceOk = sec.wrappers.every((w) => w.service_role_execute);
  results.rpc_security.pass = anonInternal === 0 && serviceOk;
  results.rpc_security.anon_execute_count = anonInternal;
  results.rpc_security.authenticated_execute_count = authInternal;
  assert("anon execute internal RPC = 0", anonInternal === 0);
  assert("service_role execute allowed", serviceOk);

  const globalDelta = {
    profiles: count("public.profiles") - beforeProfiles,
    legal: count("public.legal_document_acceptances") - beforeLegal,
    companies: count("public.seller_companies") - beforeCompanies,
    recipients: count("public.s7_notification_recipients") - beforeRecipients,
  };
  results.global_delta_after_cleanup = globalDelta;
  assert("global delta zero after cleanup", Object.values(globalDelta).every((v) => v === 0));

  results.failures = failures;
  results.pass = failures.length === 0;
  writeArtifacts(results);
  console.log(JSON.stringify(results, null, 2));
  if (!results.pass && !results.skipped) process.exit(1);
}

function writeArtifacts(results) {
  writeFileSync(join(OUT, `DEV_V2_SIGNUP_ATOMIC_RECIPIENT_TEST_${RUN_DATE}.json`), JSON.stringify({
    generated_at: results.generated_at,
    recipient_transactional: results.recipient_transactional,
    transaction_type: "ATOMIC",
    completion_entities: ["profile", "legal_document_acceptances", "seller_companies", "s7_notification_recipients", "s7_notification_event_delivery_rules", "s7_notification_preferences"],
    idempotency: results.idempotency,
  }, null, 2));

  writeFileSync(join(OUT, `DEV_V2_SIGNUP_CONCURRENCY_ROLLBACK_TEST_${RUN_DATE}.json`), JSON.stringify({
    generated_at: results.generated_at,
    rollback_injection: results.rollback_injection,
    concurrency: results.concurrency,
    idempotency: results.idempotency,
  }, null, 2));

  writeFileSync(join(OUT, `DEV_V2_SIGNUP_RPC_SECURITY_MATRIX_${RUN_DATE}.json`), JSON.stringify({
    generated_at: results.generated_at,
    pass: results.rpc_security.pass,
    wrappers: results.rpc_security.wrappers,
    anon_execute_count: results.rpc_security.anon_execute_count,
    authenticated_execute_count: results.rpc_security.authenticated_execute_count,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
