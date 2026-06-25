import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseDotEnv(p){if(!fs.existsSync(p))return{};const o={};for(const l of fs.readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#")||!t.includes("="))continue;const i=t.indexOf("=");let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);o[t.slice(0,i).trim()]=v;}return o;}
const env={...parseDotEnv(path.join(root,".env.vercel")),...parseDotEnv(path.join(root,".env.local"))};
const RF="c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// slot BRT = agora + N minutos (default 10). Uso: node _set_rf_slot.mjs [minutos]
const addMin = Number.isFinite(Number(process.argv[2])) ? Number(process.argv[2]) : 10;
const target = new Date(Date.now() + addMin*60_000);
const brt = new Intl.DateTimeFormat("en-GB",{timeZone:"America/Sao_Paulo",hour:"2-digit",minute:"2-digit",hour12:false}).format(target);
const slot = brt; // HH:MM

const { data: rule } = await supabase.from("s7_notification_automation_rules").select("id,config,enabled").eq("type_key","DAILY_SALES_SUMMARY").eq("seller_id",RF).maybeSingle();
if (!rule){ console.error("regra RF não encontrada"); process.exit(1); }
const cfg = (rule.config && typeof rule.config==="object" && !Array.isArray(rule.config)) ? { ...rule.config } : {};
cfg.times = [slot];
const { data: upd, error } = await supabase.from("s7_notification_automation_rules").update({ config: cfg, updated_at: new Date().toISOString() }).eq("id",rule.id).select("config,enabled").maybeSingle();
if (error){ console.error("erro:", error.message); process.exit(1); }
console.log(`RF Móveis -> times=${JSON.stringify(upd.config.times)} weekdays=${JSON.stringify(upd.config.weekdays)} channels=${JSON.stringify(upd.config.channels)} enabled=${upd.enabled}`);
console.log(`slot_brt=${slot}  now_utc=${new Date().toISOString()}  (dispara quando o scheduler chamar o endpoint apos esse horario)`);
