#!/usr/bin/env node
/** RCA — snapshot de um job + conta (sem secrets). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";

const JOB_ID = process.argv[2];
if (!JOB_ID) {
  console.error("usage: rca_query_job.mjs <job_id>");
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

const { data: job } = await sb.from("marketplace_account_sync_jobs").select("*").eq("id", JOB_ID).maybeSingle();
if (!job) {
  console.log(JSON.stringify({ ok: false, error: "job_not_found", job_id: JOB_ID }, null, 2));
  process.exit(0);
}

const m = readJobMetadataObject(job);
let account = null;
if (job.marketplace_account_id) {
  const { data: acc } = await sb
    .from("marketplace_accounts")
    .select("id, alias, external_seller_id, seller_company_id, status, marketplace")
    .eq("id", job.marketplace_account_id)
    .maybeSingle();
  account = acc;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      job: {
        id: job.id,
        job_type: job.job_type,
        status: job.status,
        progress: `${job.progress_current}/${job.progress_total}`,
        last_cursor: job.last_cursor,
        updated_at: job.updated_at,
        marketplace_account_id: job.marketplace_account_id,
        lease_owner: m.lease_owner ?? null,
        recovery_count: m.recovery_count ?? 0,
      },
      account: account
        ? {
            id: account.id,
            alias: account.alias,
            external_seller_id: account.external_seller_id,
            marketplace: account.marketplace,
            status: account.status,
          }
        : null,
    },
    null,
    2
  )
);
