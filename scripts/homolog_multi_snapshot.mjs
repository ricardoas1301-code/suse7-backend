#!/usr/bin/env node
/** Snapshot multi-target + sales idempotência (read-only). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";

const INSPRAZZO = "8b553445-5f5c-4dd5-b2d0-a7657cb6ee05";
const SUPER_METAL = "4e4acdca-8156-4875-871d-5e9d92727426";
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

async function jobSnap(id) {
  const { data } = await sb.from("marketplace_account_sync_jobs").select("*").eq("id", id).maybeSingle();
  if (!data) return null;
  const m = readJobMetadataObject(data);
  return {
    id: data.id,
    status: data.status,
    progress: `${data.progress_current}/${data.progress_total}`,
    progress_current: data.progress_current,
    last_cursor: data.last_cursor,
    updated_at: data.updated_at,
    lease_owner: m.lease_owner ?? null,
    heartbeat_at: m.heartbeat_at ?? null,
    lease_version: m.lease_version ?? null,
    recovery_count: m.recovery_count ?? 0,
  };
}

async function salesSnap(accountId) {
  const { data: rows } = await sb
    .from("sales_orders")
    .select("external_order_id")
    .eq("marketplace_account_id", accountId);
  const ids = (rows || []).map((r) => String(r.external_order_id || "").trim()).filter(Boolean);
  const unique = new Set(ids);
  const dupGroups = {};
  for (const id of ids) dupGroups[id] = (dupGroups[id] || 0) + 1;
  const logicalDups = Object.values(dupGroups).filter((c) => c > 1).length;
  return { total: ids.length, unique: unique.size, duplicate_logical_groups: logicalDups };
}

const label = process.argv[2] || "snapshot";
const report = {
  label,
  at: new Date().toISOString(),
  insprazzo: await jobSnap(INSPRAZZO),
  super_metal: await jobSnap(SUPER_METAL),
  sales_insprazzo: await salesSnap(INSPRAZZO_ACCOUNT),
};

console.log(JSON.stringify(report, null, 2));
