#!/usr/bin/env node
/**
 * Baseline read-only pré-promoção Hosted — Insprazzo + índice UNIQUE.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";

const EXPECTED_DEV_REF = "alkelcaoexxbamqddaqv";
const INSPRAZZO_ACCOUNT = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
const WINDOW1_ID = "195cb223-44c8-4d9d-b277-88647cc701d7";
const WINDOW2_ID = "fc2ee91d-1700-4aaa-87f2-91a8e12a9cdf";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(root, "..", "scripts", "output");

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

function refFromUrl(url) {
  try {
    const m = new URL(url).hostname.match(/^([a-z0-9]+)\.supabase\.co$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const env = { ...parseEnvFile(path.join(root, ".env.local")), ...parseEnvFile(path.join(root, ".env.vercel")), ...process.env };
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function snapJob(id) {
  const { data } = await sb.from("marketplace_account_sync_jobs").select("*").eq("id", id).maybeSingle();
  if (!data) return null;
  const m = readJobMetadataObject(data);
  return {
    id: data.id,
    status: data.status,
    progress: `${data.progress_current ?? 0}/${data.progress_total ?? "?"}`,
    last_cursor: data.last_cursor,
    updated_at: data.updated_at,
    window_index: m.window_index ?? null,
    date_from: m.date_from ?? null,
    date_to: m.date_to ?? null,
    lease_owner: m.lease_owner ?? null,
    lease_version: m.lease_version ?? null,
    heartbeat_at: m.heartbeat_at ?? null,
    recovery_count: m.recovery_count ?? 0,
  };
}

const { data: hist } = await sb
  .from("marketplace_account_sync_jobs")
  .select("id,status,progress_current,progress_total,metadata,updated_at")
  .eq("marketplace_account_id", INSPRAZZO_ACCOUNT)
  .eq("job_type", "ml_historical_sales_backfill");

const report = {
  generated_at: new Date().toISOString(),
  target: { project_ref: refFromUrl(env.SUPABASE_URL || ""), expected: EXPECTED_DEV_REF },
  git_head: process.env.GIT_HEAD || null,
  insprazzo_historical: {
    total: hist?.length ?? 0,
    done: (hist ?? []).filter((r) => r.status === "done").length,
    pending: (hist ?? []).filter((r) => r.status === "pending").length,
    running: (hist ?? []).filter((r) => r.status === "running").length,
  },
  window1: await snapJob(WINDOW1_ID),
  window2: await snapJob(WINDOW2_ID),
  unique_index_note: "marketplace_account_sync_jobs_hist_window_sem_uq applied via db query (DEV)",
};

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `BASELINE_PRE_HOSTED_PROMO_${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, output: outFile, ...report }, null, 2));
