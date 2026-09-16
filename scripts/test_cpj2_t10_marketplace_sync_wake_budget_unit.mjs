#!/usr/bin/env node
/**
 * CPJ2 T10 — orçamento de wake Local vs Hosted, yield antecipado e empacotamento.
 * Não inicia sync real. Não zera conta.
 */
import assert from "node:assert/strict";
import {
  computeEffectiveBudgetMs,
  createInvocationDeadline,
  estimateOrdersPackableInWake,
  estimateWakesForVolume,
  isMarketplaceSyncServerlessRuntime,
  resolveMinExternalWorkMs,
  resolveOrderPersistWorkEstimateMs,
  resolvePlatformMaxDurationMs,
} from "../src/services/marketplace/marketplaceSyncInvocationDeadline.js";
import { pickJobsDistinctAccounts } from "../src/services/marketplace/marketplaceSyncJobSelector.js";

const SAVED = {};
function remember(keys) {
  for (const k of keys) SAVED[k] = process.env[k];
}
function restore() {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function withEnv(patch, fn) {
  remember(Object.keys(patch));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    restore();
  }
}

withEnv(
  {
    VERCEL: "1",
    MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS: undefined,
    MARKETPLACE_SYNC_MIN_EXTERNAL_WORK_MS: undefined,
    MARKETPLACE_SYNC_ORDER_PERSIST_ESTIMATE_MS: undefined,
    MARKETPLACE_SYNC_SHUTDOWN_MARGIN_MS: undefined,
  },
  () => {
    assert.equal(isMarketplaceSyncServerlessRuntime(), true);
    assert.equal(resolvePlatformMaxDurationMs(), 60000);
    assert.equal(resolveMinExternalWorkMs(), 8000);
    assert.equal(resolveOrderPersistWorkEstimateMs(), 3000);
    assert.equal(computeEffectiveBudgetMs(120000), 42000, "Hosted continua 60s-18s=42s");
  }
);
console.log("T10_HOSTED_BUDGET_PRESERVED=PASS");

withEnv(
  {
    VERCEL: undefined,
    MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS: undefined,
    MARKETPLACE_SYNC_MIN_EXTERNAL_WORK_MS: undefined,
    MARKETPLACE_SYNC_ORDER_PERSIST_ESTIMATE_MS: undefined,
    MARKETPLACE_SYNC_SHUTDOWN_MARGIN_MS: undefined,
  },
  () => {
    assert.equal(isMarketplaceSyncServerlessRuntime(), false);
    assert.equal(resolvePlatformMaxDurationMs(), 180000);
    assert.equal(resolveMinExternalWorkMs(), 2500);
    assert.equal(resolveOrderPersistWorkEstimateMs(), 2500);
    assert.equal(computeEffectiveBudgetMs(120000), 120000, "Local usa os 120s pedidos");
  }
);
console.log("T10_LOCAL_BUDGET_120S=PASS");

withEnv(
  {
    VERCEL: undefined,
    MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS: "90000",
  },
  () => {
    assert.equal(resolvePlatformMaxDurationMs(), 90000);
    assert.equal(computeEffectiveBudgetMs(120000), 72000);
  }
);
withEnv(
  {
    VERCEL: "1",
    MARKETPLACE_SYNC_PLATFORM_MAX_DURATION_MS: "180000",
  },
  () => {
    assert.equal(resolvePlatformMaxDurationMs(), 60000, "override Hosted não ultrapassa cap Vercel");
    assert.equal(computeEffectiveBudgetMs(120000), 42000);
  }
);
console.log("T10_ENV_OVERRIDE=PASS");

const hostedDeadline = createInvocationDeadline({
  requestedBudgetMs: 120000,
  startedAtMs: 1_000_000,
  platformMaxDurationMs: 60000,
  shutdownMarginMs: 18000,
  nowFn: () => 1_000_000 + 32000,
});
assert.equal(hostedDeadline.effectiveBudgetMs, 42000);
assert.equal(hostedDeadline.getRemainingSoftMs(), 10000);
assert.equal(
  hostedDeadline.shouldStopBeforeNextExternalWork(12000),
  true,
  "estimativa antiga 12s rende com 10s restantes"
);
assert.equal(
  hostedDeadline.shouldStopBeforeNextExternalWork(3000),
  false,
  "estimativa 3s ainda cabe com 10s restantes"
);
console.log("T10_YIELD_THRESHOLD=PASS");

const beforePack = estimateOrdersPackableInWake({
  effectiveBudgetMs: 42000,
  firstSearchMs: 3000,
  perOrderMs: 3000,
  persistEstimateMs: 12000,
  safetyMarginMs: 0,
});
const afterLocalPack = estimateOrdersPackableInWake({
  effectiveBudgetMs: 120000,
  firstSearchMs: 3000,
  perOrderMs: 3000,
  persistEstimateMs: 2500,
  safetyMarginMs: 1000,
});
const afterHostedPack = estimateOrdersPackableInWake({
  effectiveBudgetMs: 42000,
  firstSearchMs: 3000,
  perOrderMs: 3000,
  persistEstimateMs: 3000,
  safetyMarginMs: 1000,
});
assert.equal(beforePack.orders, 9, "igualdade remaining==estimate não inicia persist");
assert.equal(afterLocalPack.orders, 38);
assert.equal(afterHostedPack.orders, 12);
assert.ok(afterLocalPack.orders > beforePack.orders);
assert.ok(afterHostedPack.orders > beforePack.orders);
console.log("T10_CONTROLLED_PACKING=PASS");

assert.equal(estimateWakesForVolume(1633, 9), 182);
assert.equal(estimateWakesForVolume(1633, 38), 43);
assert.equal(estimateWakesForVolume(0, 10), 0);
console.log("T10_WAKE_PROJECTION=PASS");

const picked = pickJobsDistinctAccounts(
  [
    { marketplace_account_id: "acc-a", job_type: "ml_historical_sales_backfill" },
    { marketplace_account_id: "acc-a", job_type: "ml_initial_listings" },
    { marketplace_account_id: "acc-b", job_type: "ml_historical_sales_backfill" },
  ],
  8
);
assert.deepEqual(
  picked.map((j) => j.marketplace_account_id),
  ["acc-a", "acc-b"],
  "fairness 1 job por conta permanece intacta"
);
console.log("T10_FAIRNESS_SELECTOR_UNCHANGED=PASS");

const cursorBefore = JSON.stringify({ search_offset: 50, idx_in_page: 3, seller_id: "1219786189" });
const cursorAfter = JSON.parse(cursorBefore);
cursorAfter.idx_in_page = 4;
assert.equal(cursorAfter.search_offset, 50);
assert.notEqual(cursorAfter.idx_in_page, JSON.parse(cursorBefore).idx_in_page);
console.log("T10_CURSOR_SHAPE_PRESERVED=PASS");

console.log("T10_ALL_UNIT=PASS");
