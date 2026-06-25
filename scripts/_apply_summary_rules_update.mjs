#!/usr/bin/env node
// Ajuste das regras DAILY_SALES_SUMMARY:
//  - times -> ["04:00","07:00"] nas duas regras
//  - weekdays Super MetalRio -> [1,2,3,4,5,6]
// Preserva channels, timezone, enabled. RETURNING para evidência.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseDotEnv(p){if(!fs.existsSync(p))return{};const o={};for(const l of fs.readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#")||!t.includes("="))continue;const i=t.indexOf("=");let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);o[t.slice(0,i).trim()]=v;}return o;}
const env={...parseDotEnv(path.join(root,".env.vercel")),...parseDotEnv(path.join(root,".env.local"))};
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const SUPER_METALRIO_SELLER = "7f351439-ea13-44de-8a9c-a2413713f6e4";
const NEW_TIMES = ["04:00", "07:00"];
const NEW_WEEKDAYS_SUPER = [1, 2, 3, 4, 5, 6];

const { data: rules, error } = await supabase
  .from("s7_notification_automation_rules")
  .select("id,seller_id,enabled,config,updated_at")
  .eq("type_key", "DAILY_SALES_SUMMARY");
if (error) { console.error("read error:", error.message); process.exit(1); }

console.log("=== ANTES ===");
for (const r of rules) console.log(`seller=${r.seller_id} enabled=${r.enabled} config=${JSON.stringify(r.config)}`);

for (const r of rules) {
  const cfg = (r.config && typeof r.config === "object" && !Array.isArray(r.config)) ? { ...r.config } : {};
  cfg.times = [...NEW_TIMES]; // ambas as regras
  if (r.seller_id === SUPER_METALRIO_SELLER) {
    cfg.weekdays = [...NEW_WEEKDAYS_SUPER];
  }
  // channels, timezone, demais chaves preservados (spread). enabled NAO tocado.
  const { data: upd, error: uerr } = await supabase
    .from("s7_notification_automation_rules")
    .update({ config: cfg, updated_at: new Date().toISOString() })
    .eq("id", r.id)
    .select("id,seller_id,enabled,config,updated_at");
  if (uerr) { console.error(`update error seller=${r.seller_id}:`, uerr.message); process.exit(1); }
  console.log(`\n[updated] seller=${upd[0].seller_id}`);
  console.log("  RETURNING config=", JSON.stringify(upd[0].config));
}

console.log("\n=== DEPOIS (releitura de validacao) ===");
const { data: after } = await supabase
  .from("s7_notification_automation_rules")
  .select("seller_id,enabled,config,updated_at")
  .eq("type_key", "DAILY_SALES_SUMMARY");
for (const r of after) {
  const c = r.config || {};
  console.log(`seller=${r.seller_id} | enabled=${r.enabled} | times=${JSON.stringify(c.times)} | weekdays=${JSON.stringify(c.weekdays)} | channels=${JSON.stringify(c.channels)} | tz=${c.timezone} | upd=${r.updated_at}`);
}
console.log("\nDONE");
