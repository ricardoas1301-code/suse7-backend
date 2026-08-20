#!/usr/bin/env node
/** Gate pós-sweep / pós-drain — Insprazzo + idempotência (read-only). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const JOB_ID = "8b553445-5f5c-4dd5-b2d0-a7657cb6ee05";
const ACCOUNT_ID = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
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
const meta = job?.metadata && typeof job.metadata === "object" ? job.metadata : {};

const { data: orders } = await sb
  .from("sales_orders")
  .select("external_order_id")
  .eq("marketplace_account_id", ACCOUNT_ID);

const ids = (orders || []).map((o) => String(o.external_order_id || "").trim()).filter(Boolean);
const unique = new Set(ids);

const report = {
  at: new Date().toISOString(),
  job: {
    status: job?.status,
    progress: `${job?.progress_current}/${job?.progress_total}`,
    last_cursor: job?.last_cursor,
    updated_at: job?.updated_at,
    error_message: job?.error_message,
    lease_owner: meta.lease_owner ?? null,
    lease_version: meta.lease_version ?? null,
    heartbeat_at: meta.heartbeat_at ?? null,
    lease_expires_at: meta.lease_expires_at ?? null,
    recovery_count: meta.recovery_count ?? 0,
    last_heartbeat_reason: meta.last_heartbeat_reason ?? null,
  },
  sales_orders: {
    total: ids.length,
    unique_external_ids: unique.size,
    duplicate_logical: ids.length - unique.size,
  },
};

console.log(JSON.stringify(report, null, 2));
