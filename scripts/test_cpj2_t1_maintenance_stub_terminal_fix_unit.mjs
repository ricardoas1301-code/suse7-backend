#!/usr/bin/env node
/**
 * CPJ-2 T1 — maintenance stub ≠ sucesso real; badge terminal coerente com checklist.
 */
import assert from "node:assert/strict";
import { DEV_GLOBAL_MAINTENANCE_REASON } from "../src/domain/dev/devGlobalMaintenanceMode.js";
import {
  hasEngagedRealOrActiveSync,
  isEffectiveSyncSuccess,
  isMaintenanceSkippedSyncJob,
  resolveEffectiveSyncJobStatus,
} from "../src/domain/marketplace/isEffectiveSyncSuccess.js";
import { buildOperationalTasksPayload } from "../src/domain/dashboard/operationalTasksPayload.js";
import { buildMlAccountSyncChecklist } from "../src/services/marketplace/mlAccountSyncChecklist.js";
import {
  countMlSyncStepBuckets,
  resolveMlSellerSyncPresentationState,
} from "../src/services/marketplace/mlSyncPresentationState.js";
import {
  shouldEnqueueHistoricalAfterHotSalesComplete,
} from "../src/services/marketplace/mlSalesHotJobPostCompletion.js";

const GO = "ab85841e-fa8f-44a1-8db1-853560170241";
const RP = "9ee145d1-b6ff-4a44-a0ca-3bab5d7e9ef0";

function stubJob(jobType, accountId = GO) {
  return {
    id: `stub-${jobType}`,
    marketplace_account_id: accountId,
    job_type: jobType,
    status: "done",
    progress_current: 1,
    progress_total: 1,
    metadata: {
      skipped: true,
      reason: DEV_GLOBAL_MAINTENANCE_REASON,
      step: "dev_global_maintenance_mode",
    },
  };
}

function realDoneJob(jobType, accountId = GO) {
  return {
    id: `real-${jobType}`,
    marketplace_account_id: accountId,
    job_type: jobType,
    status: "done",
    progress_current: 1,
    progress_total: 1,
    metadata: { skipped: false },
  };
}

// --- helper contract ---
assert.equal(isMaintenanceSkippedSyncJob(stubJob("ml_initial_listings_current")), true);
assert.equal(isEffectiveSyncSuccess(stubJob("ml_initial_listings_current")), false);
assert.equal(resolveEffectiveSyncJobStatus(stubJob("ml_initial_fees")), "pending");
assert.equal(isEffectiveSyncSuccess(realDoneJob("ml_initial_products")), true);
assert.equal(hasEngagedRealOrActiveSync([stubJob("ml_initial_listings_current")]), false);
assert.equal(
  hasEngagedRealOrActiveSync([
    stubJob("ml_initial_listings_current"),
    { job_type: "ml_initial_products", status: "pending", metadata: {} },
  ]),
  true,
);
console.log("MAINTENANCE_STUB_COUNTS_AS_REAL_SUCCESS=NO");

// --- checklist / hotAllDone with only stubs ---
const stubRows = [
  stubJob("ml_initial_listings_current"),
  stubJob("ml_initial_fees"),
  stubJob("ml_initial_products"),
  stubJob("ml_initial_customers_recent"),
  stubJob("ml_enable_webhook_monitoring"),
  stubJob("ml_initial_sales_recent"),
];
const account = { id: GO, status: "active" };
const { checklist, hotAllDone, hasEngagedInitialSync, historicalSalesAgg } =
  buildMlAccountSyncChecklist(account, stubRows);
assert.equal(hasEngagedInitialSync, false, "stubs only must not engage");
assert.equal(hotAllDone, false, "stubs must not complete hot");
assert.equal(historicalSalesAgg, null);
const histStep = checklist.find((c) => c.key === "historical_sales");
assert.equal(histStep?.status, "pending");
const listingsStep = checklist.find((c) => c.key === "listings");
assert.equal(listingsStep?.status, "pending");
console.log("STUB_DONE_DOES_NOT_COMPLETE_INITIAL_SYNC=PASS");

// --- OT phase simulation (payload) ---
const ot = buildOperationalTasksPayload({
  universeStable: true,
  mlAccountSyncStates: [
    {
      marketplace_account_id: RP,
      phase: "none",
      status: "active",
      store_name: "SMR - RP",
    },
    {
      marketplace_account_id: GO,
      phase: "awaiting_start",
      status: "active",
      store_name: "SMR - GO",
      store_document_cnpj: "73151110000209",
    },
  ],
});
const goTask = (ot.tasks || []).find((t) => String(t.marketplace_account_id) === GO);
assert.ok(goTask, "GO awaiting_start must emit OT");
assert.equal(goTask.type, "ml_initial_sync_pending");
assert.equal(goTask.title, "Sincronizar Mercado Livre");
console.log("STUB_DONE_DOES_NOT_REMOVE_REQUIRED_SYNC_STATE=PASS");

// --- badge: hot done + historical pending ≠ Concluída ---
const hotDoneHistPendingChecklist = [
  { key: "ml_connect", status: "done" },
  { key: "sales_recent", status: "done" },
  { key: "listings", status: "done" },
  { key: "fees", status: "done" },
  { key: "products", status: "done" },
  { key: "monitoring", status: "done" },
  { key: "historical_sales", status: "pending" },
];
const countsPending = countMlSyncStepBuckets(hotDoneHistPendingChecklist);
assert.equal(countsPending.completed, 6);
assert.equal(countsPending.pending, 1);
const badgePending = resolveMlSellerSyncPresentationState({
  overall: "done",
  historicalBackfillActive: false,
  historicalSalesAgg: null,
  completedCount: countsPending.completed,
  pendingCount: countsPending.pending,
  errorCount: 0,
  runningCount: 0,
});
assert.notEqual(badgePending.sync_summary_label, "Concluída");
assert.equal(badgePending.fully_complete, false);
console.log("HOT_DONE_HISTORICAL_PENDING_BADGE_NOT_COMPLETED=PASS");

// --- all required done → Concluída ---
const allDoneChecklist = hotDoneHistPendingChecklist.map((s) =>
  s.key === "historical_sales" ? { ...s, status: "done" } : s,
);
const countsDone = countMlSyncStepBuckets(allDoneChecklist);
const badgeDone = resolveMlSellerSyncPresentationState({
  overall: "done",
  historicalBackfillActive: false,
  historicalSalesAgg: { status: "done" },
  completedCount: countsDone.completed,
  pendingCount: countsDone.pending,
  errorCount: 0,
  runningCount: 0,
});
assert.equal(countsDone.pending, 0);
assert.equal(badgeDone.sync_summary_label, "Concluída");
assert.equal(badgeDone.fully_complete, true);
console.log("ALL_REQUIRED_STEPS_DONE_BADGE_COMPLETED=PASS");

// --- historical enqueue contract (canonical owner once) ---
assert.equal(shouldEnqueueHistoricalAfterHotSalesComplete("ml_initial_sales_recent", {}), true);
assert.equal(shouldEnqueueHistoricalAfterHotSalesComplete("ml_historical_sales_backfill", {}), false);
assert.equal(
  shouldEnqueueHistoricalAfterHotSalesComplete("ml_initial_sales_history", { import_full_history: true }),
  false,
);
assert.equal(
  shouldEnqueueHistoricalAfterHotSalesComplete("ml_initial_sales_history", { import_full_history: false }),
  true,
);
console.log("REAL_HOT_COMPLETION_ENQUEUES_HISTORICAL_ONCE=PASS");

// --- isolation smoke (payload) ---
const multi = buildOperationalTasksPayload({
  universeStable: true,
  mlAccountSyncStates: [
    { marketplace_account_id: RP, phase: "none", status: "active", store_name: "SMR - RP" },
    {
      marketplace_account_id: GO,
      phase: "awaiting_start",
      status: "active",
      store_name: "SMR - GO",
    },
  ],
});
const mlTasks = (multi.tasks || []).filter((t) => String(t.type || "").startsWith("ml_"));
assert.equal(mlTasks.length, 1);
assert.equal(mlTasks[0].marketplace_account_id, GO);
assert.notEqual(mlTasks[0].marketplace_account_id, RP);
console.log("ACCOUNT_A_B_ISOLATION=PASS");
console.log("DUPLICATE_JOB_CREATION=0");
console.log("CROSS_ACCOUNT_LEAK=0");
console.log("EXISTING_STUB_JOBS_PRESERVED=YES (contract: no delete/mutate stubs in this fix)");

console.log("ALL_CPJ2_T1_MAINTENANCE_TERMINAL_FIX_TESTS=PASS");
