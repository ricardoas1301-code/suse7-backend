#!/usr/bin/env node
/**
 * CPJ2 T16 — inventário determinístico de vercel.json crons.
 * Previne regressão: Competition 5/5, Daily consolidado, Marketplace 1, sem duplicatas.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
const crons = Array.isArray(vercel.crons) ? vercel.crons : [];

const DAILY = "/api/jobs/daily-sales-summary-automation";
const COMP = "/api/jobs/competition-daily-snapshot";
const MKT = "/api/jobs/marketplace-account-sync";

const byPath = (p) => crons.filter((c) => c.path === p);
const daily = byPath(DAILY);
const competition = byPath(COMP);
const marketplace = byPath(MKT);

assert.ok(crons.length > 0, "crons vazios");
assert.ok(crons.length <= 100, `crons ${crons.length} > 100`);
assert.ok(crons.length <= 20, `margem estrutural: esperado <<100, got ${crons.length}`);

assert.equal(daily.length, 1, `Daily Sales slots: esperado 1, got ${daily.length}`);
assert.equal(daily[0].schedule, "*/5 * * * *", `Daily schedule: ${daily[0].schedule}`);

assert.equal(competition.length, 5, `Competition: esperado 5, got ${competition.length}`);
const expectedComp = ["33 6 * * *", "39 6 * * *", "45 6 * * *", "51 6 * * *", "57 6 * * *"];
const compSchedules = competition.map((c) => c.schedule).sort();
assert.deepEqual(compSchedules, [...expectedComp].sort(), "Competition schedules 5/5");

assert.equal(marketplace.length, 1, `Marketplace: esperado 1, got ${marketplace.length}`);
assert.equal(marketplace[0].schedule, "* * * * *");

const keys = crons.map((c) => `${c.path}|${c.schedule}`);
assert.equal(new Set(keys).size, keys.length, "duplicata path+schedule");

const unknown = crons.filter((c) => ![DAILY, COMP, MKT].includes(c.path));
assert.equal(unknown.length, 0, `paths inesperados: ${JSON.stringify(unknown)}`);

console.log(
  JSON.stringify({
    ok: true,
    test: "vercel_crons_inventory_unit",
    total: crons.length,
    daily: daily.length,
    competition: competition.length,
    marketplace: marketplace.length,
    margin: 100 - crons.length,
    utilization_pct: Number(((crons.length / 100) * 100).toFixed(1)),
  })
);
