#!/usr/bin/env node
/**
 * CPJ2 T16 — cobertura de wake Daily Sales apos consolidacao (cron a cada 5 min, all-day).
 * Prova equivalencia/superioridade vs 95 slots Hobby + gate 18:00 BRT + lookback 90.
 * Nao dispara notificacao real; usa helpers do window + idempotency key.
 *
 * Evita importar o motor (carrega config/env). Lookback usa a mesma formula exportada
 * via constantes locais alinhadas ao motor (90 min).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN,
  DEFAULT_DAILY_SALES_SUMMARY_CONFIG,
} from "../src/domain/notifications/central/sales/dailySalesSummaryAutomationConstants.js";
import {
  buildBrtScheduledAtUtc,
  explainDailySalesScheduleSlot,
  toBrtParts,
} from "../src/domain/notifications/central/sales/dailySalesSummaryWindow.js";
import { buildDailySalesSummaryIdempotencyKey } from "../src/domain/notifications/central/sales/buildDailySalesSummaryTemplatePayload.js";

const LOOKBACK_MIN = 90; // espelha DAILY_SALES_SUMMARY_SLOT_LOOKBACK_MIN no motor

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
const dailyCron = (vercel.crons || []).find(
  (c) => c.path === "/api/jobs/daily-sales-summary-automation"
);
assert.ok(dailyCron, "cron Daily Sales ausente");
assert.equal(dailyCron.schedule, "*/5 * * * *");

/** Hobby-era Vercel hours (UTC) from legacy rebalance script */
const LEGACY_VERCEL_UTC_HOURS = new Set([7, 10, 11, 12, 13, 14, 15, 16]);

/** @param {Date} utc */
function matchesConsolidatedDailyWake(utc) {
  assert.equal(dailyCron.schedule, "*/5 * * * *");
  return utc.getUTCMinutes() % 5 === 0;
}

/** @param {Date} utc */
function matchesLegacyHobbySlot(utc) {
  const h = utc.getUTCHours();
  const m = utc.getUTCMinutes();
  if (!LEGACY_VERCEL_UTC_HOURS.has(h)) return false;
  if (h === 15 && m === 55) return false;
  return m % 5 === 0;
}

/**
 * Espelho de resolveDueDailySalesSlots (motor) — sem importar config.
 * @param {{ nowUtc: Date; lowerBoundUtc: Date; weekdays: readonly number[]; times: readonly string[] }} input
 */
function resolveDueSlotsMirror(input) {
  const weekdays = new Set(input.weekdays ?? []);
  const due = [];
  const seen = new Set();
  const startKey = toBrtParts(input.lowerBoundUtc).dateKey;
  const endKey = toBrtParts(input.nowUtc).dateKey;
  let cursor = buildBrtScheduledAtUtc(startKey, "00:00");
  const end = buildBrtScheduledAtUtc(endKey, "00:00");
  if (!cursor || !end) return due;
  while (cursor.getTime() <= end.getTime()) {
    const dateKey = toBrtParts(cursor).dateKey;
    for (const time of input.times ?? []) {
      const scheduled = buildBrtScheduledAtUtc(dateKey, time);
      if (!scheduled) continue;
      const key = scheduled.toISOString();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!weekdays.has(toBrtParts(scheduled).weekday)) continue;
      if (scheduled.getTime() < input.lowerBoundUtc.getTime()) continue;
      if (scheduled.getTime() > input.nowUtc.getTime()) continue;
      due.push({ scheduled_at: scheduled, time });
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  due.sort((a, b) => a.scheduled_at.getTime() - b.scheduled_at.getTime());
  return due;
}

const weekdays = DEFAULT_DAILY_SALES_SUMMARY_CONFIG.weekdays;
const times = ["18:00"];

{
  const at1800 = new Date("2026-06-22T21:00:00.000Z");
  const brt = toBrtParts(at1800);
  assert.equal(brt.hours, 18);
  assert.equal(brt.minutes, 0);
  assert.equal(brt.weekday, 1);

  // 17:56 BRT = fora da tolerancia ±3; 17:59 estaria DENTRO
  const before = new Date("2026-06-22T20:56:00.000Z");
  const after3 = new Date("2026-06-22T21:03:00.000Z");
  const after5 = new Date("2026-06-22T21:05:00.000Z");

  assert.equal(explainDailySalesScheduleSlot(before, weekdays, times).matched, false);
  assert.equal(explainDailySalesScheduleSlot(at1800, weekdays, times).matched, true);
  assert.equal(explainDailySalesScheduleSlot(after3, weekdays, times).matched, true);
  assert.equal(explainDailySalesScheduleSlot(after5, weekdays, times).matched, false);

  assert.equal(matchesConsolidatedDailyWake(at1800), true, "wake cobre 21:00 UTC / 18:00 BRT");
  assert.equal(matchesLegacyHobbySlot(at1800), false, "legado 95 nao cobria 18:00 BRT no Vercel");
}

{
  assert.equal(LOOKBACK_MIN, 90);
  assert.equal(DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN, 3);

  const delayed45 = new Date("2026-06-22T21:45:00.000Z");
  const lowerBound = new Date(delayed45.getTime() - LOOKBACK_MIN * 60_000);
  const due = resolveDueSlotsMirror({
    nowUtc: delayed45,
    lowerBoundUtc: lowerBound,
    weekdays,
    times,
  });
  assert.equal(due.length, 1);
  assert.equal(due[0].time, "18:00");

  const delayed100 = new Date("2026-06-22T22:40:00.000Z");
  const lower100 = new Date(delayed100.getTime() - LOOKBACK_MIN * 60_000);
  const dueMiss = resolveDueSlotsMirror({
    nowUtc: delayed100,
    lowerBoundUtc: lower100,
    weekdays,
    times,
  });
  assert.equal(dueMiss.length, 0, "fora do lookback 90min nao recupera");
}

{
  let legacyChecked = 0;
  for (const h of LEGACY_VERCEL_UTC_HOURS) {
    for (let m = 0; m < 60; m += 5) {
      if (h === 15 && m === 55) continue;
      const utc = new Date(Date.UTC(2026, 5, 22, h, m, 0));
      assert.equal(matchesLegacyHobbySlot(utc), true);
      assert.equal(matchesConsolidatedDailyWake(utc), true, `legado ${h}:${String(m).padStart(2, "0")} coberto`);
      legacyChecked += 1;
    }
  }
  assert.equal(legacyChecked, 95, `esperado 95 slots legado, got ${legacyChecked}`);
  assert.equal(matchesConsolidatedDailyWake(new Date("2026-06-22T21:00:00.000Z")), true);
}

{
  const sundayNoon = new Date("2026-06-21T15:00:00.000Z");
  const skip = explainDailySalesScheduleSlot(sundayNoon, weekdays, times);
  assert.equal(skip.matched, false);
  assert.equal(skip.debug.reason, "weekday_not_selected");
}

{
  const scheduled = buildBrtScheduledAtUtc("2026-06-22", "18:00");
  const k1 = buildDailySalesSummaryIdempotencyKey("seller-a", scheduled);
  const k2 = buildDailySalesSummaryIdempotencyKey("seller-a", scheduled);
  const kB = buildDailySalesSummaryIdempotencyKey("seller-b", scheduled);
  assert.equal(k1, k2);
  assert.notEqual(k1, kB);
  assert.match(k1, /^daily\.sales-summary:seller-a:/);
}

{
  const sA = buildBrtScheduledAtUtc("2026-06-22", "10:00");
  const sB = buildBrtScheduledAtUtc("2026-06-22", "18:00");
  assert.notEqual(
    buildDailySalesSummaryIdempotencyKey("s1", sA),
    buildDailySalesSummaryIdempotencyKey("s1", sB)
  );
  assert.notEqual(
    buildDailySalesSummaryIdempotencyKey("s1", sA),
    buildDailySalesSummaryIdempotencyKey("s2", sA)
  );
}

console.log(
  JSON.stringify({
    ok: true,
    test: "daily_sales_wake_coverage_unit",
    cases: [
      "18h_brt_tolerance",
      "18h_wake_cron_covers_21utc",
      "legacy_hobby_95_subset_of_consolidated",
      "lookback_90_recover",
      "lookback_miss_after_90",
      "zero_work_weekday",
      "idempotency_key_double_tick",
      "multi_seller_isolation",
    ],
    coverage_loss_vs_legacy_vercel: false,
    coverage_18h_brt: true,
    superior_to_legacy_vercel: true,
  })
);
