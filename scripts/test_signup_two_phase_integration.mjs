#!/usr/bin/env node
/**
 * DEV.V2.SIGNUP-TWOPHASE-IMPLEMENTATION.18 — integration (Supabase Local quando disponível)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const root = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = join(root, "supabase-local-replay-workspace");
const MIGRATION = join(root, "../supabase/migrations/20260813200000_s7_signup_pending_births_two_phase.sql");

/** @type {string[]} */
const failures = [];
const results = { pass: false, skipped: false, reason: null, checks: {} };

function assert(name, cond) {
  if (!cond) failures.push(name);
}

function dockerDbContainer() {
  const r = spawnSync(
    "docker",
    ["ps", "--filter", "name=supabase_db_supabase-local-replay-workspace", "--format", "{{.Names}}"],
    { encoding: "utf8" }
  );
  return (r.stdout || "").trim().split(/\r?\n/).find(Boolean) ?? null;
}

function psqlLocal(sql) {
  const container = dockerDbContainer();
  if (!container) return { ok: false, reason: "no_local_db" };
  const r = spawnSync(
    "docker",
    ["exec", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  if (r.status !== 0) return { ok: false, reason: r.stderr || r.stdout };
  return { ok: true, stdout: (r.stdout || "").trim() };
}

async function main() {
  if (!existsSync(MIGRATION)) {
    results.skipped = true;
    results.reason = "migration_missing";
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const container = dockerDbContainer();
  if (!container) {
    results.skipped = true;
    results.reason = "supabase_local_not_running";
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const migSql = readFileSync(MIGRATION, "utf8");
  const apply = spawnSync(
    "docker",
    ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: migSql, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );
  assert("migration applies cleanly", apply.status === 0);
  results.checks.migration_apply = apply.status === 0;

  const fnExists = psqlLocal(
    "SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='s7_complete_signup_birth_once')"
  );
  assert("public completion RPC exists", fnExists.ok && fnExists.stdout === "t");
  results.checks.completion_rpc = fnExists.stdout === "t";

  const tableExists = psqlLocal(
    "SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='s7_private' AND table_name='signup_pending_births')"
  );
  assert("s7_private.signup_pending_births exists", tableExists.ok && tableExists.stdout === "t");
  results.checks.pending_table = tableExists.stdout === "t";

  const secCheck = psqlLocal(`
    SELECT COUNT(*)::int FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 's7_signup_%'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  `);
  assert("anon cannot execute signup RPCs", secCheck.ok && secCheck.stdout === "0");
  results.checks.anon_rpc_execute = secCheck.stdout === "0";

  results.pass = failures.length === 0;
  results.failures = failures;
  console.log(JSON.stringify(results, null, 2));
  if (!results.pass && !results.skipped) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
