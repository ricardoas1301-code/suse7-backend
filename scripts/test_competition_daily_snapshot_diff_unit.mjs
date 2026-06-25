// ======================================================================
// Testes unitários — diff de snapshot da rotina diária de concorrência
// ======================================================================

import assert from "node:assert/strict";
import {
  buildSnapshotComparableBaseline,
  buildSnapshotComparableCandidate,
  detectRelevantSnapshotChanges,
  extractListingStatus,
} from "../src/domain/competition/competitionSnapshotDiff.js";

function testUnchangedWhenSameData() {
  const before = buildSnapshotComparableBaseline({
    competitor: {
      last_seen_price: "99.90",
      competitor_thumbnail: "https://a/img.jpg",
      competitor_permalink: "https://ml.com/a",
    },
    latestSnapshot: {
      competitor_price: "99.90",
      shipping: { free_shipping: true, mode: "me2", logistic_type: "drop_off" },
      listing_type: "gold_pro",
      reputation: { level_id: "5_green", power_seller_status: "gold" },
      sales_hint: 120,
      competitor_thumbnail: "https://a/img.jpg",
      competitor_permalink: "https://ml.com/a",
      raw_snapshot: { category_id: "MLB123", listing_status: "active" },
    },
  });

  const after = buildSnapshotComparableCandidate({
    normalized: { last_seen_price: "99.90", competitor_thumbnail: "https://a/img.jpg", competitor_permalink: "https://ml.com/a" },
    enrichExtras: {
      shipping: { free_shipping: true, mode: "me2", logistic_type: "drop_off" },
      listing_type: "gold_pro",
      reputation: { level_id: "5_green", power_seller_status: "gold" },
      sales_hint: 120,
    },
    enrichedRaw: { category_id: "MLB123", status: "active" },
  });

  const diff = detectRelevantSnapshotChanges(before, after);
  assert.equal(diff.changed, false);
  assert.deepEqual(diff.changed_fields, []);
}

function testDetectPriceChange() {
  const before = buildSnapshotComparableBaseline({
    competitor: { last_seen_price: "99.90" },
    latestSnapshot: { competitor_price: "99.90" },
  });
  const after = buildSnapshotComparableCandidate({
    normalized: { last_seen_price: "89.90" },
    enrichExtras: {},
    enrichedRaw: {},
  });
  const diff = detectRelevantSnapshotChanges(before, after);
  assert.equal(diff.changed, true);
  assert.ok(diff.changed_fields.includes("price"));
}

function testInitialBaselineAlwaysChanges() {
  const after = buildSnapshotComparableCandidate({
    normalized: { last_seen_price: "10.00" },
    enrichExtras: {},
    enrichedRaw: {},
  });
  const diff = detectRelevantSnapshotChanges(null, after);
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.changed_fields, ["initial_baseline"]);
}

function testListingStatusExtraction() {
  assert.equal(extractListingStatus({ status: "paused" }), "paused");
  assert.equal(extractListingStatus({ listing_status: "closed" }), "closed");
  assert.equal(extractListingStatus(null), null);
}

function testDetectListingStatusChange() {
  const before = buildSnapshotComparableBaseline({
    competitor: { competitor_listing_status: "active" },
    latestSnapshot: { raw_snapshot: { listing_status: "active" } },
  });
  const after = buildSnapshotComparableCandidate({
    normalized: { competitor_listing_status: "paused" },
    enrichExtras: {},
    enrichedRaw: { status: "paused" },
  });
  const diff = detectRelevantSnapshotChanges(before, after);
  assert.equal(diff.changed, true);
  assert.ok(diff.changed_fields.includes("listing_status"));
}

function testBaselineUsesRowListingStatus() {
  const before = buildSnapshotComparableBaseline({
    competitor: { competitor_listing_status: "paused" },
    latestSnapshot: null,
  });
  assert.equal(before.listing_status, "paused");
}

testUnchangedWhenSameData();
testDetectPriceChange();
testInitialBaselineAlwaysChanges();
testListingStatusExtraction();
testDetectListingStatusChange();
testBaselineUsesRowListingStatus();

console.log("[test_competition_daily_snapshot_diff_unit] ok");
