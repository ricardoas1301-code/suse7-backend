#!/usr/bin/env node
/**
 * CPJ2-T13 — BE: operational_cycle sem datetime falha fechado (não cai no dia civil).
 */

import assert from "node:assert/strict";
import { resolveExecutiveSummaryPeriod } from "../src/domain/sales/saleExecutivePeriod.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`, error instanceof Error ? error.message : error);
  }
}

test("operational_cycle com datetime usa o intervalo, inclusive o instante inicial", () => {
  const start = "2026-09-10T21:00:00.000Z";
  const end = "2026-09-11T15:00:00.000Z";
  const r = resolveExecutiveSummaryPeriod({
    period_preset: "operational_cycle",
    start_datetime: start,
    end_datetime: end,
  });
  assert.equal(r.ok, true);
  assert.equal(r.period.preset, "operational_cycle");
  assert.equal(r.period.start_datetime, start);
  assert.equal(r.period.end_datetime, end);
  assert.equal(r.period.start_ms, Date.parse(start));
  assert.equal(r.period.end_ms_exclusive, Date.parse(end) + 1);
});

test("operational_cycle sem datetime NÃO cai em today/civil", () => {
  const r = resolveExecutiveSummaryPeriod({ period_preset: "operational_cycle" });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /ciclo operacional/i);
  assert.equal(r.period, undefined);
});

test("today continua sendo dia civil UTC quando pedido explicitamente", () => {
  const r = resolveExecutiveSummaryPeriod({ period_preset: "today" });
  assert.equal(r.ok, true);
  assert.equal(r.period.preset, "today");
  assert.equal(r.period.start_date, r.period.end_date);
});

console.log(`\nResumo T13 BE: ${passed} OK, ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
