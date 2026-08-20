#!/usr/bin/env node
/** Inventário jobs por marketplace_account_id (read-only). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";

const accountId = process.argv[2];
if (!accountId) {
  console.error("usage: rca_list_account_jobs.mjs <marketplace_account_id>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const env = { ...parseEnvFile(path.join(root, ".env.local")), ...process.env };
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await sb
  .from("marketplace_account_sync_jobs")
  .select("id,job_type,status,progress_current,progress_total,last_cursor,updated_at,metadata")
  .eq("marketplace_account_id", accountId)
  .order("created_at", { ascending: true });

if (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
}

const jobs = (data ?? []).map((row) => {
  const m = readJobMetadataObject(row);
  return {
    id: row.id,
    job_type: row.job_type,
    status: row.status,
    progress: `${row.progress_current ?? 0}/${row.progress_total ?? "?"}`,
    last_cursor: row.last_cursor,
    updated_at: row.updated_at,
    lease_owner: m.lease_owner ?? null,
    recovery_count: m.recovery_count ?? 0,
  };
});

console.log(JSON.stringify({ ok: true, marketplace_account_id: accountId, jobs }, null, 2));
