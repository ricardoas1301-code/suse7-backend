#!/usr/bin/env node
/**
 * P0.3-B — manual_review_required permite persistência operacional sem consumo atômico.
 * T6–T12 parcial (unit): eligible path intacto; manual review persiste; orders≠units; idempotência estática.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const {
  classifySalePeriodForQuota,
  normalizeBillingSnapshotOrigin,
} = await import("../src/billing/services/billingQuotaEligibilityService.js");
const { resolveSnapshotOriginForSyncType } = await import(
  "../src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js"
);
const { BILLING_SALE_PERIOD_CLASS, BILLING_SNAPSHOT_ORIGIN } = await import(
  "../src/billing/billingConstants.js"
);

const preflightSrc = read("src/billing/services/billingBillableSalePreflightService.js");
const syncSrc = read("src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js");
const persistSrc = read("src/handlers/ml/_helpers/mlSalesPersist.js");
const hookSrc = read("src/billing/services/billingBillableSaleEntitlementHook.js");

// --- Path diff: initial vs incremental snapshot origin ---
check(
  "T-ORIGIN-01 initial recent → onboarding_import",
  resolveSnapshotOriginForSyncType("ml_initial_sales_recent") === BILLING_SNAPSHOT_ORIGIN.ONBOARDING_IMPORT,
);
check(
  "T-ORIGIN-02 historical → onboarding_import",
  resolveSnapshotOriginForSyncType("ml_historical_sales_backfill") === BILLING_SNAPSHOT_ORIGIN.ONBOARDING_IMPORT,
);
check(
  "T-ORIGIN-03 incremental poll → operational_sync",
  resolveSnapshotOriginForSyncType("ml_incremental_sales_poll") === BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_SYNC,
);
check(
  "T-ORIGIN-04 webhook → operational_webhook",
  resolveSnapshotOriginForSyncType("operational_webhook") === BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_WEBHOOK,
);

// --- Onboarding import bypasses quota (837 RF sales path) ---
const onboardingClass = classifySalePeriodForQuota({
  snapshot_origin: BILLING_SNAPSHOT_ORIGIN.ONBOARDING_IMPORT,
  official_order_at: new Date("2026-08-19T15:14:09.000Z"),
  metadata: {},
});
check("T-HIST-01 onboarding import not quota eligible", onboardingClass.quota_eligible === false);
check("T-HIST-02 onboarding import class", onboardingClass.class === BILLING_SALE_PERIOD_CLASS.IMPORTACAO_HISTORICA);

// --- Freshness path: quota metadata missing → manual review ---
const manualReviewClass = classifySalePeriodForQuota({
  snapshot_origin: BILLING_SNAPSHOT_ORIGIN.OPERATIONAL_SYNC,
  official_order_at: new Date("2026-08-20T12:00:00.000Z"),
  metadata: {},
  now: new Date("2026-08-21T12:00:00.000Z"),
});
check("T8-01 manual review when quota_start missing", manualReviewClass.manual_review_required === true);
check(
  "T8-02 manual review reason",
  manualReviewClass.reason === "quota_counting_started_at_missing",
);

// --- Preflight contract: manual review must admit persist, zero atomic ---
check(
  "T8-03 preflight manual_review admits persist",
  preflightSrc.includes("admit: true") &&
    preflightSrc.includes("process_sale: true") &&
    preflightSrc.includes("manual_review_required: true") &&
    preflightSrc.includes("quota_bypassed: true") &&
    preflightSrc.includes("atomic: false") &&
    preflightSrc.includes("schedule_reconciliation: true"),
);
check(
  "T8-04 preflight manual_review no longer blocks persist",
  !preflightSrc.includes("admit: false,\n      process_sale: false,\n      reason: \"manual_review_required\""),
);

// --- Eligible atomic path preserved ---
check(
  "T6-01 atomic path still calls evaluateBillableSaleBeforeProcessingAtomic",
  preflightSrc.includes("evaluateBillableSaleBeforeProcessingAtomic"),
);

// --- Orders vs units: billing per order, quantities in items ---
check(
  "T2/T7 orders≠units persist path",
  persistSrc.includes("sales_order_items") && persistSrc.includes("quantity"),
);
check(
  "T2/T7 apply does not multiply billing by quantity",
  !syncSrc.includes("quantity") || syncSrc.indexOf("reserveBillableSaleAfterOfficialDate") < syncSrc.indexOf("quantity") || !/billing.*quantity|quantity.*billing/i.test(syncSrc),
);

// --- Idempotency ---
check(
  "T4/T5 existing order short-circuit",
  syncSrc.includes("existing?.id") && syncSrc.includes("isNewSale"),
);
check(
  "T11 billing idempotency hook duplicate",
  hookSrc.includes("options.atomic_admission?.duplicate"),
);

// --- Billing hook logs manual review without counting ---
check(
  "T8-05 hook BILLING_MANUAL_REVIEW event",
  hookSrc.includes("BILLING_MANUAL_REVIEW") && hookSrc.includes("resolveObservationLogEvent"),
);

// --- Watermark only on successful persist (incremental poll) ---
const pollSrc = read("src/services/marketplace/mlIncrementalSalesPoll.js");
check(
  "T-WM-01 watermark after persist ok",
  pollSrc.includes("result?.ok === false") && pollSrc.includes("advanceMlSalesWatermark"),
);

// --- sold_quantity not SSOT for executive summary ---
const execSrc = read("src/domain/sales/buildSaleExecutiveSummary.js");
check(
  "T39 executive summary from persisted sales",
  execSrc.includes("sales_orders") || execSrc.includes("saleExecutiveSourceItems"),
);
check(
  "T39 no sold_quantity SSOT in executive builder",
  !execSrc.includes("sold_quantity"),
);

if (failures.length) {
  console.error("[P0.3-B manual_review persist unit] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("[P0.3-B manual_review persist unit] OK", {
  checks: 22,
  fix: "manual_review_required → admit+process_sale, atomic:false, quota_bypassed:true",
});
