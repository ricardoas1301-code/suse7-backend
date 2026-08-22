#!/usr/bin/env node
import {
  resolveSellerFacingSaleNumberFromOrder,
  resolveTechnicalOrderId,
} from "../src/domain/sales/resolveSellerFacingSaleNumber.js";
import { resolveSnapshotOriginForSyncType } from "../src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js";
import { BILLING_SNAPSHOT_ORIGIN } from "../src/billing/billingConstants.js";

const failures = [];
function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert(
  "I1_pack_preferred",
  resolveSellerFacingSaleNumberFromOrder({
    external_pack_id: "2000014643438253",
    external_order_id: "2000018050953590",
  }) === "2000014643438253",
);
assert(
  "I1_technical_order",
  resolveTechnicalOrderId({ external_order_id: "2000018050953590" }) === "2000018050953590",
);
assert(
  "I10_fallback_order",
  resolveSellerFacingSaleNumberFromOrder({ external_order_id: "2000018050953590" }) === "2000018050953590",
);
assert(
  "I8_historical_origin",
  resolveSnapshotOriginForSyncType("ml_historical_sales_backfill") === BILLING_SNAPSHOT_ORIGIN.ONBOARDING_IMPORT,
);
assert(
  "I5_scanner_origin",
  resolveSnapshotOriginForSyncType("ml_incremental_sales_poll") === BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_SYNC,
);

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, tests: 5 }));
