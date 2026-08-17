#!/usr/bin/env node
/**
 * FIN.SSOT.PROVENANCE-V2.DEV.03 — compatibility gate (executive, detail, edge cases).
 */

import assert from "node:assert/strict";
import Decimal from "decimal.js";
import {
  INTERNAL_PROVENANCE_CLASS,
  LEGACY_SNAPSHOT_QUALITY_BY_INTERNAL_CLASS,
  OPERATIONAL_ORIGIN_EXTENDED,
  normalizeOperationalOrigin,
  resolveFinancialSnapshotProvenanceV2,
  resolveInternalProvenanceClassForRead,
} from "../src/domain/sales/financialSnapshotProvenanceV2.js";
import { computeExecutiveLineRealProfit } from "../src/domain/sales/saleExecutiveLineRealResult.js";
import { buildSaleDetailFinancialBreakdown } from "../src/handlers/sales/saleDetailFinancial.js";
import { resolveSnapshotOriginForSyncType } from "../src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";
import { BILLING_SNAPSHOT_ORIGIN } from "../src/billing/billingConstants.js";
import {
  isSellerHistoricalFinancialSnapshotFrozen,
  mergeIncomingSalesOrderItemWithExistingSnapshot,
} from "../src/domain/sales/salesOrderItemSnapshotPreservation.js";
import { isItemFinancialSnapshotComplete } from "../src/services/marketplace/mercadoLivreSaleFinancialEnrichment.js";

const NOW = "2026-08-12T19:21:11.743Z";
const SALE_CREATED = "2026-08-12T19:19:32.000Z";

/** @type {string[]} */
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`FAIL ${name}`, err instanceof Error ? err.message : err);
  }
}

function buildSmokeV2Financial(overrides = {}) {
  return {
    snapshot_version: "ml_financial_v2",
    snapshot_complete: true,
    operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_WEBHOOK,
    snapshot_origin: "post_suse7_sale",
    internal_provenance_class: INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION,
    snapshot_quality: LEGACY_SNAPSHOT_QUALITY_BY_INTERNAL_CLASS.CAPTURED_AT_INGESTION,
    estimated: false,
    reconstructed_at: null,
    snapshot_created_at: NOW,
    immutable_since: NOW,
    sale_created_at: SALE_CREATED,
    captured_at: NOW,
    capture_lag_seconds: 100,
    gross_sale_amount_brl: "73.80",
    marketplace_fee_amount_brl: "12.92",
    shipping_amount_brl: "28.90",
    net_received_amount_brl: "31.98",
    tax_snapshot: { amount_brl: "2.21", tax_percent_applied: "3.00" },
    product_cost_snapshot: { amount_brl: "32.00" },
    internal_costs_snapshot: {
      product_cost_brl: "32.00",
      internal_tax_brl: "2.21",
      operation_packaging_cost_brl: "1.32",
      confidence: "persisted",
    },
    operational_cost_snapshot: { reserve_brl: "0.00", operation_packaging_cost_brl: "1.32" },
    ads_snapshot: { amount_brl: "0.00" },
    contingency_margin_snapshot: { ml_ads_brl: "0.00", reserve_brl: "0.00" },
    ...overrides,
  };
}

function buildItemFromFinancial(fin, overrides = {}) {
  return {
    id: "item-v2-smoke",
    quantity: 1,
    gross_amount: fin.gross_sale_amount_brl,
    fee_amount: fin.marketplace_fee_amount_brl,
    shipping_share_amount: fin.shipping_amount_brl,
    net_amount: fin.net_received_amount_brl,
    raw_json: { _s7_financial: fin },
    ...overrides,
  };
}

test("executive summary — V2 CAPTURED não perde tax/produto/op-pack/lucro/margem", () => {
  const v2Fin = buildSmokeV2Financial();
  const legacyFin = buildSmokeV2Financial({
    internal_provenance_class: undefined,
    operational_origin: undefined,
    snapshot_quality: "historical",
  });

  const v2Item = buildItemFromFinancial(v2Fin);
  const legacyItem = buildItemFromFinancial(legacyFin);
  const grossDec = new Decimal("73.80");
  const netDec = new Decimal("31.98");

  const v2Line = computeExecutiveLineRealProfit({ item: v2Item, qty: 1, grossDec, netDec });
  const legacyLine = computeExecutiveLineRealProfit({ item: legacyItem, qty: 1, grossDec, netDec });

  assert.equal(v2Line.internalTaxDec?.toFixed(2), "2.21");
  assert.equal(v2Line.productCostDec?.toFixed(2), "32.00");
  assert.equal(v2Line.operationPackagingDec?.toFixed(2), "1.32");
  assert.equal(v2Line.profitDec?.toFixed(2), legacyLine.profitDec?.toFixed(2));
  assert.notEqual(v2Line.profitDec, null);
  assert.equal(v2Line.profitDec?.toFixed(2), "-3.55");
  const margin = v2Line.profitDec.div(grossDec).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  assert.ok(margin.lt(0));
});

test("detail / Raio-X — V2 CAPTURED retorna breakdown financeiro completo", () => {
  const fin = buildSmokeV2Financial();
  const item = buildItemFromFinancial(fin, {
    gross_amount: "73.80",
    net_amount: "31.98",
    fee_amount: "12.92",
    shipping_share_amount: "28.90",
  });

  const breakdown = buildSaleDetailFinancialBreakdown(item, null, null, null, {});

  assert.equal(String(fin.snapshot_quality), "historical");
  assert.equal(fin.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION);
  assert.ok(breakdown.marketplace_revenue);
  assert.equal(breakdown.internal_costs?.product_cost_brl, "32.00");
  assert.equal(breakdown.internal_costs?.internal_tax_brl, "2.21");
  assert.equal(breakdown.internal_costs?.operation_packaging_cost_brl, "1.32");
  assert.equal(breakdown.internal_costs?.snapshot?.snapshot_quality, "historical");
  assert.equal(breakdown.profit_brl, "-3.55");
  assert.equal(breakdown.margin_percent, "-4.81");
  assert.equal(breakdown.gross_amount, "73.80");
  assert.equal(breakdown.net_received_amount, "31.98");
});

test("first enrichment failure — retry conservador RECONSTRUCTED_ESTIMATED", () => {
  const meta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_WEBHOOK,
      is_initial_canonical_persist: false,
      sale_created_at: SALE_CREATED,
    },
    null,
    NOW,
  );
  assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED);
  assert.notEqual(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION);
  assert.equal(meta.snapshot_quality, "reconstructed");
  assert.equal(meta.estimated, true);
});

test("multi-item partial — item novo em order existente → RECONSTRUCTED_ESTIMATED", () => {
  const meta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_WEBHOOK,
      is_initial_canonical_persist: false,
      sale_created_at: SALE_CREATED,
    },
    null,
    NOW,
  );
  assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED);
  assert.equal(meta.snapshot_quality, "reconstructed");
});

test("operational origin — webhook/sync/reconciliation/lazy/backfill/onboarding", () => {
  assert.equal(
    resolveSnapshotOriginForSyncType("ml_webhook", "operational_webhook"),
    BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_WEBHOOK,
  );
  assert.equal(
    resolveSnapshotOriginForSyncType("ml_sync_recent", null),
    BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_SYNC,
  );
  assert.equal(
    resolveSnapshotOriginForSyncType("reconciliation_job", null),
    BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_RECONCILIATION,
  );
  assert.equal(
    normalizeOperationalOrigin(OPERATIONAL_ORIGIN_EXTENDED.LAZY_DETAIL_ENRICHMENT),
    OPERATIONAL_ORIGIN_EXTENDED.LAZY_DETAIL_ENRICHMENT,
  );
  assert.equal(
    normalizeOperationalOrigin(OPERATIONAL_ORIGIN_EXTENDED.MANUAL_BACKFILL),
    OPERATIONAL_ORIGIN_EXTENDED.MANUAL_BACKFILL,
  );
  assert.equal(
    resolveSnapshotOriginForSyncType("ml_initial_import", null),
    BILLING_SNAPSHOT_ORIGIN.ONBOARDING_IMPORT,
  );
  const lazyMeta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.LAZY_DETAIL_ENRICHMENT,
      is_initial_canonical_persist: false,
      sale_created_at: SALE_CREATED,
    },
    null,
    NOW,
  );
  assert.equal(lazyMeta.operational_origin, OPERATIONAL_ORIGIN_EXTENDED.LAZY_DETAIL_ENRICHMENT);
});

test("legacy read — sem internal_provenance_class → LEGACY_UNVERIFIED sem write", () => {
  const legacy = {
    snapshot_quality: "historical",
    snapshot_origin: "post_suse7_sale",
    snapshot_created_at: NOW,
    immutable_since: NOW,
    internal_costs_snapshot: { internal_tax_brl: "2.21" },
  };
  assert.equal(resolveInternalProvenanceClassForRead(legacy), INTERNAL_PROVENANCE_CLASS.LEGACY_UNVERIFIED);
  assert.equal(legacy.internal_provenance_class, undefined);
});

test("RECONSTRUCTED_ESTIMATED congelado após persist — merge preserva", () => {
  const fin = {
    internal_provenance_class: INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED,
    snapshot_quality: "reconstructed",
    estimated: true,
    immutable_since: NOW,
    reconstructed_at: NOW,
    tax_snapshot: { amount_brl: "5.00" },
    internal_costs_snapshot: { internal_tax_brl: "5.00", product_cost_brl: "10.00" },
    product_cost_snapshot: { amount_brl: "10.00" },
    gross_sale_amount_brl: "100.00",
    marketplace_fee_amount_brl: "10.00",
    shipping_amount_brl: "5.00",
    net_received_amount_brl: "85.00",
    snapshot_complete: true,
  };
  assert.ok(isSellerHistoricalFinancialSnapshotFrozen(fin));
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(
    { raw_json: { id: "new-calc" }, net_amount: "99.00" },
    { raw_json: { _s7_financial: fin }, net_amount: "85.00", fee_amount: "10.00" },
    { isMarketplaceSnapshotComplete: isItemFinancialSnapshotComplete },
  );
  assert.equal(merged.raw_json._s7_financial.tax_snapshot.amount_brl, "5.00");
  assert.equal(String(merged.net_amount), "85.00");
});

test("mapping legado — CAPTURED usa historical, nunca captured", () => {
  assert.equal(LEGACY_SNAPSHOT_QUALITY_BY_INTERNAL_CLASS.CAPTURED_AT_INGESTION, "historical");
  const meta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_WEBHOOK,
      is_initial_canonical_persist: true,
      sale_created_at: SALE_CREATED,
    },
    null,
    NOW,
  );
  assert.equal(meta.snapshot_quality, "historical");
  assert.notEqual(meta.snapshot_quality, "captured");
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}

console.log(`\nAll ${8} provenance V2 legacy compat tests passed.`);
