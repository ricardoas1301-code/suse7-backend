import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseDotEnv(p){if(!fs.existsSync(p))return{};const o={};for(const l of fs.readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#")||!t.includes("="))continue;const i=t.indexOf("=");let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);o[t.slice(0,i).trim()]=v;}return o;}
const env={...parseDotEnv(path.join(root,".env.vercel")),...parseDotEnv(path.join(root,".env.local"))};
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const RF="c8a62ec6-cfbe-4ad9-98ea-49fadebeda50", SM="7f351439-ea13-44de-8a9c-a2413713f6e4";

// 1) RF runs por scheduled_at hoje (qualquer status/created)
const todayUtc = new Date(); todayUtc.setUTCHours(0,0,0,0);
const { data: rfAny } = await supabase.from("s7_notification_automation_runs").select("id,status,scheduled_at,created_at,error_message").eq("seller_id",RF).gte("scheduled_at",todayUtc.toISOString()).order("scheduled_at",{ascending:false});
console.log("RF runs por scheduled_at>=hoje:", rfAny?.length||0);
for (const r of (rfAny||[])) console.log("  ",r.status,r.scheduled_at,r.created_at,r.error_message||"");

// 2) buildSaleExecutiveSummary read-only: RF vs Super
const { buildSaleExecutiveSummary } = await import("../src/domain/sales/buildSaleExecutiveSummary.js");
async function probe(label, sellerId, startIso, endIso){
  const period = { preset:"custom", start_date:startIso.slice(0,10), end_date:new Date(new Date(endIso).getTime()-86400000).toISOString().slice(0,10), start_ms:new Date(startIso).getTime(), end_ms_exclusive:new Date(endIso).getTime() };
  const t0=Date.now();
  try{
    const r = await buildSaleExecutiveSummary(supabase, sellerId, { period });
    console.log(`\n[${label}] OK em ${Date.now()-t0}ms | keys=${Object.keys(r||{}).slice(0,8).join(",")}`);
  }catch(e){
    console.log(`\n[${label}] THREW em ${Date.now()-t0}ms | ${e?.name}: ${e?.message}`);
    if (e?.stack) console.log(String(e.stack).split("\n").slice(0,4).join("\n"));
  }
}
await probe("RF Móveis", RF, "2026-06-18T17:34:01+00:00", "2026-06-19T17:39:00+00:00");
await probe("Super MetalRio", SM, "2026-06-19T16:09:01+00:00", "2026-06-19T17:42:00+00:00");
console.log(`\nnow=${new Date().toISOString()}`);
