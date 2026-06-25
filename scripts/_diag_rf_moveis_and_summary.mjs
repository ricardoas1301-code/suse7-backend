#!/usr/bin/env node
// Diagnóstico Missões 02 e 03 — RF Móveis (dashboard vazio) + DAILY_SALES_SUMMARY runs.
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
const env = { ...parseDotEnv(path.join(root, ".env.vercel")), ...parseDotEnv(path.join(root, ".env.local")) };
const { createClient } = await import("@supabase/supabase-js");
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
console.log("[diag] supabase_host:", new URL(env.SUPABASE_URL).hostname);

// 1) Achar contas (ml_nickname/account_alias contendo RF / Móveis)
const { data: accounts, error: accErr } = await supabase
  .from("marketplace_accounts")
  .select("id,user_id,seller_company_id,external_seller_id,account_alias,ml_nickname,status,marketplace,last_sync_at,ml_sales_last_sync_at,created_at")
  .order("created_at", { ascending: false })
  .limit(50);
if (accErr) {
  console.error("[diag] marketplace_accounts error:", accErr.message);
} else {
  console.log("\n=== TODAS AS CONTAS (id | nick | alias | ext | status | last_sync | sales_sync) ===");
  for (const a of accounts) {
    console.log(`${a.id} | ${a.ml_nickname ?? "-"} | ${a.account_alias ?? "-"} | ext=${a.external_seller_id ?? "-"} | ${a.status} | last=${a.last_sync_at ?? "-"} | salesSync=${a.ml_sales_last_sync_at ?? "-"} | user=${a.user_id}`);
  }
}

const nameOf = (a) => `${a.ml_nickname || ""} ${a.account_alias || ""}`.toLowerCase();
const rf = (accounts || []).filter((a) =>
  nameOf(a).includes("rf") || nameOf(a).includes("móvei") || nameOf(a).includes("movei")
);
console.log("\n=== Candidatos RF Móveis ===");
console.log(rf.map((a) => ({ id: a.id, nick: a.ml_nickname, alias: a.account_alias, user_id: a.user_id, ext: a.external_seller_id, status: a.status })));

const now = new Date();
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
const d60 = new Date(now.getTime() - 60 * 86400000).toISOString();

for (const a of (rf.length ? rf : accounts || [])) {
  console.log(`\n========== CONTA ${a.ml_nickname ?? a.account_alias ?? a.id} (${a.id}) ==========`);
  // sales_orders no mês atual e 60d, por date_created_marketplace
  for (const [label, fromIso] of [["mes_atual", monthStart], ["ultimos_60d", d60]]) {
    const { count, error } = await supabase
      .from("sales_orders")
      .select("id", { count: "exact", head: true })
      .eq("marketplace_account_id", a.id)
      .gte("date_created_marketplace", fromIso);
    console.log(`  sales_orders[${label}] (date_created_marketplace>=${fromIso.slice(0,10)}): ${error ? "ERR " + error.message : count}`);
  }
  // total geral
  const { count: totalCount, error: totErr } = await supabase
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("marketplace_account_id", a.id);
  console.log(`  sales_orders[total]: ${totErr ? "ERR " + totErr.message : totalCount}`);
  // última venda
  const { data: lastSale } = await supabase
    .from("sales_orders")
    .select("id,date_created_marketplace,created_at")
    .eq("marketplace_account_id", a.id)
    .order("date_created_marketplace", { ascending: false })
    .limit(1);
  console.log(`  ultima_venda:`, lastSale?.[0] ?? "(nenhuma)");
  // sync jobs status
  const { data: jobs } = await supabase
    .from("marketplace_account_sync_jobs")
    .select("job_type,status,updated_at,error_message")
    .eq("marketplace_account_id", a.id)
    .order("updated_at", { ascending: false })
    .limit(30);
  const byStatus = {};
  for (const j of jobs || []) {
    const k = `${j.job_type}:${j.status}`;
    byStatus[k] = (byStatus[k] || 0) + 1;
  }
  console.log(`  sync_jobs (job_type:status -> count):`, byStatus);
  const errs = (jobs || []).filter((j) => j.status === "error").slice(0, 3);
  if (errs.length) console.log(`  sync_jobs_errors_sample:`, errs.map((e) => ({ t: e.job_type, msg: (e.error_message || "").slice(0, 120) })));
}

// 3) DAILY_SALES_SUMMARY runs hoje
console.log("\n\n========== DAILY_SALES_SUMMARY (runs recentes) ==========");
const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
const { data: runs, error: runsErr } = await supabase
  .from("s7_notification_automation_runs")
  .select("id,seller_id,type_key,scheduled_at,created_at,status,event_id,error_message,period_start,period_end,completed_at")
  .eq("type_key", "DAILY_SALES_SUMMARY")
  .gte("created_at", new Date(now.getTime() - 48 * 3600000).toISOString())
  .order("created_at", { ascending: false })
  .limit(60);
if (runsErr) {
  console.log("[diag] runs query error:", runsErr.message);
} else {
  console.log(`DAILY_SALES_SUMMARY runs ultimas 48h: ${runs.length}`);
  for (const r of runs) {
    console.log(`  created=${r.created_at} | sched=${r.scheduled_at} | ${r.status} | seller=${r.seller_id} | ev=${r.event_id ?? "-"} | per=${(r.period_start||"-")}..${(r.period_end||"-")} | err=${(r.error_message||"").slice(0,50)}`);
  }
}

// 3b) Regras DAILY_SALES_SUMMARY ativas e horários configurados
console.log("\n========== REGRAS DAILY_SALES_SUMMARY ==========");
const { data: rules, error: rulesErr } = await supabase
  .from("s7_notification_automation_rules")
  .select("id,seller_id,type_key,enabled,config,last_successful_run_at,updated_at")
  .eq("type_key", "DAILY_SALES_SUMMARY")
  .limit(40);
if (rulesErr) {
  console.log("[diag] rules query error:", rulesErr.message);
} else {
  for (const r of rules) {
    const cfg = r.config || {};
    console.log(`  seller=${r.seller_id} | enabled=${r.enabled} | times=${JSON.stringify(cfg.times ?? cfg.schedule_times ?? cfg.horarios ?? cfg)} | last_ok=${r.last_successful_run_at ?? "-"} | upd=${r.updated_at}`);
  }
}
console.log("\n[diag] DONE");
