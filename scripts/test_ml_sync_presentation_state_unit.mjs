#!/usr/bin/env node
import {
  countMlSyncStepBuckets,
  isMlHistoricalEmptySuccess,
  resolveMlSellerSyncPresentationState,
} from "../src/services/marketplace/mlSyncPresentationState.js";
import {
  doneHistoricalWindowsProveEmpty,
  historicalBackfillNeedsTerminalization,
  hotRecentProvesEmpty,
} from "../src/services/marketplace/mlHistoricalEmptyBackfillFinalize.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const checklistRunningHistory = [
  { key: "ml_connect", status: "done", label: "Conectando conta" },
  { key: "sales_recent", status: "done", label: "Vendas recentes" },
  { key: "listings", status: "done", label: "Anúncios" },
  { key: "fees", status: "done", label: "Taxas" },
  { key: "products", status: "done", label: "Produtos/SKU" },
  { key: "monitoring", status: "done", label: "Webhook/monitoramento" },
  { key: "historical_sales", status: "running", label: "Histórico de vendas" },
];

const countsRunning = countMlSyncStepBuckets(checklistRunningHistory);
assert("running history increments running count", countsRunning.running === 1);
assert("running history keeps completed at 6", countsRunning.completed === 6);

const presentationRunning = resolveMlSellerSyncPresentationState({
  overall: "done",
  historicalBackfillActive: true,
  historicalSalesAgg: { status: "running" },
  historicalUx: { processing_title: "Importando histórico disponível de vendas…" },
  completedCount: countsRunning.completed,
  pendingCount: countsRunning.pending,
  errorCount: countsRunning.error,
  runningCount: countsRunning.running,
  runningStepLabel: countsRunning.runningStepLabel,
});

assert(
  "hot done + history running => em andamento",
  presentationRunning.sync_summary_label === "Em andamento" &&
    presentationRunning.display_overall === "background_sync",
);
assert(
  "hot done + history running is not fully complete",
  presentationRunning.fully_complete === false,
);

const checklistCompleteEmpty = [
  ...checklistRunningHistory.map((row) =>
    row.key === "historical_sales" ? { ...row, status: "done" } : row,
  ),
];

const countsComplete = countMlSyncStepBuckets(checklistCompleteEmpty);
const presentationComplete = resolveMlSellerSyncPresentationState({
  overall: "done",
  historicalBackfillActive: false,
  historicalSalesAgg: { status: "done" },
  historicalUx: { empty_history: true, coverage_saved_total_hint: 0, coverage_api_total_hint: 0 },
  completedCount: countsComplete.completed,
  pendingCount: countsComplete.pending,
  errorCount: countsComplete.error,
  runningCount: countsComplete.running,
  runningStepLabel: "",
});

assert(
  "all complete empty history => concluida",
  presentationComplete.sync_summary_label === "Concluída" && presentationComplete.fully_complete === true,
);
assert(
  "empty history success flag",
  isMlHistoricalEmptySuccess(
    { empty_history: true, coverage_saved_total_hint: 0, coverage_api_total_hint: 0 },
    { status: "done" },
  ) === true,
);

const hotEmpty = {
  job_type: "ml_initial_sales_recent",
  status: "done",
  metadata: { ml_sales_import_saved: 0, ml_sales_import_api_total: 0 },
};
assert("hot empty proves empty", hotRecentProvesEmpty(hotEmpty) === true);

const hotWithSales = {
  job_type: "ml_initial_sales_recent",
  status: "done",
  metadata: { ml_sales_import_saved: 2, ml_sales_import_api_total: 2 },
};
assert("hot with sales does not prove empty", hotRecentProvesEmpty(hotWithSales) === false);

const doneWindowEmpty = [
  {
    job_type: "ml_historical_sales_backfill",
    status: "done",
    metadata: { ml_sales_import_saved: 0, ml_sales_import_api_total: 0 },
  },
];
assert("done empty windows prove empty", doneHistoricalWindowsProveEmpty(doneWindowEmpty) === true);

const stuckRows = [
  hotEmpty,
  {
    job_type: "ml_historical_sales_backfill",
    status: "running",
    metadata: {
      historical_period_start: "2025-01-01T00:00:00.000Z",
      historical_period_end: "2025-08-01T00:00:00.000Z",
    },
  },
];
assert(
  "stuck running with empty hot needs terminalization",
  historicalBackfillNeedsTerminalization(stuckRows) === true,
);

const rowsWithSalesWindow = [
  hotEmpty,
  {
    job_type: "ml_historical_sales_backfill",
    status: "done",
    metadata: { ml_sales_import_saved: 1, ml_sales_import_api_total: 1 },
  },
  { job_type: "ml_historical_sales_backfill", status: "pending", metadata: {} },
];
assert(
  "non-empty done window blocks terminalization",
  historicalBackfillNeedsTerminalization(rowsWithSalesWindow) === false,
);

if (failures.length > 0) {
  console.error("FAIL ml sync presentation state:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}

console.log(`PASS ml sync presentation state (${12 - failures.length} checks)`);
