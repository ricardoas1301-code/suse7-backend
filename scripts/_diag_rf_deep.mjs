import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseDotEnv(p){if(!fs.existsSync(p))return{};const o={};for(const l of fs.readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#")||!t.includes("="))continue;const i=t.indexOf("=");let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);o[t.slice(0,i).trim()]=v;}return o;}
const env={...parseDotEnv(path.join(root,".env.vercel")),...parseDotEnv(path.join(root,".env.local"))};
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const RF="c8a62ec6-cfbe-4ad9-98ea-49fadebeda50", SM="7f351439-ea13-44de-8a9c-a2413713f6e4";

console.log("=== REGRAS (linha completa) ===");
const { data: rules } = await supabase.from("s7_notification_automation_rules").select("*").eq("type_key","DAILY_SALES_SUMMARY");
for (const r of rules){
  console.log(`\n[${r.seller_id===RF?"RF Móveis":"Super MetalRio"}]`);
  for (const k of Object.keys(r)) console.log(`  ${k}: ${typeof r[k]==="object"?JSON.stringify(r[k]):r[k]}`);
}

console.log("\n\n=== RUNS RF (TODAS, 24h, qualquer status) ===");
const { data: rfr } = await supabase.from("s7_notification_automation_runs").select("*").eq("seller_id",RF).gte("created_at",new Date(Date.now()-24*3600_000).toISOString()).order("created_at",{ascending:false});
if(!rfr?.length) console.log("(nenhuma run RF em 24h)");
for (const r of (rfr||[])) console.log(`  ${r.created_at} | sched=${r.scheduled_at} | status=${r.status} | type=${r.type_key} | cat=${r.category_code} | err=${r.error_message||"-"}`);

console.log("\n=== RUNS SUPER (TODAS, hoje) p/ comparacao ===");
const { data: smr } = await supabase.from("s7_notification_automation_runs").select("created_at,scheduled_at,status,category_code,type_key").eq("seller_id",SM).gte("created_at",new Date(Date.now()-6*3600_000).toISOString()).order("created_at",{ascending:false});
for (const r of (smr||[])) console.log(`  ${r.created_at} | sched=${r.scheduled_at} | status=${r.status} | cat=${r.category_code}`);
console.log(`\nnow=${new Date().toISOString()}`);
