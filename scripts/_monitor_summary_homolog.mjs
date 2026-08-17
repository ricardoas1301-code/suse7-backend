#!/usr/bin/env node
// Monitor read-only de homologacao DAILY_SALES_SUMMARY (janela curta).
// NAO chama o endpoint. So observa runs/eventos/dispatches criados pelo scheduler externo.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseDotEnv(p){if(!fs.existsSync(p))return{};const o={};for(const l of fs.readFileSync(p,"utf8").split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith("#")||!t.includes("="))continue;const i=t.indexOf("=");let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);o[t.slice(0,i).trim()]=v;}return o;}
const env={...parseDotEnv(path.join(root,".env.vercel")),...parseDotEnv(path.join(root,".env.local"))};
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const SELLERS = {
  "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50": "RF Móveis",
  "7f351439-ea13-44de-8a9c-a2413713f6e4": "Super MetalRio",
};
const fmtBrt = (iso) => iso ? new Intl.DateTimeFormat("pt-BR",{timeZone:"America/Sao_Paulo",hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date(iso)) : "—";
const secs = (a,b) => (a&&b) ? Math.round((new Date(a).getTime()-new Date(b).getTime())/1000) : null;

const now = new Date();
console.log(`\n==== MONITOR ${now.toISOString()} (BRT ${fmtBrt(now.toISOString())}) ====`);

const { data: runs, error } = await supabase
  .from("s7_notification_automation_runs")
  .select("id,seller_id,status,event_id,scheduled_at,created_at,completed_at,period_start,period_end,error_message")
  .eq("type_key","DAILY_SALES_SUMMARY")
  .gte("created_at", new Date(now.getTime()-3*3600_000).toISOString())
  .order("created_at",{ascending:false});
if (error){ console.error("runs err:", error.message); process.exit(1); }

if (!runs?.length){ console.log("Nenhuma run nas ultimas 3h. (slot ainda nao virou run — aguardando trigger externo)"); process.exit(0); }

for (const r of runs){
  const lat = secs(r.created_at, r.scheduled_at);
  const proc = secs(r.completed_at, r.created_at);
  console.log(`\n----- RUN ${r.id} -----`);
  console.log(`seller        : ${SELLERS[r.seller_id]||r.seller_id}`);
  console.log(`status        : ${r.status}`);
  console.log(`scheduled_at  : ${r.scheduled_at}  (BRT ${fmtBrt(r.scheduled_at)})`);
  console.log(`created_at    : ${r.created_at}  (BRT ${fmtBrt(r.created_at)})`);
  console.log(`completed_at  : ${r.completed_at||"—"}  (BRT ${fmtBrt(r.completed_at)})`);
  console.log(`latencia(run) : ${lat===null?"—":lat+"s"}  [criada - agendada]`);
  console.log(`processamento : ${proc===null?"—":proc+"s"}  [concluida - criada]`);
  console.log(`periodo       : ${fmtBrt(r.period_start)} -> ${fmtBrt(r.period_end)} (BRT)`);
  console.log(`event_id      : ${r.event_id||"—"}`);
  if (r.error_message) console.log(`ERRO          : ${r.error_message}`);

  if (r.event_id){
    const { data: ev } = await supabase.from("s7_notification_events").select("id,created_at,type_key,category_code").eq("id",r.event_id).maybeSingle();
    if (ev) console.log(`evento criado : ${ev.created_at}  (BRT ${fmtBrt(ev.created_at)})`);
    const { data: disp } = await supabase.from("s7_notification_dispatches").select("channel,status,created_at,sent_at").eq("event_id",r.event_id).order("created_at",{ascending:true});
    if (disp?.length){
      console.log(`canais disparados (${disp.length}):`);
      for (const d of disp) console.log(`   - ${String(d.channel).padEnd(10)} status=${String(d.status).padEnd(10)} criado=${fmtBrt(d.created_at)} enviado=${fmtBrt(d.sent_at)}`);
    } else console.log(`canais disparados : (nenhum dispatch encontrado)`);
  }
}
console.log("\n==== fim ====");
