#!/usr/bin/env node
/**
 * Monitor 360s Hosted — windows Insprazzo 1–9 + window1 (read-only).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { readJobMetadataObject } from "../src/services/marketplace/marketplaceSyncJobLease.js";

const INSPRAZZO_ACCOUNT = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
const WINDOW1_ID = "195cb223-44c8-4d9d-b277-88647cc701d7";
const WINDOW2_ID = "fc2ee91d-1700-4aaa-87f2-91a8e12a9cdf";

const waitSec = parseInt(process.argv[2] || "360", 10);
const pollSec = parseInt(process.argv[3] || "45", 10);

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

const env = { ...parseEnvFile(path.join(root, ".env.local")), ...process.env };
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function snapHist(label) {
  const { data } = await sb
    .from("marketplace_account_sync_jobs")
    .select("id,status,progress_current,progress_total,updated_at,metadata,last_cursor")
    .eq("marketplace_account_id", INSPRAZZO_ACCOUNT)
    .eq("job_type", "ml_historical_sales_backfill")
    .order("created_at", { ascending: true });
  return {
    label,
    at: new Date().toISOString(),
    jobs: (data ?? []).map((r) => {
      const m = readJobMetadataObject(r);
      return {
        id: r.id,
        window_index: m.window_index ?? null,
        status: r.status,
        progress: `${r.progress_current ?? 0}/${r.progress_total ?? "?"}`,
        updated_at: r.updated_at,
        lease_owner: m.lease_owner ?? null,
      };
    }),
    window1: (data ?? []).find((r) => r.id === WINDOW1_ID),
    window2: (data ?? []).find((r) => r.id === WINDOW2_ID),
  };
}

/** @type {Awaited<ReturnType<typeof snapHist>>[]} */
const polls = [];
const t0 = await snapHist("T0");
polls.push(t0);
const endAt = Date.now() + waitSec * 1000;
while (Date.now() < endAt) {
  await new Promise((r) => setTimeout(r, pollSec * 1000));
  polls.push(await snapHist(`poll_${polls.length}`));
}
const tFinal = polls[polls.length - 1];

const changes = [];
for (const job of t0.jobs) {
  const later = tFinal.jobs.find((j) => j.id === job.id);
  if (later && (later.updated_at !== job.updated_at || later.status !== job.status || later.progress !== job.progress)) {
    changes.push({ id: job.id, window_index: job.window_index, from: job, to: later });
  }
}

const report = {
  generated_at: new Date().toISOString(),
  wait_seconds: waitSec,
  poll_seconds: pollSec,
  hosted_silent: changes.length === 0,
  changes,
  window1_unchanged:
    tFinal.window1?.status === "pending" &&
    String(tFinal.window1?.updated_at) === String(t0.window1?.updated_at),
  window2_unchanged:
    tFinal.window2?.status === "pending" &&
    String(tFinal.window2?.updated_at) === String(t0.window2?.updated_at),
  polls,
};

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `HOSTED_SILENCE_360_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    { ok: report.hosted_silent, output: outFile, hosted_silent: report.hosted_silent, changes: changes.length },
    null,
    2
  )
);
process.exit(report.hosted_silent ? 0 : 2);
