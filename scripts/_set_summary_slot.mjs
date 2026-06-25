#!/usr/bin/env node
// Define times=[SLOT_BRT] nas duas regras DAILY_SALES_SUMMARY (homologacao janela curta).
// Preserva channels, weekdays, timezone, enabled. Uso: node _set_summary_slot.mjs 13:07
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseDotEnv(p){if(!fs.existsSync(p))return{};const o={};for(const l of fs.readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#")||!t.includes("="))continue;const i=t.indexOf("=");let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);o[t.slice(0,i).trim()]=v;}return o;}
const env={...parseDotEnv(path.join(root,".env.vercel")),...parseDotEnv(path.join(root,".env.local"))};
const slot = process.argv[2];
if (!/^\d{2}:\d{2}$/.test(slot || "")) { console.error("uso: node _set_summary_slot.mjs HH:MM"); process.exit(1); }
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: rules } = await supabase.from("s7_notification_automation_rules").select("id,seller_id,enabled,config").eq("type_key","DAILY_SALES_SUMMARY");
for (const r of rules) {
  const cfg = (r.config && typeof r.config === "object" && !Array.isArray(r.config)) ? { ...r.config } : {};
  cfg.times = [slot];
  const { data: upd, error } = await supabase.from("s7_notification_automation_rules")
    .update({ config: cfg, updated_at: new Date().toISOString() })
    .eq("id", r.id).select("seller_id,enabled,config");
  if (error) { console.error("err", r.seller_id, error.message); process.exit(1); }
  const c = upd[0].config;
  console.log(`seller=${upd[0].seller_id} enabled=${upd[0].enabled} times=${JSON.stringify(c.times)} weekdays=${JSON.stringify(c.weekdays)} channels=${JSON.stringify(c.channels)}`);
}
console.log(`now_utc=${new Date().toISOString()} slot_brt=${slot}`);
