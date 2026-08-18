#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "output");
const DOCKER_DB = "supabase_db_supabase-local-replay-workspace";
const SHADOW_DB = "s7_shadow_batch3b_verify";
const MIGRATIONS_DIR = path.join(__dirname, "supabase-hosted-v2-workspace", "supabase", "migrations");

function dp(sql, db, file = null) {
  const args = ["exec", DOCKER_DB, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-d", db];
  if (file) args.push("-f", file);
  else args.push("-c", sql);
  return spawnSync("docker", args, { encoding: "utf8", timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
}

const baseline = path.join(OUT, "_prod_schema_after_batch3a_20260817.sql");
dp("DROP DATABASE IF EXISTS " + SHADOW_DB + ";", "postgres");
dp("CREATE DATABASE " + SHADOW_DB + ";", "postgres");
dp(
  `CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE IF NOT EXISTS storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text, name text, owner uuid);`,
  SHADOW_DB,
);
spawnSync("docker", ["cp", baseline, `${DOCKER_DB}:/tmp/batch3b_baseline.sql`]);
const load = dp("", SHADOW_DB, "/tmp/batch3b_baseline.sql");
console.log("load", load.status, (load.stderr || "").slice(0, 200));

const steps = [
  [path.join(MIGRATIONS_DIR, "20260301000003_normalized_sku_unique.sql"), "00003"],
  [path.join(OUT, "_00003_gap_uq_products_user_normalized_sku.sql"), "00003_gap"],
  [path.join(OUT, "_shadow_forward_fix_20260301000008.sql"), "00008_ff"],
  [path.join(MIGRATIONS_DIR, "20260301000061_storage_company_logos_bucket.sql"), "00061"],
];

let allPass = true;
for (const [file, label] of steps) {
  spawnSync("docker", ["cp", file, `${DOCKER_DB}:/tmp/${label}.sql`]);
  const r = dp("", SHADOW_DB, `/tmp/${label}.sql`);
  const pass = r.status === 0;
  console.log(label, pass ? "PASS" : "FAIL", (r.stderr || "").slice(0, 300));
  if (!pass) allPass = false;
}
process.exit(allPass ? 0 : 1);
