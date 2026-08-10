/**
 * Testes unitários da janela incremental (watermark + overlap + teto catch-up).
 * node --test src/services/marketplace/mlIncrementalSalesWindow.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveIncrementalSalesWindow } from "./mlIncrementalSalesPoll.js";

describe("resolveIncrementalSalesWindow", () => {
  const nowMs = Date.parse("2026-07-27T20:00:00.000Z");

  it("usa lookback quando não há watermark", () => {
    const w = resolveIncrementalSalesWindow({
      nowMs,
      lookbackHours: 6,
      overlapMinutes: 90,
      maxCatchupHours: 120,
      watermarkIso: null,
    });
    assert.equal(w.rangeFrom, new Date(nowMs - 6 * 3600000).toISOString());
    assert.equal(w.rangeTo, new Date(nowMs).toISOString());
  });

  it("estende até watermark−overlap após outagem", () => {
    const wm = "2026-07-23T17:27:39.000Z";
    const w = resolveIncrementalSalesWindow({
      nowMs,
      lookbackHours: 6,
      overlapMinutes: 90,
      maxCatchupHours: 120,
      watermarkIso: wm,
    });
    const expectedFrom = Date.parse(wm) - 90 * 60000;
    assert.equal(w.rangeFrom, new Date(expectedFrom).toISOString());
  });

  it("respeita teto maxCatchup (sem full historical)", () => {
    const wm = "2026-06-01T00:00:00.000Z";
    const w = resolveIncrementalSalesWindow({
      nowMs,
      lookbackHours: 6,
      overlapMinutes: 90,
      maxCatchupHours: 48,
      watermarkIso: wm,
    });
    assert.equal(w.rangeFrom, new Date(nowMs - 48 * 3600000).toISOString());
  });

  it("watermark recente: lookback vence se for mais amplo", () => {
    const wm = new Date(nowMs - 1 * 3600000).toISOString();
    const w = resolveIncrementalSalesWindow({
      nowMs,
      lookbackHours: 6,
      overlapMinutes: 90,
      maxCatchupHours: 120,
      watermarkIso: wm,
    });
    assert.equal(w.rangeFrom, new Date(nowMs - 6 * 3600000).toISOString());
  });
});
