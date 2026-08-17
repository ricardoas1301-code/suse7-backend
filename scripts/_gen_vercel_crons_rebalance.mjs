#!/usr/bin/env node
// Rebalanceia os crons do vercel.json para cobrir as HORAS OPERACIONAIS do
// DAILY_SALES_SUMMARY dentro do teto de 100 crons (Vercel Hobby, 1x/dia/cron, granularidade de HORA).
// NAO faz deploy. Apenas reescreve o arquivo (staged em git). Reversivel.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "vercel.json");
const j = JSON.parse(fs.readFileSync(file, "utf8"));

const DAILY = "/api/jobs/daily-sales-summary-automation";
const COMP = "/api/jobs/competition-daily-snapshot";

// Preserva os crons de competition exatamente como estao.
const compCrons = (j.crons || []).filter((c) => c.path === COMP);

// Cobertura DAILY (UTC). Operacionais densos (12=cada 5min); negocio mantido.
//  07 UTC = 04:00 BRT (operacional) | 10 UTC = 07:00 BRT (operacional) | 16 UTC = 13:00 BRT (teste)
//  11-15 UTC = 08:00-12:00 BRT (horario comercial / testes de UI)
const minutesAll = Array.from({ length: 12 }, (_, i) => i * 5);          // 0..55
const minutes11 = minutesAll.slice(0, 11);                               // 0..50
const plan = [
  { hour: 7,  minutes: minutesAll },   // 04:00 BRT operacional
  { hour: 10, minutes: minutesAll },   // 07:00 BRT operacional
  { hour: 11, minutes: minutesAll },
  { hour: 12, minutes: minutesAll },
  { hour: 13, minutes: minutesAll },
  { hour: 14, minutes: minutesAll },
  { hour: 15, minutes: minutes11 },
  { hour: 16, minutes: minutesAll },   // 13:00 BRT (janela de teste)
];

const dailyCrons = [];
for (const { hour, minutes } of plan) {
  for (const m of minutes) dailyCrons.push({ path: DAILY, schedule: `${m} ${hour} * * *` });
}

const crons = [...compCrons, ...dailyCrons];
if (crons.length > 100) { console.error(`ABORT: ${crons.length} crons > 100`); process.exit(1); }

j.crons = crons;
fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n", "utf8");

// Relatorio
const perHour = {};
for (const c of dailyCrons) { const h = c.schedule.split(" ")[1]; perHour[h] = (perHour[h] || 0) + 1; }
console.log(`TOTAL crons: ${crons.length} (competition=${compCrons.length}, daily=${dailyCrons.length})`);
console.log("DAILY cobertura (UTC hora -> entradas):");
Object.keys(perHour).map(Number).sort((a,b)=>a-b).forEach((h)=>{
  const brt = (h - 3 + 24) % 24;
  console.log(`  ${String(h).padStart(2,"0")}:00 UTC (${String(brt).padStart(2,"0")}:00 BRT) -> ${perHour[String(h)]}`);
});
