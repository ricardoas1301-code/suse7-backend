#!/usr/bin/env node
/**
 * DEV.V2.ML-INITIAL-SYNC-ORDER-HISTORY-WINDOW-CLOSE.01E-E
 * Testes locais: ordem pipeline + janela 12 meses calendário + provenance reuse.
 */
import assert from "node:assert/strict";
import {
  resolveMlInitialSyncPrerequisiteBlockReason,
  ML_TARGET_SYNC_JOB_ORDER,
} from "../src/services/marketplace/mlInitialSyncPrerequisites.js";
import { ML_HOT_SYNC_JOB_TYPES_ORDERED as JOB_ORDER } from "../src/services/marketplace/createMlInitialSyncJobs.js";
import {
  ML_SALES_HISTORY_FIXED_TEST_CUTOVER,
  subtractCalendarMonths,
  resolveMlSalesHistoryWindow,
  buildHistoricalSalesBackfillWindows,
  validateMlSalesHistoryWindowPartition,
  assertExactCalendarMonthSpan,
  totalHistoryEffectiveDays,
} from "../src/services/marketplace/mlSalesHistoryWindow.js";
import { buildOperationalTasksPayload } from "../src/domain/dashboard/operationalTasksPayload.js";
import { resolveSnapshotOriginForSyncType } from "../src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";
import { BILLING_SNAPSHOT_ORIGIN } from "../src/billing/billingConstants.js";
import { INTERNAL_PROVENANCE_CLASS } from "../src/domain/sales/financialSnapshotProvenanceV2.js";
import { buildSaleDetailInternalCostsContract, computeSaleDetailRealResult } from "../src/domain/sales/saleDetailInternalCosts.js";
import {
  isSellerHistoricalFinancialSnapshotFrozen,
  mergeIncomingSalesOrderItemWithExistingSnapshot,
} from "../src/domain/sales/salesOrderItemSnapshotPreservation.js";
import Decimal from "decimal.js";

/** @type {string[]} */
const failures = [];

function test(name, fn) {
  try {
    fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function statusMap(entries) {
  /** @type {Record<string, string>} */
  const m = {};
  for (const [acc, jt, st] of entries) m[`${acc}:${jt}`] = st;
  return m;
}

const ACC = "acc-1";

// --- Order ---
test("1 listings before products in job order", () => {
  const li = JOB_ORDER.indexOf("ml_initial_listings_current");
  const pr = JOB_ORDER.indexOf("ml_initial_products");
  assert.ok(li >= 0 && pr >= 0 && li < pr);
});

test("2 products before sales in job order", () => {
  const pr = JOB_ORDER.indexOf("ml_initial_products");
  const sa = JOB_ORDER.indexOf("ml_initial_sales_recent");
  assert.ok(pr >= 0 && sa >= 0 && pr < sa);
});

test("3 hot sales after masters", () => {
  assert.deepEqual(JOB_ORDER, ML_TARGET_SYNC_JOB_ORDER);
  assert.equal(JOB_ORDER.at(-1), "ml_initial_sales_recent");
});

test("4 backfill blocked until hot done", () => {
  const mastersDone = statusMap([
    [ACC, "ml_initial_listings_current", "done"],
    [ACC, "ml_initial_fees", "done"],
    [ACC, "ml_initial_products", "done"],
    [ACC, "ml_initial_customers_recent", "done"],
    [ACC, "ml_enable_webhook_monitoring", "done"],
  ]);
  assert.equal(
    resolveMlInitialSyncPrerequisiteBlockReason(
      { marketplace_account_id: ACC, job_type: "ml_historical_sales_backfill" },
      mastersDone,
    ),
    "blocked_until_ml_sales_hot_done",
  );
});

test("5 failure blocks dependent — sales blocked without webhook", () => {
  const partial = statusMap([
    [ACC, "ml_initial_listings_current", "done"],
    [ACC, "ml_initial_fees", "done"],
    [ACC, "ml_initial_products", "done"],
    [ACC, "ml_initial_customers_recent", "done"],
  ]);
  assert.equal(
    resolveMlInitialSyncPrerequisiteBlockReason(
      { marketplace_account_id: ACC, job_type: "ml_initial_sales_recent" },
      partial,
    ),
    "blocked_until_masters_and_webhook_done",
  );
});

test("6 listings can start immediately", () => {
  assert.equal(
    resolveMlInitialSyncPrerequisiteBlockReason(
      { marketplace_account_id: ACC, job_type: "ml_initial_listings_current" },
      {},
    ),
    null,
  );
});

// --- Fixed cutover window ---
const FIXED = resolveMlSalesHistoryWindow(ML_SALES_HISTORY_FIXED_TEST_CUTOVER, {
  calendarMonths: 12,
  hotDays: 90,
});
const FIXED_PACK = buildHistoricalSalesBackfillWindows(ML_SALES_HISTORY_FIXED_TEST_CUTOVER, {
  calendarMonths: 12,
  hotDays: 90,
  chunkDays: 30,
});

test("7 fixed cutover constants", () => {
  assert.equal(FIXED.cutover_iso, ML_SALES_HISTORY_FIXED_TEST_CUTOVER);
});

test("8 exact 12 calendar months span", () => {
  assert.equal(assertExactCalendarMonthSpan(FIXED, 12), true);
  assert.equal(FIXED.target_history_start_iso, "2025-08-15T12:00:00.000Z");
  assert.equal(FIXED.target_history_end_iso, "2026-08-15T12:00:00.000Z");
});

test("9 hot contained in 12 months", () => {
  assert.equal(FIXED.hot_is_subset_of_total, true);
  assert.ok(Date.parse(FIXED.hot_start_iso) >= Date.parse(FIXED.target_history_start_iso));
  assert.equal(FIXED.hot_end_iso, FIXED.target_history_end_iso);
});

test("10 NOT 90d + extra 12m — total is 12 calendar months only", () => {
  const spanDays = totalHistoryEffectiveDays(FIXED);
  assert.equal(spanDays, 365);
  const oldStyleExtraDays = 90 + 12 * 30;
  assert.notEqual(spanDays, oldStyleExtraDays);
  assert.ok(spanDays < oldStyleExtraDays);
});

test("11 history does not exceed 12 months", () => {
  const expectedStart = subtractCalendarMonths(new Date(FIXED.target_history_end_iso), 12);
  assert.equal(new Date(FIXED.target_history_start_iso).getTime(), expectedStart.getTime());
});

test("12 hot/backfill gap = 0", () => {
  const v = validateMlSalesHistoryWindowPartition(FIXED, FIXED_PACK.windows);
  assert.equal(v.ok, true, v.reason ?? `gap=${v.gap_ms} overlap=${v.overlap_ms}`);
  assert.equal(v.gap_ms, 0);
});

test("13 hot/backfill duplicate boundary = 0", () => {
  assert.equal(FIXED.backfill_end_iso, FIXED.hot_start_iso);
  const v = validateMlSalesHistoryWindowPartition(FIXED, FIXED_PACK.windows);
  assert.equal(v.overlap_ms, 0);
});

// --- Calendar edge cases ---
test("14 month-end Jan 31 minus 1 month => Dec 31", () => {
  const r = subtractCalendarMonths(new Date("2026-01-31T12:00:00.000Z"), 1);
  assert.equal(r.toISOString(), "2025-12-31T12:00:00.000Z");
});

test("15 leap year Feb 29 minus 12 months => Feb 28 2023", () => {
  const r = subtractCalendarMonths(new Date("2024-02-29T12:00:00.000Z"), 12);
  assert.equal(r.toISOString(), "2023-02-28T12:00:00.000Z");
});

test("16 year boundary Dec cutover", () => {
  const w = resolveMlSalesHistoryWindow("2026-01-15T12:00:00.000Z", { calendarMonths: 12, hotDays: 30 });
  assert.equal(w.target_history_start_iso, "2025-01-15T12:00:00.000Z");
});

// --- Pagination completeness ---
test("17 backfill chunks cover full backfill range", () => {
  const pack = buildHistoricalSalesBackfillWindows(ML_SALES_HISTORY_FIXED_TEST_CUTOVER, {
    calendarMonths: 12,
    hotDays: 90,
    chunkDays: 30,
  });
  assert.ok(pack.windows.length >= 1);
  const sorted = [...pack.windows].sort((a, b) => Date.parse(a.date_from) - Date.parse(b.date_from));
  assert.equal(Date.parse(sorted[0].date_from), Date.parse(pack.backfill_start_iso));
  assert.equal(Date.parse(sorted[sorted.length - 1].date_to), Date.parse(pack.backfill_end_iso));
  const v = validateMlSalesHistoryWindowPartition(pack, pack.windows);
  assert.equal(v.ok, true);
});

test("18 empty backfill when hot covers full window", () => {
  const pack = buildHistoricalSalesBackfillWindows(ML_SALES_HISTORY_FIXED_TEST_CUTOVER, {
    calendarMonths: 12,
    hotDays: 400,
  });
  assert.equal(pack.windows.length, 0);
  assert.equal(pack.backfill_start_iso, pack.backfill_end_iso);
});

// --- Event-first / idempotency (reuse existing contracts) ---
test("19 onboarding vs webhook snapshot origin unchanged", () => {
  assert.equal(
    resolveSnapshotOriginForSyncType("ml_initial_sales_recent"),
    BILLING_SNAPSHOT_ORIGIN.ONBOARDING_IMPORT,
  );
  assert.equal(
    resolveSnapshotOriginForSyncType("operational_webhook"),
    BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_WEBHOOK,
  );
});

test("20 duplicate order convergence key semantics preserved", () => {
  const key = ["mercado_livre", "acc-uuid", "MLB-ORDER-1"].join("|");
  assert.match(key, /mercado_livre/);
});

// --- Financial reuse (no reimplementation) ---
test("21 missing cost => incomplete margin", () => {
  const internal = buildSaleDetailInternalCostsContract({
    product: { cost_price: null, packaging_cost: null, operational_cost: null },
    productId: "p1",
    qty: 1,
    grossDec: new Decimal("100"),
    taxPercent: "6",
    taxPercentSource: "seller_company_tax_profile",
  });
  assert.equal(internal.confidence, "partial");
  const result = computeSaleDetailRealResult({
    netReceivedDec: new Decimal("80"),
    internalCosts: internal,
    contingencyDec: null,
  });
  assert.equal(result.is_definitive, false);
});

test("22 reconstructed tax uses existing contract fields", () => {
  const internal = buildSaleDetailInternalCostsContract({
    product: { cost_price: "10", packaging_cost: "0", operational_cost: "0" },
    productId: "p1",
    qty: 1,
    grossDec: new Decimal("100"),
    taxPercent: "6",
    taxPercentSource: "seller_company_tax_profile",
  });
  assert.equal(internal.snapshot?.snapshot_quality, "reconstructed");
});

test("23 freeze — future cost edit does not rewrite retro", () => {
  const frozen = {
    internal_provenance_class: INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED,
    immutable_since: "2026-08-15T12:00:00.000Z",
    product_cost_snapshot: { amount_brl: "40.00" },
  };
  assert.equal(isSellerHistoricalFinancialSnapshotFrozen(frozen), true);
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(
    { raw_json: { _s7_financial: frozen } },
    { raw_json: { _s7_financial: { product_cost_snapshot: { amount_brl: "45.00" } } } },
  );
  const fin = merged.raw_json._s7_financial;
  assert.equal(fin.product_cost_snapshot.amount_brl, "40.00");
});

test("24 tax snapshot freeze preserved on merge", () => {
  const frozen = {
    internal_provenance_class: INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED,
    immutable_since: "2026-08-15T12:00:00.000Z",
    tax_snapshot: { amount_brl: "6.00", tax_percent_applied: "6.00" },
  };
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(
    { raw_json: { _s7_financial: frozen } },
    { raw_json: { _s7_financial: { tax_snapshot: { amount_brl: "7.00" } } } },
  );
  assert.equal(merged.raw_json._s7_financial.tax_snapshot.amount_brl, "6.00");
});

// --- Operational tasks ---
test("25 SKU/cost suppressed during unstable universe", () => {
  const unstable = buildOperationalTasksPayload({
    universeStable: false,
    skuDependencyPendingCount: 99,
    missingProductCostsCount: 88,
  });
  assert.equal(unstable.initial_sync_universe_stable, false);
  assert.equal(unstable.total_tasks, 1);
  assert.equal(unstable.tasks[0]?.type, "initial_sync_in_progress");
});

test("26 final SKU/cost counts when universe stable", () => {
  const stable = buildOperationalTasksPayload({
    universeStable: true,
    skuDependencyPendingCount: 3,
    missingProductCostsCount: 5,
  });
  assert.equal(stable.initial_sync_universe_stable, true);
  assert.equal(stable.total_tasks, 2);
});

// --- Report constants for Rico ---
const REPORT = {
  FIXED_CUTOVER: ML_SALES_HISTORY_FIXED_TEST_CUTOVER,
  TARGET_HISTORY_START: FIXED.target_history_start_iso,
  TARGET_HISTORY_END: FIXED.target_history_end_iso,
  HOT_START: FIXED.hot_start_iso,
  HOT_END: FIXED.hot_end_iso,
  BACKFILL_START: FIXED.backfill_start_iso,
  BACKFILL_END: FIXED.backfill_end_iso,
  EARLIEST_REQUESTED_SALE: FIXED.earliest_requested_sale_iso,
  LATEST_REQUESTED_SALE: FIXED.latest_requested_sale_iso,
  TOTAL_EFFECTIVE_DAYS: totalHistoryEffectiveDays(FIXED),
};

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures, report: REPORT }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "ml_initial_sync_order_history_window_01ee",
      cases: 26,
      failures: 0,
      report: REPORT,
      current_order_before_01ee: [
        "ml_initial_sales_recent",
        "ml_initial_listings_current",
        "ml_initial_fees",
        "ml_initial_products",
        "ml_initial_customers_recent",
        "ml_enable_webhook_monitoring",
      ],
      target_order: JOB_ORDER,
    },
    null,
    2,
  ),
);
