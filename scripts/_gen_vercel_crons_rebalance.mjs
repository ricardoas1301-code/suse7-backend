#!/usr/bin/env node
/**
 * Gera vercel.json consolidado (Pro):
 * - Competition 5/5 (fan-out diário)
 * - Daily Sales 1x (cron a cada 5 min, all-day UTC; substitui 95 Hobby-compat)
 * - Marketplace 1x (cron a cada 1 min; wake generico; anti-dual via flag)
 *
 * NÃO faz deploy. Reversível. Abort se total > 100.
 *
 * Historico: o gerador antigo materializava 95 entradas 1x/dia porque Hobby
 * bloqueava expressoes com mais de 1 execucao/dia. Com Pro, cron volta a ser despertador.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "vercel.json");
const j = JSON.parse(fs.readFileSync(file, "utf8"));

const DAILY = "/api/jobs/daily-sales-summary-automation";
const COMP = "/api/jobs/competition-daily-snapshot";
const MKT = "/api/jobs/marketplace-account-sync";

const crons = [
  { path: COMP, schedule: "33 6 * * *" },
  { path: COMP, schedule: "39 6 * * *" },
  { path: COMP, schedule: "45 6 * * *" },
  { path: COMP, schedule: "51 6 * * *" },
  { path: COMP, schedule: "57 6 * * *" },
  // Cobertura all-day a cada 5 min UTC — inclui janelas historicas (07,10-16) + 18:00 BRT (21 UTC)
  { path: DAILY, schedule: "*/5 * * * *" },
  { path: MKT, schedule: "* * * * *" },
];

if (crons.length > 100) {
  console.error(`ABORT: ${crons.length} crons > 100`);
  process.exit(1);
}

j.crons = crons;
fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n", "utf8");

const count = (p) => crons.filter((c) => c.path === p).length;
console.log(
  JSON.stringify(
    {
      ok: true,
      total: crons.length,
      competition: count(COMP),
      daily_sales: count(DAILY),
      marketplace: count(MKT),
      margin: 100 - crons.length,
      note: "Hobby-compat 95 Daily slots superseded by Pro every-5-min single wake",
    },
    null,
    2
  )
);
