/**
 * Testes unitários da janela incremental (watermark + overlap + teto catch-up + chunks).
 * node --test src/services/marketplace/mlIncrementalSalesWindow.test.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveIncrementalSalesWindow,
  resolveIncrementalSalesCatchupChunks,
} from "./mlIncrementalSalesPoll.js";

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
    assert.equal(w.catchup_clamped, false);
  });

  it("estende até watermark−overlap após outagem curta (sem clamp)", () => {
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
    assert.equal(w.catchup_clamped, false);
  });

  it("marca catchup_clamped quando outagem excede maxCatchupHours", () => {
    const wm = "2026-06-01T00:00:00.000Z";
    const w = resolveIncrementalSalesWindow({
      nowMs,
      lookbackHours: 6,
      overlapMinutes: 90,
      maxCatchupHours: 48,
      watermarkIso: wm,
    });
    assert.equal(w.rangeFrom, new Date(nowMs - 48 * 3600000).toISOString());
    assert.equal(w.catchup_clamped, true);
    assert.ok(w.desired_from);
    assert.ok(w.uncovered_through);
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
    assert.equal(w.catchup_clamped, false);
  });
});

describe("resolveIncrementalSalesCatchupChunks", () => {
  const nowMs = Date.parse("2026-08-10T14:00:00.000Z");

  it("gera múltiplos chunks quando lacuna > maxCatchupHours (sem descarte silencioso)", () => {
    const wm = "2026-07-27T12:21:55+00:00";
    const plan = resolveIncrementalSalesCatchupChunks({
      nowMs,
      lookbackHours: 6,
      overlapMinutes: 90,
      maxCatchupHours: 120,
      watermarkIso: wm,
    });
    assert.equal(plan.catchup_clamped, true);
    assert.ok(plan.total_chunks >= 2, `esperado >=2 chunks, obteve ${plan.total_chunks}`);

    const first = plan.chunks[0];
    const last = plan.chunks[plan.chunks.length - 1];
    const wmMs = Date.parse(wm) - 90 * 60000;
    assert.equal(first.rangeFrom, new Date(wmMs).toISOString());
    assert.equal(last.rangeTo, new Date(nowMs).toISOString());

    for (let i = 1; i < plan.chunks.length; i += 1) {
      const prevEnd = Date.parse(plan.chunks[i - 1].rangeTo);
      const curStart = Date.parse(plan.chunks[i].rangeFrom);
      assert.ok(curStart <= prevEnd, "chunks devem ser contíguos com overlap");
    }
  });

  it("watermark recente: um único chunk", () => {
    const wm = new Date(nowMs - 2 * 3600000).toISOString();
    const plan = resolveIncrementalSalesCatchupChunks({
      nowMs,
      lookbackHours: 6,
      overlapMinutes: 90,
      maxCatchupHours: 120,
      watermarkIso: wm,
    });
    assert.equal(plan.catchup_clamped, false);
    assert.equal(plan.total_chunks, 1);
  });
});
