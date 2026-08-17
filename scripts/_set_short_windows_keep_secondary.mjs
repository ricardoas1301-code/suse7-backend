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
const SMR = "7f351439-ea13-44de-8a9c-a2413713f6e4";

const rfAddMin = Number.isFinite(Number(process.argv[2])) ? Number(process.argv[2]) : 6;
const smrAddMin = Number.isFinite(Number(process.argv[3])) ? Number(process.argv[3]) : 9;

function hhmmFromNow(addMin) {
  const d = new Date(Date.now() + addMin * 60_000);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

const rfSlot = hhmmFromNow(rfAddMin);
const smrSlot = hhmmFromNow(smrAddMin);

/** @param {string} sellerId */
async function updateRule(sellerId, firstSlot) {
  const { data: rule, error } = await supabase
    .from("s7_notification_automation_rules")
    .select("id,enabled,config")
    .eq("type_key", "DAILY_SALES_SUMMARY")
    .eq("seller_id", sellerId)
    .maybeSingle();
  if (error || !rule) throw new Error(`rule_not_found seller=${sellerId} err=${error?.message || "-"}`);

  const cfg = rule.config && typeof rule.config === "object" && !Array.isArray(rule.config) ? { ...rule.config } : {};
  const currentTimes = Array.isArray(cfg.times) ? cfg.times.map((v) => String(v)) : [];
  const secondary = currentTimes[1] || null;
  cfg.times = secondary ? [firstSlot, secondary] : [firstSlot];

  const { data: upd, error: updErr } = await supabase
    .from("s7_notification_automation_rules")
    .update({ config: cfg, updated_at: new Date().toISOString() })
    .eq("id", rule.id)
    .select("seller_id,enabled,config")
    .maybeSingle();
  if (updErr || !upd) throw new Error(`update_failed seller=${sellerId} err=${updErr?.message || "-"}`);
  return upd;
}

const rf = await updateRule(RF, rfSlot);
const smr = await updateRule(SMR, smrSlot);

console.log(`RF times=${JSON.stringify(rf.config.times)} weekdays=${JSON.stringify(rf.config.weekdays)} channels=${JSON.stringify(rf.config.channels)} enabled=${rf.enabled}`);
console.log(`SMR times=${JSON.stringify(smr.config.times)} weekdays=${JSON.stringify(smr.config.weekdays)} channels=${JSON.stringify(smr.config.channels)} enabled=${smr.enabled}`);
console.log(`slots_brt rf=${rfSlot} smr=${smrSlot} now_utc=${new Date().toISOString()}`);
