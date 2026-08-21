#!/usr/bin/env node
/** Snapshot read-only Window 3/4 + dry-run limit=1 (P0.2-M.1). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";
import { simulateGlobalSchedulerSelection } from "../src/services/marketplace/marketplaceAccountSyncWorker.js";

const WINDOW3_ID = "8f08e2c5-52ab-4e0d-b804-babf9feef6ef";
const WINDOW4_ID = "acf757c5-ed89-432e-9f56-fb13e7cc8986";
const INSPRAZZO_ACCOUNT = "f4b8e92b-5416-422d-835e-b95e7ded28e4";

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

async function snapJob(id) {
  const { data } = await sb.from("marketplace_account_sync_jobs").select("*").eq("id", id).maybeSingle();
  if (!data) return null;
  const m = readJobMetadataObject(data);
  return {
    job_id: data.id,
    status: data.status,
    progress: `${data.progress_current ?? 0}/${data.progress_total ?? "?"}`,
    progress_current: data.progress_current ?? 0,
    progress_total: data.progress_total ?? null,
    last_cursor: data.last_cursor ?? null,
    updated_at: data.updated_at,
    window_index: m.window_index ?? null,
    lease_owner: m.lease_owner ?? null,
    lease_version: m.lease_version ?? null,
    lease_claimed_at: m.lease_claimed_at ?? null,
    lease_expires_at: m.lease_expires_at ?? null,
    heartbeat_at: m.heartbeat_at ?? null,
    recovery_count: m.recovery_count ?? 0,
  };
}

const { data: hist } = await sb
  .from("marketplace_account_sync_jobs")
  .select("id,status,progress_current,progress_total,metadata,updated_at")
  .eq("marketplace_account_id", INSPRAZZO_ACCOUNT)
  .eq("job_type", "ml_historical_sales_backfill");

const dryRun = await simulateGlobalSchedulerSelection(sb, { limit: 1 });

console.log(
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      window3: await snapJob(WINDOW3_ID),
      window4: await snapJob(WINDOW4_ID),
      dry_run_limit_1: {
        candidate: dryRun.picks[0] ?? null,
        eligible_rank_2: dryRun.global_eligibility_order[1] ?? null,
      },
      grid_summary: {
        total: hist?.length ?? 0,
        done: (hist ?? []).filter((r) => r.status === "done").length,
        pending: (hist ?? []).filter((r) => r.status === "pending").length,
        running: (hist ?? []).filter((r) => r.status === "running").length,
      },
    },
    null,
    2
  )
);
