#!/usr/bin/env node
/**
 * FIN.SSOT.PROVENANCE-V2.DEV.02 — testes unitários de proveniência financeira V2.
 */

import assert from "node:assert/strict";
import {
  INTERNAL_PROVENANCE_CLASS,
  MARKETPLACE_PROVENANCE_CLASS,
  OPERATIONAL_ORIGIN_EXTENDED,
  computeCaptureLagSeconds,
  hasEstablishedInternalProvenance,
  resolveFinancialSnapshotProvenanceV2,
  resolveInternalProvenanceClassForRead,
  resolveMarketplaceProvenanceClass,
} from "../src/domain/sales/financialSnapshotProvenanceV2.js";
import { resolveFinancialSnapshotMetadata } from "../src/services/marketplace/mercadoLivreSaleFinancialEnrichment.js";
import {
  mergeIncomingSalesOrderItemWithExistingSnapshot,
  isSellerHistoricalFinancialSnapshotFrozen,
} from "../src/domain/sales/salesOrderItemSnapshotPreservation.js";
import { isItemFinancialSnapshotComplete } from "../src/services/marketplace/mercadoLivreSaleFinancialEnrichment.js";

const NOW = "2026-08-12T19:21:11.743Z";
const SALE_CREATED = "2026-08-12T19:19:32.000Z";

function buildCapturedFinancial(overrides = {}) {
  return {
    snapshot_version: "ml_financial_v2",
    snapshot_complete: true,
    snapshot_origin: "post_suse7_sale",
    operational_origin: "operational_webhook",
    internal_provenance_class: INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION,
    marketplace_provenance_class: MARKETPLACE_PROVENANCE_CLASS.MARKETPLACE_EXACT,
    snapshot_quality: "historical",
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
    internal_costs_snapshot: { product_cost_brl: "32.00", internal_tax_brl: "2.21" },
    ...overrides,
  };
}

function testFirstCanonicalPersistCapturedAtIngestion() {
  const meta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_WEBHOOK,
      is_initial_canonical_persist: true,
      sale_created_at: SALE_CREATED,
      marketplace_snapshot_complete: true,
    },
    null,
    NOW,
  );
  assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION);
  assert.equal(meta.snapshot_quality, "historical");
  assert.equal(meta.estimated, false);
  assert.equal(meta.reconstructed_at, null);
  assert.equal(meta.snapshot_created_at, NOW);
  assert.equal(meta.sale_created_at, SALE_CREATED);
  assert.equal(meta.captured_at, NOW);
  assert.equal(meta.capture_lag_seconds, 100);
  assert.equal(meta.marketplace_provenance_class, MARKETPLACE_PROVENANCE_CLASS.MARKETPLACE_EXACT);
}

function testRetryPreservesProvenance() {
  const existing = buildCapturedFinancial();
  const meta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_WEBHOOK,
      is_initial_canonical_persist: false,
      sale_created_at: SALE_CREATED,
    },
    existing,
    "2026-08-12T20:00:00.000Z",
  );
  assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION);
  assert.equal(meta.snapshot_created_at, NOW);
  assert.equal(meta.immutable_since, NOW);
  assert.equal(meta.captured_at, NOW);
  assert.equal(meta.capture_lag_seconds, 100);
}

function testDuplicateWebhookPreservesProvenance() {
  const existing = buildCapturedFinancial({ operational_origin: "operational_webhook" });
  const meta = resolveFinancialSnapshotMetadata(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_WEBHOOK,
      is_initial_canonical_persist: true,
      sale_created_at: SALE_CREATED,
    },
    existing,
    "2026-08-12T20:05:00.000Z",
  );
  assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION);
  assert.equal(meta.snapshot_created_at, NOW);
}

function testReconciliationExistingSnapshotPreservesProvenance() {
  const existing = buildCapturedFinancial({
    operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_RECONCILIATION,
    snapshot_origin: "operational_reconciliation",
  });
  const meta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_RECONCILIATION,
      is_initial_canonical_persist: false,
      sale_created_at: SALE_CREATED,
    },
    existing,
    "2026-08-12T21:00:00.000Z",
  );
  assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION);
  assert.equal(meta.operational_origin, OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_RECONCILIATION);
}

function testDelayedBackfillReconstructedEstimated() {
  const meta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.MANUAL_BACKFILL,
      is_initial_canonical_persist: false,
      sale_created_at: "2026-08-01T10:00:00.000Z",
    },
    null,
    NOW,
  );
  assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED);
  assert.equal(meta.snapshot_quality, "reconstructed");
  assert.equal(meta.estimated, true);
  assert.equal(meta.reconstructed_at, NOW);
  assert.equal(meta.snapshot_created_at, null);
  assert.deepEqual(meta.provenance_sources, ["manual_backfill_current_config"]);
}

function testLazyDetailOldSaleReconstructedEstimated() {
  const meta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.LAZY_DETAIL_ENRICHMENT,
      is_initial_canonical_persist: false,
      sale_created_at: "2026-07-01T08:00:00.000Z",
    },
    null,
    NOW,
  );
  assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED);
  assert.equal(meta.operational_origin, OPERATIONAL_ORIGIN_EXTENDED.LAZY_DETAIL_ENRICHMENT);
}

function testOnboardingImportReconstructedEstimated() {
  const meta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.ONBOARDING_IMPORT,
      is_initial_canonical_persist: false,
      sale_created_at: "2026-06-01T12:00:00.000Z",
    },
    null,
    NOW,
  );
  assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED);
  assert.equal(meta.snapshot_origin, "onboarding_import");
  assert.equal(meta.snapshot_quality, "reconstructed");
  assert.equal(meta.estimated, true);
}

function testReconstructedExactWithHistoricalSources() {
  const meta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_SYNC,
      is_initial_canonical_persist: false,
      sale_created_at: SALE_CREATED,
      reconstruction_exact: true,
      provenance_sources: ["seller_tax_history_as_of_sale", "product_cost_history_as_of_sale"],
    },
    null,
    NOW,
  );
  assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_EXACT);
  assert.equal(meta.snapshot_quality, "historical");
  assert.equal(meta.estimated, false);
  assert.equal(meta.reconstructed_at, NOW);
  assert.equal(meta.snapshot_created_at, null);
}

function testLegacyRowReadAsLegacyUnverified() {
  const legacy = {
    snapshot_quality: "historical",
    snapshot_origin: "post_suse7_sale",
    snapshot_created_at: "2026-08-07T12:00:00.000Z",
    immutable_since: "2026-08-07T12:00:00.000Z",
    tax_snapshot: { amount_brl: "1.37" },
  };
  assert.equal(resolveInternalProvenanceClassForRead(legacy), INTERNAL_PROVENANCE_CLASS.LEGACY_UNVERIFIED);
  assert.equal(hasEstablishedInternalProvenance(legacy), true);
}

function testSnapshotPreservation01() {
  const existingFin = buildCapturedFinancial();
  const existing = {
    external_order_item_id: "MLI1",
    fee_amount: "12.92",
    shipping_share_amount: "28.90",
    net_amount: "31.98",
    raw_json: { id: "MLI1", _s7_financial: existingFin },
  };
  const incoming = {
    external_order_item_id: "MLI1",
    fee_amount: "15.00",
    shipping_share_amount: null,
    net_amount: "40.00",
    raw_json: { id: "MLI1", unit_price: 73.8 },
  };
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(incoming, existing, {
    isMarketplaceSnapshotComplete: isItemFinancialSnapshotComplete,
  });
  assert.equal(merged.raw_json._s7_financial.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION);
  assert.equal(merged.raw_json._s7_financial.snapshot_created_at, NOW);
  assert.equal(String(merged.net_amount), "31.98");
  assert.ok(isSellerHistoricalFinancialSnapshotFrozen(existingFin));
}

function testNReprocessingsInvariant() {
  let existing = buildCapturedFinancial();
  for (let i = 0; i < 5; i += 1) {
    const meta = resolveFinancialSnapshotProvenanceV2(
      {
        operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_WEBHOOK,
        is_initial_canonical_persist: i === 0,
        sale_created_at: SALE_CREATED,
      },
      existing,
      `2026-08-12T2${i}:00:00.000Z`,
    );
    assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION);
    assert.equal(meta.snapshot_created_at, NOW);
    assert.equal(meta.captured_at, NOW);
    existing = { ...existing, ...meta };
  }
}

function testMarketplaceSettlementRefreshInternalProvenanceUntouched() {
  const existingFin = buildCapturedFinancial();
  const existing = {
    raw_json: { _s7_financial: existingFin },
    fee_amount: "12.92",
    shipping_share_amount: "28.90",
    net_amount: "31.98",
  };
  const incoming = {
    raw_json: { id: "MLI1" },
    fee_amount: "13.50",
    shipping_share_amount: "29.00",
    net_amount: "32.50",
  };
  const merged = mergeIncomingSalesOrderItemWithExistingSnapshot(incoming, existing, {
    isMarketplaceSnapshotComplete: isItemFinancialSnapshotComplete,
  });
  assert.equal(merged.raw_json._s7_financial.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.CAPTURED_AT_INGESTION);
  assert.equal(merged.raw_json._s7_financial.captured_at, NOW);
  assert.equal(String(merged.fee_amount), "12.92");
}

function testCaptureLagComputation() {
  assert.equal(computeCaptureLagSeconds(SALE_CREATED, NOW), 100);
  assert.equal(computeCaptureLagSeconds(null, NOW), null);
  assert.equal(computeCaptureLagSeconds(SALE_CREATED, null), null);
}

function testNoHistoricalWithoutInitialPersistFlag() {
  const meta = resolveFinancialSnapshotProvenanceV2(
    {
      operational_origin: OPERATIONAL_ORIGIN_EXTENDED.OPERATIONAL_WEBHOOK,
      is_initial_canonical_persist: false,
      sale_created_at: SALE_CREATED,
      marketplace_snapshot_complete: true,
    },
    null,
    NOW,
  );
  assert.notEqual(meta.snapshot_quality, "historical");
  assert.equal(meta.internal_provenance_class, INTERNAL_PROVENANCE_CLASS.RECONSTRUCTED_ESTIMATED);
}

function testMarketplaceProvenanceClass() {
  assert.equal(
    resolveMarketplaceProvenanceClass({ snapshot_complete: true }),
    MARKETPLACE_PROVENANCE_CLASS.MARKETPLACE_EXACT,
  );
  assert.equal(
    resolveMarketplaceProvenanceClass({ gross_sale_amount_brl: "10.00" }),
    MARKETPLACE_PROVENANCE_CLASS.MARKETPLACE_PARTIAL,
  );
}

const tests = [
  ["1 first canonical persist → CAPTURED_AT_INGESTION", testFirstCanonicalPersistCapturedAtIngestion],
  ["2 retry → provenance preserved", testRetryPreservesProvenance],
  ["3 duplicate webhook → provenance preserved", testDuplicateWebhookPreservesProvenance],
  ["4 reconciliation existing snapshot → preserved", testReconciliationExistingSnapshotPreservesProvenance],
  ["5 delayed backfill → RECONSTRUCTED_ESTIMATED", testDelayedBackfillReconstructedEstimated],
  ["6 lazy detail old sale → RECONSTRUCTED_ESTIMATED", testLazyDetailOldSaleReconstructedEstimated],
  ["7 onboarding import → RECONSTRUCTED_ESTIMATED", testOnboardingImportReconstructedEstimated],
  ["8 reconstructed exact with historical sources", testReconstructedExactWithHistoricalSources],
  ["9 legacy row read → LEGACY_UNVERIFIED", testLegacyRowReadAsLegacyUnverified],
  ["10 snapshot preservation .01", testSnapshotPreservation01],
  ["11 N reprocessings invariant", testNReprocessingsInvariant],
  ["12 marketplace settlement refresh internal untouched", testMarketplaceSettlementRefreshInternalProvenanceUntouched],
  ["capture lag computation", testCaptureLagComputation],
  ["no historical without initial persist flag", testNoHistoricalWithoutInitialPersistFlag],
  ["marketplace provenance class", testMarketplaceProvenanceClass],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`, err instanceof Error ? err.message : err);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${tests.length} test(s) failed`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} provenance V2 unit tests passed.`);
