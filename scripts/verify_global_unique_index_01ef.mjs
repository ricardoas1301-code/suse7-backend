#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_FILE = path.join(__dirname, "output", ".dev_v2_hosted_secrets.local");
const INDEX_NAME = "marketplace_accounts_global_active_external_uidx";
const PROJECT_REF = "alkelcaoexxbamqddaqv";

const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
if (secrets.project_ref !== PROJECT_REF) throw new Error("project_ref mismatch");

const client = new pg.Client({
  host: `db.${PROJECT_REF}.supabase.co`,
  port: 5432,
  database: "postgres",
  user: "postgres",
  password: secrets.db_password,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const r = await client.query(
  `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
  [INDEX_NAME],
);
await client.end();
console.log(JSON.stringify({ index_present: r.rows.length > 0, rows: r.rows }, null, 2));
