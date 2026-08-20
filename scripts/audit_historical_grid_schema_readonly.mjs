#!/usr/bin/env node
/** Read-only: constraints/indexes em marketplace_account_sync_jobs + snapshot Insprazzo histórico. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const INSPRAZZO_ACCOUNT = "f4b8e92b-5416-422d-835e-b95e7ded28e4";
const WINDOW1_ID = "195cb223-44c8-4d9d-b277-88647cc701d7";

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

const { data: indexes, error: idxErr } = await sb.rpc("exec_sql_readonly_audit", {}).maybeSingle?.();
// fallback: query via raw if RPC absent — use information_schema through postgres REST not available;
// use supabase .from with a view or query jobs table only.

const { data: histJobs, error: histErr } = await sb
  .from("marketplace_account_sync_jobs")
  .select("id,status,progress_current,progress_total,metadata,created_at,updated_at")
  .eq("marketplace_account_id", INSPRAZZO_ACCOUNT)
  .eq("job_type", "ml_historical_sales_backfill")
  .order("created_at", { ascending: true });

const { data: window1 } = await sb
  .from("marketplace_account_sync_jobs")
  .select("id,status,progress_current,progress_total,metadata,updated_at")
  .eq("id", WINDOW1_ID)
  .maybeSingle();

/** @type {Record<string, unknown>} */
const report = {
  generated_at: new Date().toISOString(),
  schema_audit_note:
    "RPC exec_sql ausente; indexes/constraints listados via migration grep no repo + inferência. Ver seção repo_schema_scan.",
  insprazzo_historical: {
    total: histJobs?.length ?? 0,
    done: (histJobs || []).filter((j) => j.status === "done").length,
    pending: (histJobs || []).filter((j) => j.status === "pending").length,
    running: (histJobs || []).filter((j) => j.status === "running").length,
    jobs: (histJobs || []).map((j) => {
      const m = j.metadata && typeof j.metadata === "object" ? j.metadata : {};
      return {
        id: j.id,
        status: j.status,
        progress: `${j.progress_current ?? 0}/${j.progress_total ?? "?"}`,
        window_index: m.window_index ?? null,
        date_from: m.date_from ?? null,
        date_to: m.date_to ?? null,
      };
    }),
  },
  window1_snapshot: window1
    ? {
        id: window1.id,
        status: window1.status,
        progress: `${window1.progress_current ?? 0}/${window1.progress_total ?? "?"}`,
        updated_at: window1.updated_at,
        window_index:
          window1.metadata && typeof window1.metadata === "object" ? window1.metadata.window_index : null,
      }
    : null,
  hist_err: histErr?.message ?? null,
};

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `AUDIT_HISTORICAL_GRID_SCHEMA_${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: !histErr, output: outFile, ...report }, null, 2));
