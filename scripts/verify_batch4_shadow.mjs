#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DOCKER_DB = "supabase_db_supabase-local-replay-workspace";
const SHADOW_DB = "s7_shadow_batch4_verify";
const MIGRATIONS_DIR = path.join(__dirname, "supabase-hosted-v2-workspace", "supabase", "migrations");
const BASELINE = path.join(OUT, "_prod_schema_after_batch3b_20260817.sql");

const FILES = {
  "20260301000118": "20260301000118_legal_document_acceptances.sql",
  "20260301000119": "20260301000119_s7_security_exposure_preconnect_hardening.sql",
  "20260301000120": "20260301000120_s7_signup_pending_births_two_phase.sql",
  "20260301000121": "20260301000121_profiles_onboarding_configuration_latches.sql",
  "20260301000122": "20260301000122_marketplace_accounts_global_ml_external_active_uidx.sql",
};

function dp(sql, db, file = null) {
  const args = ["exec", DOCKER_DB, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-d", db];
  if (file) args.push("-f", file);
  else args.push("-c", sql);
  return spawnSync("docker", args, { encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
}

dp(`DROP DATABASE IF EXISTS ${SHADOW_DB};`, "postgres");
dp(`CREATE DATABASE ${SHADOW_DB};`, "postgres");
dp(
  `CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, email_confirmed_at timestamptz, confirmed_at timestamptz);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
GRANT USAGE ON SCHEMA auth TO postgres;`,
  SHADOW_DB,
);
spawnSync("docker", ["cp", BASELINE, `${DOCKER_DB}:/tmp/b4base.sql`]);
const load = dp("", SHADOW_DB, "/tmp/b4base.sql");
console.log("load", load.status, (load.stderr || "").slice(0, 200));

let allPass = true;
for (const [v, file] of Object.entries(FILES)) {
  const local = path.join(MIGRATIONS_DIR, file);
  spawnSync("docker", ["cp", local, `${DOCKER_DB}:/tmp/${v}.sql`]);
  const r = dp("", SHADOW_DB, `/tmp/${v}.sql`);
  const pass = r.status === 0;
  console.log(v, pass ? "PASS" : "FAIL", (r.stderr || "").slice(0, 300));
  if (!pass) allPass = false;
}
process.exit(allPass ? 0 : 1);
