import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseDotEnv(p) {
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

const env = {
  ...parseDotEnv(path.join(root, ".env.vercel")),
  ...parseDotEnv(path.join(root, ".env.local")),
};

const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const RF = "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";
const pollMs = 30000;
const timeoutMs = 90 * 60 * 1000;
const startedAt = Date.now();
const sinceIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

console.log(`RF_WATCH_START seller=${RF} since=${sinceIso} now=${new Date().toISOString()}`);

while (Date.now() - startedAt < timeoutMs) {
  const { data, error } = await supabase
    .from("s7_notification_automation_runs")
    .select("id,seller_id,status,scheduled_at,created_at,completed_at,error_message,event_id")
    .eq("seller_id", RF)
    .eq("type_key", "DAILY_SALES_SUMMARY")
    .gte("scheduled_at", sinceIso)
    .order("scheduled_at", { ascending: false })
    .limit(3);

  if (error) {
    console.log(`RF_WATCH_ERR message=${String(error.message || "unknown")}`);
  } else if (Array.isArray(data) && data.length > 0) {
    const r = data[0];
    console.log(
      `RF_FOUND run_id=${r.id} status=${r.status} scheduled_at=${r.scheduled_at} created_at=${r.created_at} completed_at=${r.completed_at || "-"} event_id=${r.event_id || "-"} err=${r.error_message || "-"}`
    );
    process.exit(0);
  }

  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

console.log(`RF_WATCH_TIMEOUT now=${new Date().toISOString()}`);
