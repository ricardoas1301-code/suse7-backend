#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.join(__dirname, "..");
const FRONTEND_ROOT = path.join(BACKEND_ROOT, "..", "suse7-frontend");

function listSql(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.startsWith("APPLY_MANUAL")).sort();
}

function getContainer() {
  return spawnSync("docker", ["ps", "--filter", "name=supabase_db_supabase-local-replay-workspace", "--format", "{{.Names}}"], {
    encoding: "utf8",
  })
    .stdout.trim()
    .split(/\r?\n/)
    .filter(Boolean)[0];
}

function psql(sql, container) {
  return spawnSync("docker", ["exec", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-c", sql], {
    encoding: "utf8",
  });
}

function psqlFile(filePath, container) {
  const content = fs.readFileSync(filePath, "utf8");
  return spawnSync(
    "docker",
    ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: content, encoding: "utf8" },
  );
}

const container = getContainer();
if (!container) {
  console.error("Supabase DB container not running");
  process.exit(2);
}

const log = JSON.parse(fs.readFileSync(path.join(__dirname, "output", "DEV_V2_SUPABASE_LOCAL_REPLAY_LOG_2026-08-13.json"), "utf8"));
const passed = log.replay_1.results.filter((r) => r.status === "PASS");
const chain = passed.map((r) =>
  r.repo === "suse7-frontend"
    ? path.join(FRONTEND_ROOT, "supabase/migrations", r.file)
    : path.join(BACKEND_ROOT, "supabase/migrations", r.file),
);

for (let i = 0; i < chain.length; i++) {
  const r = psqlFile(chain[i], container);
  if (r.status !== 0) {
    console.error(JSON.stringify({ fail: path.basename(chain[i]), stderr: r.stderr }));
    process.exit(1);
  }
}

const bucket = psql("SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id='company-logos'", container);
const objects = psql("SELECT count(*)::int AS c FROM storage.objects WHERE bucket_id='company-logos'", container);
const policies = psql(
  "SELECT polname, polcmd FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='storage' AND c.relname='objects' ORDER BY 1",
  container,
);

const pass =
  bucket.status === 0 &&
  bucket.stdout.includes("company-logos") &&
  bucket.stdout.includes("t") &&
  bucket.stdout.includes("5242880") &&
  bucket.stdout.includes("image/jpeg") &&
  objects.stdout.includes("0");

console.log(
  JSON.stringify(
    {
      pass,
      bucket: bucket.stdout.trim(),
      objects: objects.stdout.trim(),
      policies: policies.stdout.trim(),
    },
    null,
    2,
  ),
);
