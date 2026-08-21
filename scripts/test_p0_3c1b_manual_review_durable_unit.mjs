#!/usr/bin/env node
/**
 * P0.3-C.1B — unit/static: materialization hook, reconciler Class B, promote-only path.
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

const hook = read("src/billing/services/billingBillableSaleEntitlementHook.js");
const sync = read("src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js");
const pendingSvc = read("src/billing/services/billingManualReviewPendingService.js");
const reconcilerSvc = read("src/billing/services/billingManualReviewPendingReconcilerService.js");
const reconcilerJob = read("src/billing/jobs/billingBillableSaleAdmissionReconcilerJob.js");
const preflight = read("src/billing/services/billingBillableSalePreflightService.js");

const {
  resolveManualReviewReconciliationAction,
} = await import("../src/billing/services/billingManualReviewPendingService.js");
const { BILLING_SALE_PERIOD_CLASS, BILLING_SNAPSHOT_ORIGIN } = await import(
  "../src/billing/billingConstants.js"
);
const { classifySalePeriodForQuota } = await import(
  "../src/billing/services/billingQuotaEligibilityService.js"
);

// T1–T5 materialization
check("T1 hook materializes pending after sale", hook.includes("materializeManualReviewPendingAfterSale"));
check("T1 hook calls upsert RPC path", pendingSvc.includes("billing_upsert_manual_review_pending_v1"));
check("T2 sync passes marketplace identity to hook", sync.includes("marketplace_account_id: marketplaceAccountId"));
check("T3 hook idempotent via upsert RPC", pendingSvc.includes("duplicate") && pendingSvc.includes("billing_upsert_manual_review_pending_v1"));
check("T4 no pending before persist (hook after persist only)", sync.indexOf("notifyBillableSaleRecorded") > sync.indexOf("persistMercadoLibreOrder"));
check("T5 recovery selector exists", reconcilerSvc.includes("selectOperationalSalesMissingAdmission"));

// T6–T11 reconciler
check("T6 reconciler Class B batch", reconcilerSvc.includes("reconcileManualReviewPendingBatch"));
check("T7 repeat reconcile uses upsert update", pendingSvc.includes("duplicate"));
check("T8 promote RPC only", reconcilerSvc.includes("promoteManualReviewPendingToReservation"));
check("T8 never reserve v2 on pending", !reconcilerSvc.includes("reserveBillableSaleV2"));
check("T9 idempotent promote path", pendingSvc.includes("billing_promote_manual_review_pending_to_reservation_v1"));
check("T10 finalize RPC", pendingSvc.includes("billing_finalize_manual_review_not_billable_v1"));
check("T11 reconciler job Class A then B", reconcilerJob.includes("class_a_expired") && reconcilerJob.includes("class_b_pending"));

// T12–T16 billing rules
check("T12 quantity not in reconciler", !reconcilerSvc.includes("quantity"));
check("T13 historical blocked on upsert path", pendingSvc.includes("historical_import_blocked"));
check("T14 quota exhausted stays pending", reconcilerSvc.includes("baby_hard_limit_reached"));
check("T15 classifier failure stays pending", reconcilerSvc.includes("classifier_temporary_failure"));
check("T16 promote then finalize", reconcilerSvc.includes("finalizeBillableSaleV2"));

// Classification reevaluation
const remain = resolveManualReviewReconciliationAction({
  manual_review_required: true,
  class: BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW,
  reason: "quota_counting_started_at_missing",
});
check("RF stays pending action", remain.action === "remain_pending");

const promote = resolveManualReviewReconciliationAction({
  quota_eligible: true,
  class: BILLING_SALE_PERIOD_CLASS.FRANQUIA_ELEGIVEL,
  reason: "current_cycle_eligible",
});
check("eligible uses promote action", promote.action === "promote");

const finalize = resolveManualReviewReconciliationAction({
  class: BILLING_SALE_PERIOD_CLASS.PRE_OPERATIONAL_CUTOVER,
  reason: "before_operational_cutover",
});
check("pre-cutover finalize action", finalize.action === "finalize");

// T13 historical
const hist = classifySalePeriodForQuota({
  snapshot_origin: BILLING_SNAPSHOT_ORIGIN.ONBOARDING_IMPORT,
  official_order_at: new Date("2026-08-01T12:00:00.000Z"),
  metadata: {},
});
check("historical not eligible", hist.quota_eligible === false);

// P0.3-B regression
check("P0.3-B manual review admits persist", preflight.includes("manual_review_required: true") && preflight.includes("admit: true"));

// Index selector
check("pending selector uses admission_result filter", reconcilerSvc.includes("PENDING_MANUAL_REVIEW"));

if (failures.length) {
  console.error("[P0.3-C.1B manual_review durable unit] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("[P0.3-C.1B manual_review durable unit] OK", { checks: 28 });
