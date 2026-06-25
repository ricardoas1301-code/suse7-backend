#!/usr/bin/env node
// =============================================================================
// DASH.5 — validação unitária do ciclo operacional + período datetime no backend
// =============================================================================

import assert from "node:assert/strict";
import { resolveExecutiveSummaryPeriod } from "../src/domain/sales/saleExecutivePeriod.js";
import {
  DEFAULT_OPERATIONAL_DAY_CLOSES_AT,
  normalizeOperationalDayClosesAt,
  resolveOperationalDayCycle,
} from "../../suse7-frontend/src/features/dashboard/operationalDayCycle.js";
import {
  DEFAULT_OPERATIONAL_WORKING_DAYS,
  normalizeOperationalWorkingDays,
} from "../../suse7-frontend/src/features/dashboard/operationalWorkingDays.js";

function assertIsoClose(actual, expectedIso) {
  const a = new Date(actual).getTime();
  const e = new Date(expectedIso).getTime();
  assert.ok(Math.abs(a - e) <= 1000, `expected ~${expectedIso}, got ${actual}`);
}

console.log("[DASH.5] test_operational_day_cycle_unit");

assert.equal(normalizeOperationalDayClosesAt(null), DEFAULT_OPERATIONAL_DAY_CLOSES_AT);
assert.equal(normalizeOperationalDayClosesAt("18:00:00"), "18:00");
assert.equal(normalizeOperationalDayClosesAt("17:30:00"), "17:30");
assert.deepEqual(normalizeOperationalWorkingDays(null), DEFAULT_OPERATIONAL_WORKING_DAYS);
assert.deepEqual(normalizeOperationalWorkingDays([]), DEFAULT_OPERATIONAL_WORKING_DAYS);
assert.deepEqual(normalizeOperationalWorkingDays([1, 2, 3, 4, 5]), [1, 2, 3, 4, 5]);

{
  const now = new Date("2026-06-20T08:00:00.000-03:00");
  const cycle = resolveOperationalDayCycle({ now, closesAt: "18:00", timezone: "America/Sao_Paulo" });
  assertIsoClose(cycle.startDatetimeIso, "2026-06-19T21:00:00.000Z");
  assert.equal(cycle.endAt.getTime(), now.getTime());
  assert.match(cycle.labelCompact, /19\/06 18:00 – 20\/06 08:00/);
}

{
  const now = new Date("2026-06-20T13:00:00.000-03:00");
  const cycle = resolveOperationalDayCycle({ now, closesAt: "18:00", timezone: "America/Sao_Paulo" });
  assertIsoClose(cycle.startDatetimeIso, "2026-06-19T21:00:00.000Z");
  assert.match(cycle.labelCompact, /19\/06 18:00 – 20\/06 13:00/);
}

{
  const now = new Date("2026-06-20T21:30:00.000Z");
  const cycle = resolveOperationalDayCycle({ now, closesAt: "18:00", timezone: "America/Sao_Paulo" });
  assertIsoClose(cycle.startDatetimeIso, "2026-06-20T21:00:00.000Z");
  assert.match(cycle.labelCompact, /20\/06 18:00 – 20\/06 18:30/);
}

{
  const now = new Date("2026-06-20T11:00:00.000-03:00");
  const cycle = resolveOperationalDayCycle({ now, closesAt: "17:00", timezone: "America/Sao_Paulo" });
  assertIsoClose(cycle.startDatetimeIso, "2026-06-19T20:00:00.000Z");
}

{
  const now = new Date("2026-06-22T09:23:00.000-03:00");
  const cycle = resolveOperationalDayCycle({
    now,
    closesAt: "17:00",
    timezone: "America/Sao_Paulo",
    workingDays: DEFAULT_OPERATIONAL_WORKING_DAYS,
  });
  assertIsoClose(cycle.startDatetimeIso, "2026-06-21T20:00:00.000Z");
  assert.match(cycle.labelCompact, /21\/06 17:00 – 22\/06 09:23/);
}

{
  const now = new Date("2026-06-22T09:23:00.000-03:00");
  const cycle = resolveOperationalDayCycle({
    now,
    closesAt: "17:00",
    timezone: "America/Sao_Paulo",
    workingDays: [1, 2, 3, 4, 5],
  });
  assertIsoClose(cycle.startDatetimeIso, "2026-06-19T20:00:00.000Z");
  assert.match(cycle.labelCompact, /19\/06 17:00 – 22\/06 09:23/);
}

{
  const now = new Date("2026-06-22T09:23:00.000-03:00");
  const cycle = resolveOperationalDayCycle({
    now,
    closesAt: "17:00",
    timezone: "America/Sao_Paulo",
    workingDays: [1, 2, 3, 4, 5, 6],
  });
  assertIsoClose(cycle.startDatetimeIso, "2026-06-20T20:00:00.000Z");
  assert.match(cycle.labelCompact, /20\/06 17:00 – 22\/06 09:23/);
}

{
  const resolved = resolveExecutiveSummaryPeriod({
    period_preset: "operational_cycle",
    start_datetime: "2026-06-19T21:00:00.000Z",
    end_datetime: "2026-06-20T16:00:00.000Z",
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.period.preset, "operational_cycle");
  assert.equal(resolved.period.start_ms, Date.parse("2026-06-19T21:00:00.000Z"));
  assert.equal(resolved.period.end_ms_exclusive, Date.parse("2026-06-20T16:00:00.000Z") + 1);
}

console.log("[DASH.5] OK — todos os cenários unitários passaram");
