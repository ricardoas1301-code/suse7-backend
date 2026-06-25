import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseDotEnv(p){if(!fs.existsSync(p))return{};const o={};for(const l of fs.readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#")||!t.includes("="))continue;const i=t.indexOf("=");let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);o[t.slice(0,i).trim()]=v;}return o;}
const env={...parseDotEnv(path.join(root,".env.vercel")),...parseDotEnv(path.join(root,".env.local"))};
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const RF="c8a62ec6-cfbe-4ad9-98ea-49fadebeda50", SM="7f351439-ea13-44de-8a9c-a2413713f6e4";
const { data: rules } = await supabase.from("s7_notification_automation_rules").select("seller_id,enabled,category_code,type_key,last_successful_run_at,updated_at,config").eq("type_key","DAILY_SALES_SUMMARY");
console.log("=== REGRAS ===");
for (const r of rules) console.log(`${r.seller_id===RF?"RF Móveis    ":"Super MetalRio"} enabled=${r.enabled} cat=${r.category_code} last_ok=${r.last_successful_run_at} times=${JSON.stringify(r.config?.times)} weekdays=${JSON.stringify(r.config?.weekdays)}`);
console.log("\n=== RUNS RF MÓVEIS (12h) ===");
const { data: rfruns } = await supabase.from("s7_notification_automation_runs").select("id,status,scheduled_at,created_at,completed_at,error_message").eq("type_key","DAILY_SALES_SUMMARY").eq("seller_id",RF).gte("created_at",new Date(Date.now()-12*3600_000).toISOString()).order("created_at",{ascending:false});
if(!rfruns?.length) console.log("(nenhuma run RF Móveis nas ultimas 12h)");
for (const r of (rfruns||[])) console.log(`${r.id} status=${r.status} sched=${r.scheduled_at} created=${r.created_at} err=${r.error_message||"-"}`);
console.log(`\nnow=${new Date().toISOString()}`);
