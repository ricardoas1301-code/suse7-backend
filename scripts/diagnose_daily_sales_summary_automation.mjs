#!/usr/bin/env node
/**
 * Diagnóstico ponta a ponta — SALES:DAILY_SALES_SUMMARY
 * Uso: node scripts/diagnose_daily_sales_summary_automation.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function supabaseRest(pathname, serviceKey) {
  const base = SUPABASE_URL.replace(/\/+$/, "");
  const res = await fetch(`${base}/rest/v1/${pathname}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = val;
  }
  return out;
}

const beEnv = parseDotEnv(path.join(root, ".env"));
const beLocal = parseDotEnv(path.join(root, ".env.local"));

const JOB_URL =
  process.env.JOB_URL ||
  process.env.DEV_DAILY_SALES_SUMMARY_JOB_URL ||
  "https://suse7-backend-dev.vercel.app/api/jobs/daily-sales-summary-automation";
const JOB_SECRET =
  process.env.JOB_SECRET || process.env.DEV_JOB_SECRET || beEnv.JOB_SECRET || beLocal.JOB_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || beEnv.SUPABASE_URL || beLocal.SUPABASE_URL || "";
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  beEnv.SUPABASE_SERVICE_ROLE_KEY ||
  beLocal.SUPABASE_SERVICE_ROLE_KEY ||
  "";
const OVERRIDE_NOW = process.env.OVERRIDE_NOW || "";

console.log("=== S7 Daily Sales Summary — Diagnóstico ===\n");
console.log("[1] JOB_URL:", JOB_URL);
console.log("    JOB_SECRET:", JOB_SECRET ? `${JOB_SECRET.slice(0, 4)}…` : "(ausente)");

if (!JOB_SECRET) {
  console.error("JOB_SECRET ausente");
  process.exitCode = 1;
}

const body = { limit: 200 };
if (OVERRIDE_NOW) body.override_now = OVERRIDE_NOW;

const res = await fetch(JOB_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Job-Secret": JOB_SECRET },
  body: JSON.stringify(body),
});
console.log("\n[2] Job HTTP", res.status, await res.text());

if (SUPABASE_URL && SERVICE_KEY) {
  const runs = await supabaseRest(
    "s7_notification_automation_runs?type_key=eq.DAILY_SALES_SUMMARY&order=created_at.desc&limit=5&select=*",
    SERVICE_KEY
  );
  console.log("\n[3] Runs:", JSON.stringify(runs, null, 2));
}
