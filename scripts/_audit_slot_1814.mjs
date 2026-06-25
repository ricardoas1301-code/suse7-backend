#!/usr/bin/env node
/** Auditoria slot 18:14 BRT — somente leitura */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

const env = { ...parseDotEnv(path.join(root, ".env")), ...parseDotEnv(path.join(root, ".env.local")) };
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const url = (process.env.SUPABASE_URL || env.SUPABASE_URL || "").replace(/\/+$/, "");

async function q(pathname) {
  const res = await fetch(`${url}/rest/v1/${pathname}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  return res.json();
}

const SELLER = "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";

console.log("=== AUDIT 18:14 BRT ===\n");

const rule = await q(
  `s7_notification_automation_rules?seller_id=eq.${SELLER}&type_key=eq.DAILY_SALES_SUMMARY&select=*`
);
console.log("[RULE]", JSON.stringify(rule[0] ?? null, null, 2));

for (const slot of [
  "2026-06-17T21:14:00+00:00",
  "2026-06-17T21:15:00+00:00",
  "2026-06-17T21:10:00+00:00",
]) {
  const runs = await q(
    `s7_notification_automation_runs?scheduled_at=eq.${encodeURIComponent(slot)}&select=id,status,event_id,created_at,scheduled_at,metadata`
  );
  console.log(`\n[SLOT ${slot}]`, runs.length ? runs[0] : "NOT FOUND");
}

const windowRuns = await q(
  "s7_notification_automation_runs?created_at=gte.2026-06-17T21:10:00&created_at=lte.2026-06-17T21:25:00&select=id,status,event_id,created_at,scheduled_at,metadata&order=created_at.asc"
);
console.log("\n[RUNS 21:10-21:25 UTC]", JSON.stringify(windowRuns, null, 2));

const allRuns = await q(
  "s7_notification_automation_runs?type_key=eq.DAILY_SALES_SUMMARY&order=created_at.desc&limit=15&select=id,status,event_id,created_at,scheduled_at,metadata"
);
console.log("\n[LAST 15 RUNS]", JSON.stringify(allRuns, null, 2));

const afterRule = await q(
  "s7_notification_automation_runs?created_at=gte.2026-06-17T21:11:25&select=*&order=created_at.asc"
);
console.log("\n[RUNS AFTER RULE UPDATE 21:11:25Z]", JSON.stringify(afterRule, null, 2));
