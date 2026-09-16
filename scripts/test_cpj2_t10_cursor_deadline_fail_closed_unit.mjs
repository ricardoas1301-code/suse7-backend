#!/usr/bin/env node
/**
 * CPJ2 T10 — cursor só avança após persist durável + deadline fail-closed + override clamp.
 */
import assert from "node:assert/strict";
import {
  computeEffectiveBudgetMs,
  createInvocationDeadline,
  resolveClampedPlatformOverrideMs,
  resolveDetectedPlatformCapMs,
  resolveOrderPersistWorkEstimateMs,
  resolvePersistSafetyMarginMs,
  resolvePlatformMaxDurationMs,
  isMarketplaceSyncServerlessRuntime,
  isVercelRuntime,
} from "../src/services/marketplace/marketplaceSyncInvocationDeadline.js";
import {
  advanceSalesCursorAfterConfirmedOrder,
  holdSalesCursorOnPersistFailure,
  parseSalesCursor,
  remainingOrderIdsForRetry,
  resolveSalesCursorDecision,
  serializeSalesCursor,
} from "../src/services/marketplace/salesSyncCursorSafety.js";

function withEnv(patch, fn) {
  const prev = {};
  for (const k of Object.keys(patch)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const cursor0 = parseSalesCursor(JSON.stringify({ search_offset: 50, idx_in_page: 3, seller_id: "s1" }));
assert.equal(cursor0.search_offset, 50);
assert.equal(cursor0.idx_in_page, 3);

{
  const d = resolveSalesCursorDecision({ skippedDeadline: true, detail: { id: "1" } });
  assert.equal(d.action, "hold_yield");
  assert.equal(d.reason, "deadline_before_detail");
  console.log("T10_1_FAIL_BEFORE_PERSIST=PASS");
}

{
  const d = resolveSalesCursorDecision({
    persistResult: { ok: false, reason: "lookup_failed" },
    detail: { id: "1", status: "paid" },
  });
  assert.equal(d.action, "hold_yield");
  const held = holdSalesCursorOnPersistFailure(cursor0, "ML-1");
  assert.equal(held.idx_in_page, 3, "lookup fail não avança idx");
  console.log("T10_2_FAIL_DURING_LOOKUP=PASS");
}

{
  const d = resolveSalesCursorDecision({
    persistError: new Error("upsert_failed"),
    detail: { id: "1", status: "paid" },
  });
  assert.equal(d.action, "hold_yield");
  assert.equal(d.reason, "persist_failed");
  console.log("T10_3_FAIL_DURING_UPSERT=PASS");
}

{
  const d = resolveSalesCursorDecision({
    timedOut: true,
    persistError: new Error("process_order_timeout_2500ms"),
    detail: { id: "1", status: "paid" },
  });
  assert.equal(d.action, "hold_yield");
  assert.equal(d.reason, "persist_timeout");
  const held = holdSalesCursorOnPersistFailure(cursor0, "HIST-OLD");
  assert.equal(held.idx_in_page, cursor0.idx_in_page);
  console.log("T10_4_TIMEOUT_DURING_PERSIST=PASS");
}

{
  const d = resolveSalesCursorDecision({
    persistResult: { ok: true, salesOrderId: "uuid" },
    detail: { id: "1", status: "paid" },
  });
  assert.equal(d.action, "advance_ok");
  const next = advanceSalesCursorAfterConfirmedOrder(cursor0);
  assert.equal(next.idx_in_page, 4);
  console.log("T10_5_PERSIST_SUCCESS=PASS");
}

{
  const slice = ["a", "b", "c", "d"];
  const startIdx = 0;
  const afterTwo = { search_offset: 0, idx_in_page: 2, seller_id: "s" };
  assert.deepEqual(remainingOrderIdsForRetry(slice, startIdx, afterTwo), ["c", "d"]);
  console.log("T10_6_REPEAT_REMAINING_BATCH=PASS");
}

{
  const afterPartial = advanceSalesCursorAfterConfirmedOrder(
    advanceSalesCursorAfterConfirmedOrder({ search_offset: 100, idx_in_page: 0, seller_id: "s" }),
  );
  assert.equal(afterPartial.idx_in_page, 2);
  assert.equal(afterPartial.search_offset, 100);
  console.log("T10_7_CURSOR_AFTER_PARTIAL_SUCCESS=PASS");
}

{
  const d = resolveSalesCursorDecision({ persistResult: null, persistError: new Error("killed"), detail: { id: "1" } });
  assert.equal(d.action, "hold_yield");
  console.log("T10_8_PROCESS_INTERRUPTED=PASS");
}

{
  const held = holdSalesCursorOnPersistFailure(cursor0, "ML-1");
  const roundtrip = parseSalesCursor(serializeSalesCursor(held));
  assert.equal(roundtrip.idx_in_page, 3);
  assert.equal(roundtrip.persist_fail_oid, "ML-1");
  console.log("T10_9_RESUME_OTHER_LEASE_CURSOR_SHAPE=PASS");
}

{
  const d = resolveSalesCursorDecision({
    timedOut: true,
    persistError: new Error("timeout"),
    detail: { id: "2000000001", status: "paid", date_created: "2024-01-01T00:00:00.000Z" },
  });
  assert.equal(d.action, "hold_yield");
  const held = holdSalesCursorOnPersistFailure({ search_offset: 400, idx_in_page: 17, seller_id: "hist" }, "2000000001");
  assert.equal(held.search_offset, 400);
  assert.equal(held.idx_in_page, 17);
  console.log("T10_10_HISTORICAL_ORDER_HELD=PASS");
}

{
  const first = advanceSalesCursorAfterConfirmedOrder(cursor0);
  const second = advanceSalesCursorAfterConfirmedOrder(cursor0);
  assert.equal(first.idx_in_page, second.idx_in_page);
  console.log("T10_11_NO_DUPLICATE_ADVANCE=PASS");
}

{
  const fail = resolveSalesCursorDecision({ persistResult: { ok: false, reason: "entitlement_blocked" }, detail: { status: "paid" } });
  assert.equal(fail.action, "hold_yield", "entitlement não descarta venda histórica");
  console.log("T10_12_NO_LOSS_ON_SOFT_FAIL=PASS");
}

withEnv({ VERCEL: "1", MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS: "30000" }, () => {
  assert.equal(resolvePlatformMaxDurationMs(), 30000);
  assert.equal(computeEffectiveBudgetMs(120000), 12000);
  console.log("T10_13_OVERRIDE_SMALLER=PASS");
});

withEnv({ VERCEL: "1", MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS: "180000" }, () => {
  assert.equal(resolveDetectedPlatformCapMs(), 60000);
  assert.equal(resolveClampedPlatformOverrideMs(), 60000, "override maior que cap Vercel não amplia");
  assert.equal(computeEffectiveBudgetMs(120000), 42000);
  console.log("T10_14_OVERRIDE_ABOVE_VERCEL_CAP=PASS");
});

withEnv({ VERCEL: "1", MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS: "abc" }, () => {
  assert.equal(resolvePlatformMaxDurationMs(), 60000);
  console.log("T10_15_OVERRIDE_INVALID=PASS");
});

withEnv({ VERCEL: "1", MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS: undefined }, () => {
  assert.equal(isVercelRuntime(), true);
  assert.equal(isMarketplaceSyncServerlessRuntime(), true);
  assert.equal(resolvePlatformMaxDurationMs(), 60000);
  assert.equal(resolveOrderPersistWorkEstimateMs(), 3000);
  console.log("T10_16_VERCEL_1=PASS");
});

withEnv({ VERCEL: "true", MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS: undefined }, () => {
  assert.equal(isVercelRuntime(), true);
  assert.equal(resolvePlatformMaxDurationMs(), 60000);
  console.log("T10_17_VERCEL_TRUE=PASS");
});

withEnv({ VERCEL: undefined, MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS: undefined }, () => {
  assert.equal(isVercelRuntime(), false);
  assert.equal(resolvePlatformMaxDurationMs(), 180000);
  assert.equal(computeEffectiveBudgetMs(120000), 120000);
  console.log("T10_18_VERCEL_ABSENT=PASS");
});

{
  let now = 0;
  const deadline = createInvocationDeadline({
    requestedBudgetMs: 120000,
    startedAtMs: 0,
    platformMaxDurationMs: 60000,
    shutdownMarginMs: 18000,
    nowFn: () => now,
  });
  now = 38000;
  assert.equal(deadline.getRemainingSoftMs(), 4000);
  assert.equal(deadline.shouldStopBeforePersist(3000, 1000), true, "igualdade estimate+margin bloqueia");
  console.log("T10_19_EXACT_MARGIN_LIMIT=PASS");
}

{
  let now = 0;
  const deadline = createInvocationDeadline({
    requestedBudgetMs: 120000,
    startedAtMs: 0,
    platformMaxDurationMs: 60000,
    shutdownMarginMs: 18000,
    nowFn: () => now,
  });
  now = 37999;
  assert.equal(deadline.getRemainingSoftMs(), 4001);
  assert.equal(deadline.shouldStopBeforePersist(3000, 1000), false, "1ms acima do limite permite");
  now = 38001;
  assert.equal(deadline.getRemainingSoftMs(), 3999);
  assert.equal(deadline.shouldStopBeforePersist(3000, 1000), true, "1ms abaixo bloqueia");
  now = 39000;
  assert.equal(deadline.shouldStopBeforeNextExternalWork(3000), true, "igualdade de estimate genérico bloqueia");
  now = 38999;
  assert.equal(deadline.shouldStopBeforeNextExternalWork(3000), false);
  console.log("T10_20_ONE_MS_AROUND_LIMIT=PASS");
}

assert.equal(resolvePersistSafetyMarginMs({}), 1000);
withEnv({ AWS_LAMBDA_FUNCTION_NAME: "sync" }, () => {
  assert.equal(isMarketplaceSyncServerlessRuntime(), true);
  assert.equal(resolveDetectedPlatformCapMs(), 60000);
});

console.log("T10_CURSOR_DEADLINE_ALL=PASS");
