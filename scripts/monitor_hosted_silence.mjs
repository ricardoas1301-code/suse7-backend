#!/usr/bin/env node
/** Monitor silêncio Hosted — jobs ML updated_at (read-only). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const INSPRAZZO = "8b553445-5f5c-4dd5-b2d0-a7657cb6ee05";
const SUPER_METAL = "4e4acdca-8156-4875-871d-5e9d92727426";
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

async function probe(label) {
  const ids = [INSPRAZZO, SUPER_METAL];
  const { data: jobs } = await sb.from("marketplace_account_sync_jobs").select("*").in("id", ids);
  const { data: recent } = await sb
    .from("marketplace_account_sync_jobs")
    .select("id,job_type,status,updated_at,marketplace_account_id,metadata")
    .eq("marketplace", "mercado_livre")
    .in("status", ["pending", "running"])
    .order("updated_at", { ascending: false })
    .limit(15);
  return {
    label,
    at: new Date().toISOString(),
    targets: (jobs || []).map((j) => {
      const m = j.metadata && typeof j.metadata === "object" ? j.metadata : {};
      return {
        id: j.id,
        status: j.status,
        progress: `${j.progress_current}/${j.progress_total}`,
        last_cursor: j.last_cursor,
        updated_at: j.updated_at,
        error_message: j.error_message,
        lease_owner: m.lease_owner ?? null,
        recovery_count: m.recovery_count ?? 0,
      };
    }),
    active_pool_head: (recent || []).map((r) => ({
      id: r.id,
      status: r.status,
      updated_at: r.updated_at,
      lease_owner: r.metadata?.lease_owner ?? null,
    })),
  };
}

const waitSec = parseInt(process.argv[2] || "130", 10);
const t0 = await probe("T0_immediate_after_main_push");
console.log(JSON.stringify({ phase: "T0", ...t0 }, null, 2));
await new Promise((r) => setTimeout(r, waitSec * 1000));
const t1 = await probe(`T1_after_${waitSec}s`);
const changed = [];
for (const a of t0.targets) {
  const b = t1.targets.find((x) => x.id === a.id);
  if (b && b.updated_at !== a.updated_at) changed.push({ id: a.id, from: a.updated_at, to: b.updated_at, status_from: a.status, status_to: b.status });
}
for (const a of t0.active_pool_head) {
  const b = t1.active_pool_head.find((x) => x.id === a.id);
  if (b && b.updated_at !== a.updated_at && !changed.find((c) => c.id === a.id)) {
    changed.push({ id: a.id, from: a.updated_at, to: b.updated_at, pool: true });
  }
}
const report = {
  generated_at: new Date().toISOString(),
  wait_seconds: waitSec,
  commit_a_main_sha: "2eda27b31d3af55be024447aecdedc49d8fa311b",
  hosted_silent: changed.length === 0,
  job_updates_detected: changed,
  T0: t0,
  T1: t1,
};
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `HOSTED_SILENCE_MONITOR_${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, output: out, hosted_silent: report.hosted_silent, changes: changed.length }));
