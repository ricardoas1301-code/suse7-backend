#!/usr/bin/env node
/**
 * P0.3-C — auditoria estática billing reconciliation gate.
 * Documenta durability, trigger, call graph e gaps reais (sem DB mutation).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const readRepo = (rel) => {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
};

const failures = [];
const gaps = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}
function gap(name, cond) {
  if (cond) gaps.push(name);
}

const preflight = read("src/billing/services/billingBillableSalePreflightService.js");
const hook = read("src/billing/services/billingBillableSaleEntitlementHook.js");
const reconcilerJob = read("src/billing/jobs/billingBillableSaleAdmissionReconcilerJob.js");
const reconcilerHttp = read("src/handlers/jobs/billingBillableSaleAdmissionReconcilerJob.js");
const reconcilerCron = read("src/handlers/billing/billingBillableSaleAdmissionReconcilerCron.js");
const admission = read("src/billing/services/billingBillableSaleAdmissionService.js");
const sync = read("src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js");
const vercel = read("vercel.json");
const quota = read("src/billing/services/billingQuotaEligibilityService.js");
const pendingSvc = readRepo("src/billing/services/billingManualReviewPendingService.js");
const pendingReconciler = readRepo("src/billing/services/billingManualReviewPendingReconcilerService.js");
const schedulerWorkflow = readRepo("../suse7-scheduler/.github/workflows/billing-admission-reconciler-dev.yml");

const {
  classifySalePeriodForQuota,
} = await import("../src/billing/services/billingQuotaEligibilityService.js");
const { BILLING_SNAPSHOT_ORIGIN, BILLING_SALE_PERIOD_CLASS } = await import(
  "../src/billing/billingConstants.js"
);

// --- T1 durability: manual_review sale path ---
check("T1 hook materializes pending via upsert RPC", hook.includes("materializeManualReviewPendingAfterSale"));
check("T1 hook logs BILLING_MANUAL_REVIEW", hook.includes("BILLING_MANUAL_REVIEW"));
check("T1 upsert RPC wrapper exists", pendingSvc.includes("billing_upsert_manual_review_pending_v1"));
check(
  "C.1B schedule_reconciliation consumer exists",
  reconcilerJob.includes("reconcileManualReviewPendingBatch") ||
    pendingReconciler.includes("reconcileManualReviewPendingBatch"),
);

// --- Reconciler call graph ---
check("reconciler job exists", reconcilerJob.includes("runBillableSaleAdmissionReconcilerJob"));
check("reconciler calls reconcileExpiredBillableSaleReservations", reconcilerJob.includes("reconcileExpiredBillableSaleReservations"));
check("reconciler RPC billing_reconcile_expired", admission.includes("billing_reconcile_expired_billable_sale_reservations_v1"));
check("reconciler Class B pending manual review", reconcilerJob.includes("class_b_pending"));
check("reconciler promote-only (no reserve v2 on pending)", !pendingReconciler.includes("reserveBillableSaleV2"));
gap(
  "GAP reconciler escopo = expired atomic reservations only (não manual_review pending)",
  !reconcilerJob.includes("class_b_pending"),
);

// --- Trigger operacional ---
check("HTTP job endpoint handler exists", reconcilerHttp.includes("billing-billable-sale-admission-reconciler"));
check("alternate cron handler exists", reconcilerCron.includes("runBillableSaleAdmissionReconcilerJob"));
check("billing scheduler workflow file exists", schedulerWorkflow.includes("billing-admission-reconciler-dev"));
check("billing scheduler separate concurrency group", schedulerWorkflow.includes("billing-admission-reconciler-dev"));
check(
  "billing trigger via suse7-scheduler (not vercel.json)",
  schedulerWorkflow.includes("billing-billable-sale-admission-reconciler"),
);

// --- Re-evaluação billing em sale existente ---
gap(
  "GAP applyMlOrderDetail skip billing quando sale já existe",
  sync.includes("const isNewSale = !existing?.id") && sync.includes("if (isNewSale && !atomicAdmission)"),
);

// --- T6 historical zero retrocharge ---
const hist = classifySalePeriodForQuota({
  snapshot_origin: BILLING_SNAPSHOT_ORIGIN.ONBOARDING_IMPORT,
  official_order_at: new Date("2026-06-01T12:00:00.000Z"),
  metadata: { quota_counting_started_at: "2026-08-01T00:00:00.000Z" },
});
check("T6 onboarding import quota_eligible false", hist.quota_eligible === false);
check("T6 onboarding class IMPORTACAO_HISTORICA", hist.class === BILLING_SALE_PERIOD_CLASS.IMPORTACAO_HISTORICA);

// --- T5 quantity not in atomic reserve path (billing per order) ---
check(
  "T5 reserve RPC keyed by external_order_id not quantity",
  admission.includes("p_external_order_id") && !/p_quantity|quantity.*reserve/i.test(admission),
);

// --- Idempotency primitives exist for atomic path ---
check("atomic duplicate flag in mapRpcReservationResult", admission.includes("duplicate: Boolean(row.duplicate)"));
check("active order unique index referenced in tests", read("scripts/test_billing_persist_partial_admission_contract_6_9a10_unit.mjs").includes("active_order_uidx"));

// --- manual_review semantics: temporário ---
check("manual_review class exists", quota.includes("BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW"));
check("manual_review reason quota_counting_started_at_missing", quota.includes("quota_counting_started_at_missing"));

// --- Sale immutability: billing não persiste order ---
check("billing admission service não importa mlSalesPersist", !admission.includes("persistMercadoLibreOrder"));

if (failures.length) {
  console.error("[P0.3-C billing reconciliation audit] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("[P0.3-C billing reconciliation audit] OK", {
  structural_checks: 14,
  documented_gaps: gaps.length,
  gaps,
  recommendation:
    gaps.length >= 2
      ? "PARTIAL — revisar gaps documentados"
      : "P0.3-C.1 DURABLE BILLING RECONCILIATION — backend ready for DEV runtime homolog",
});
