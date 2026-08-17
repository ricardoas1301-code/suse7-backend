// ======================================================================
// Testes unitários — status de anúncio ML (falso INATIVO por 404 + catálogo)
// ======================================================================

import assert from "node:assert/strict";
import {
  annotateCompetitorListingStatus,
  hasEnrichLiveSignals,
  resolveCompetitorListingStatusFromEnrich,
  resolveListingStatusPersistUpdate,
} from "../src/domain/competition/competitionListingStatus.js";

function testCatalogEnrichWith404DoesNotInferNotFound() {
  const enrichedRaw = {
    competitor_price: "149.90",
    competitor_title: "Produto concorrente",
    competitor_thumbnail: "https://http2.mlstatic.com/img.jpg",
  };
  const enrichDebug = {
    attempts: [{ endpoint: "/items/MLB123", status: 404 }],
  };

  assert.equal(resolveCompetitorListingStatusFromEnrich(enrichedRaw, enrichDebug), null);
  assert.deepEqual(resolveListingStatusPersistUpdate(enrichedRaw, enrichDebug), { mode: "clear" });
  assert.equal(hasEnrichLiveSignals(enrichedRaw), true);
}

function test404WithoutLiveSignalsStillNotFound() {
  const enrichDebug = {
    attempts: [{ endpoint: "/items/MLB123", status: 404 }],
  };
  assert.equal(resolveCompetitorListingStatusFromEnrich(null, enrichDebug), "not_found");
}

function testBodyStatusPausedStillInactive() {
  const enrichedRaw = { status: "paused", competitor_price: "10.00" };
  assert.equal(resolveCompetitorListingStatusFromEnrich(enrichedRaw, null), "paused");
}

function testGetSanitizesStaleNotFoundWithCommercialData() {
  const fields = annotateCompetitorListingStatus({
    rowStatus: "not_found",
    last_seen_price: "99.90",
    competitor_thumbnail: "https://img.jpg",
  });
  assert.equal(fields.competitor_listing_status, null);
  assert.equal(fields.is_competitor_listing_active, true);
}

function testGetKeepsRealPausedStatus() {
  const fields = annotateCompetitorListingStatus({
    rowStatus: "paused",
    last_seen_price: "99.90",
  });
  assert.equal(fields.competitor_listing_status, "paused");
  assert.equal(fields.is_competitor_listing_active, false);
}

const tests = [
  testCatalogEnrichWith404DoesNotInferNotFound,
  test404WithoutLiveSignalsStillNotFound,
  testBodyStatusPausedStillInactive,
  testGetSanitizesStaleNotFoundWithCommercialData,
  testGetKeepsRealPausedStatus,
];

for (const fn of tests) {
  fn();
  console.log(`ok — ${fn.name}`);
}

console.log(`\n${tests.length} testes passaram.`);
