#!/usr/bin/env node
/**
 * FIN.SSOT.SNAPSHOT-IMMUTABILITY.01 — testes unitários de preservação.
 */

import assert from "node:assert/strict";
import {
  mergeIncomingSalesOrderItemWithExistingSnapshot,
  isSellerHistoricalFinancialSnapshotFrozen,
  extractExistingFinancialSnapshot,
} from "../src/domain/sales/salesOrderItemSnapshotPreservation.js";
import { isItemFinancialSnapshotComplete } from "../src/services/marketplace/mercadoLivreSaleFinancialEnrichment.js";

function buildFrozenFinancial(overrides = {}) {
  return {
    snapshot_version: "ml_financial_v2",
    snapshot_complete: true,
    snapshot_origin: "post_suse7_sale",
    snapshot_quality: "historical",
    snapshot_created_at: "2026-08-07T12:00:00.000Z",
    immutable_since: "2026-08-07T12:00:00.000Z",
    gross_sale_amount_brl: "45.71",
    marketplace_fee_amount_brl: "6.86",
    shipping_amount_brl: "6.85",
    net_received_amount_brl: "31.23",
    tax_snapshot: {
      amount_brl: "1.37",
      tax_percent_applied: "3.00",
      source: "seller_company_tax_profile",
    },
    internal_costs_snapshot: {
      internal_tax_brl: "1.37",
      product_cost_brl: "10.00",
      tax_percent_applied: "3.00",
    },
    product_cost_snapshot: { amount_brl: "10.00" },
    ...overrides,
  };
}

function testFirstCaptureNoExisting() {
  const incoming = {
    external_order_item_id: "MLI1",
    raw_json: { id: "MLI1", unit_price: 45.71 },
    net_amount: null,
    shipping_share_amount: null,
  };
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(incoming, null);
  assert.equal(merged.raw_json._s7_financial, undefined);
  assert.equal(merged.net_amount, null);
}

function testReprocessingPreservesHistoricalSnapshot() {
  const existingFin = buildFrozenFinancial();
  const existing = {
    external_order_item_id: "MLI1",
    fee_amount: "6.86",
    shipping_share_amount: "6.85",
    net_amount: "31.23",
    raw_json: {
      id: "MLI1",
      unit_price: 45.71,
      _s7_financial: existingFin,
    },
  };
  const incoming = {
    external_order_item_id: "MLI1",
    fee_amount: "6.86",
    shipping_share_amount: null,
    net_amount: "38.08",
    raw_json: { id: "MLI1", unit_price: 45.71 },
  };

  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(incoming, existing, {
    isMarketplaceSnapshotComplete: isItemFinancialSnapshotComplete,
  });

  assert.deepEqual(merged.raw_json._s7_financial, existingFin);
  assert.equal(String(merged.shipping_share_amount), "6.85");
  assert.equal(String(merged.net_amount), "31.23");
  assert.equal(merged.raw_json._s7_financial.tax_snapshot.amount_brl, "1.37");
  assert.equal(merged.raw_json._s7_financial.immutable_since, "2026-08-07T12:00:00.000Z");
}

function testSellerTaxConfigChangeDoesNotAlterPreservedSnapshot() {
  const existingFin = buildFrozenFinancial({
    tax_snapshot: {
      amount_brl: "21.38",
      tax_percent_applied: "16.00",
      source: "seller_company_tax_profile",
    },
  });
  const existing = {
    raw_json: { _s7_financial: existingFin },
    net_amount: "100.00",
    shipping_share_amount: "10.00",
    fee_amount: "5.00",
  };
  const incoming = {
    raw_json: { id: "x" },
    net_amount: null,
    shipping_share_amount: null,
    fee_amount: "5.00",
  };
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(incoming, existing, {
    isMarketplaceSnapshotComplete: isItemFinancialSnapshotComplete,
  });
  assert.equal(merged.raw_json._s7_financial.tax_snapshot.tax_percent_applied, "16.00");
  assert.equal(merged.raw_json._s7_financial.tax_snapshot.amount_brl, "21.38");
}

function testProductCostOpPackAdsPreservedInRawJson() {
  const existingFin = buildFrozenFinancial({
    product_cost_snapshot: { amount_brl: "14.50" },
    operational_cost_snapshot: { operation_packaging_cost_brl: "2.00" },
    ads_snapshot: { amount_brl: "1.10" },
    contingency_margin_snapshot: { ml_ads_brl: "1.10", reserve_brl: "0.50" },
  });
  const existing = { raw_json: { _s7_financial: existingFin }, net_amount: "10.00" };
  const incoming = { raw_json: { id: "line" }, net_amount: null };
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(incoming, existing, {
    isMarketplaceSnapshotComplete: isItemFinancialSnapshotComplete,
  });
  assert.equal(merged.raw_json._s7_financial.product_cost_snapshot.amount_brl, "14.50");
  assert.equal(merged.raw_json._s7_financial.ads_snapshot.amount_brl, "1.10");
}

function testSettlementUpdateHappensAtEnrichmentNotCanonicalUpsert() {
  const existingFin = buildFrozenFinancial();
  assert.ok(isItemFinancialSnapshotComplete(existingFin));
  const incoming = {
    raw_json: { id: "MLI1" },
    fee_amount: "7.00",
    shipping_share_amount: "7.00",
    net_amount: "30.00",
  };
  const existing = {
    raw_json: { _s7_financial: existingFin },
    fee_amount: "6.86",
    shipping_share_amount: "6.85",
    net_amount: "31.23",
  };
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(incoming, existing, {
    isMarketplaceSnapshotComplete: isItemFinancialSnapshotComplete,
  });
  assert.equal(String(merged.fee_amount), "6.86");
  assert.equal(String(merged.shipping_share_amount), "6.85");
  assert.equal(String(merged.net_amount), "31.23");
  assert.equal(merged.raw_json._s7_financial.tax_snapshot.amount_brl, "1.37");
}

function testPartialIncomingDoesNotRegressCompleteColumns() {
  const existing = {
    raw_json: { _s7_financial: buildFrozenFinancial() },
    fee_amount: "6.86",
    shipping_share_amount: "6.85",
    net_amount: "31.23",
  };
  const incoming = {
    raw_json: { id: "MLI1" },
    fee_amount: "6.86",
    shipping_share_amount: null,
    net_amount: "38.08",
  };
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(incoming, existing, {
    isMarketplaceSnapshotComplete: isItemFinancialSnapshotComplete,
  });
  assert.equal(String(merged.net_amount), "31.23");
  assert.equal(merged.raw_json._s7_financial.immutable_since, "2026-08-07T12:00:00.000Z");
}

function testReconstructedSnapshotNotFrozen() {
  const fin = buildFrozenFinancial({
    snapshot_quality: "reconstructed",
    snapshot_origin: "onboarding_import",
  });
  assert.equal(isSellerHistoricalFinancialSnapshotFrozen(fin), false);
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(
    { raw_json: { id: "x" }, net_amount: "1.00" },
    { raw_json: { _s7_financial: fin }, net_amount: "9.00" },
    { isMarketplaceSnapshotComplete: isItemFinancialSnapshotComplete },
  );
  assert.equal(merged.raw_json._s7_financial, undefined);
}

function testExtractExistingFinancialSnapshot() {
  const fin = buildFrozenFinancial();
  const extracted = extractExistingFinancialSnapshot({ raw_json: { _s7_financial: fin } });
  assert.equal(extracted?.tax_snapshot?.amount_brl, "1.37");
}

function testCanonicalUpsertPreservesThroughMergeRegressionCase5918634() {
  const existingFin = buildFrozenFinancial({
    shipping_amount_brl: "6.85",
    net_received_amount_brl: "31.23",
    tax_snapshot: {
      amount_brl: "1.37",
      tax_percent_applied: "3.00",
      source: "seller_company_tax_profile",
    },
    snapshot_created_at: "2026-08-10T22:15:37.391Z",
    immutable_since: "2026-08-10T22:15:37.391Z",
    formula_debug: {
      selected_shipping: "6.85",
      selected_shipping_source: "shipping_option.list_cost_minus_cost",
    },
  });
  const existing = {
    external_order_item_id: "2000017855918634",
    fee_amount: "6.86",
    shipping_share_amount: "6.85",
    net_amount: "31.23",
    raw_json: { id: "2000017855918634", _s7_financial: existingFin },
  };
  const incoming = {
    external_order_item_id: "2000017855918634",
    fee_amount: "6.86",
    shipping_share_amount: null,
    net_amount: "38.08",
    raw_json: { id: "2000017855918634", unit_price: 45.71 },
  };
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(incoming, existing, {
    isMarketplaceSnapshotComplete: isItemFinancialSnapshotComplete,
  });
  assert.equal(String(merged.net_amount), "31.23");
  assert.equal(String(merged.shipping_share_amount), "6.85");
  assert.equal(merged.raw_json._s7_financial.immutable_since, "2026-08-10T22:15:37.391Z");
}

testFirstCaptureNoExisting();
testReprocessingPreservesHistoricalSnapshot();
testSellerTaxConfigChangeDoesNotAlterPreservedSnapshot();
testProductCostOpPackAdsPreservedInRawJson();
testSettlementUpdateHappensAtEnrichmentNotCanonicalUpsert();
testPartialIncomingDoesNotRegressCompleteColumns();
testReconstructedSnapshotNotFrozen();
testExtractExistingFinancialSnapshot();
testCanonicalUpsertPreservesThroughMergeRegressionCase5918634();

console.log("[OK] test_sales_order_item_snapshot_preservation_unit");
