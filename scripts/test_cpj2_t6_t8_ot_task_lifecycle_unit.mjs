#!/usr/bin/env node
/**
 * CPJ2 T6–T8 — contrato Golden da Central: ocultar SKU/custos no ciclo;
 * reaparecer após terminal efetivo. Não forçar 3 tarefas durante o ciclo.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEV_GLOBAL_MAINTENANCE_REASON } from "../src/domain/dev/devGlobalMaintenanceMode.js";
import { buildOperationalTasksPayload } from "../src/domain/dashboard/operationalTasksPayload.js";
import { resolveAccountMlInitialSyncPhase } from "../src/domain/dashboard/resolveMlInitialSyncOperationalPhase.js";
import {
  shouldEnqueueHistoricalAfterHotSalesComplete,
} from "../src/services/marketplace/mlSalesHotJobPostCompletion.js";

const root = dirname(fileURLToPath(import.meta.url));
const workerSrc = readFileSync(
  join(root, "../src/services/marketplace/marketplaceAccountSyncWorker.js"),
  "utf8",
);

const ACCOUNT = "841cf991-869f-457f-96d5-27a79e0ba538";

function stubJob(jobType) {
  return {
    job_type: jobType,
    status: "done",
    metadata: { skipped: true, reason: DEV_GLOBAL_MAINTENANCE_REASON },
  };
}

function realDone(jobType) {
  return {
    job_type: jobType,
    status: "done",
    metadata: {},
  };
}

function realPending(jobType) {
  return {
    job_type: jobType,
    status: "pending",
    metadata: {},
  };
}

function taskTypes(payload) {
  return (payload.tasks || []).map((t) => String(t.type || t.id || ""));
}

// Golden: jobs ativos → in_progress (Central mostra só sync; SKU/custos omitidos).
assert.equal(
  resolveAccountMlInitialSyncPhase({
    accountStatus: "active",
    universeStable: false,
    accountJobs: [realPending("ml_initial_listings_current"), realPending("ml_initial_products")],
  }),
  "in_progress",
);

const duringActive = buildOperationalTasksPayload({
  universeStable: false,
  skuDependencyPendingCount: 99,
  missingProductCostsCount: 99,
  mlAccountSyncStates: [
    {
      marketplace_account_id: ACCOUNT,
      phase: "in_progress",
      status: "active",
      store_name: "SMR - Nova",
      store_document_cnpj: "67802633000194",
    },
  ],
});
const duringTypes = taskTypes(duringActive);
assert.ok(duringTypes.includes("ml_initial_sync_in_progress"));
assert.ok(!duringTypes.includes("sku_dependency_pending"));
assert.ok(!duringTypes.includes("missing_product_costs"));
assert.ok(
  !duringActive.tasks.some((t) => t.id === "sku_dependency_pending" || t.id === "missing_product_costs"),
);
console.log("ACTIVE_SYNC_TASK_SUPPRESSION_CONTRACT=PROVEN");

// Stubs de maintenance não são ciclo real → awaiting_start (não "Sincronizando").
assert.equal(
  resolveAccountMlInitialSyncPhase({
    accountStatus: "active",
    universeStable: false,
    accountJobs: [
      stubJob("ml_initial_listings_current"),
      stubJob("ml_initial_products"),
      stubJob("ml_initial_sales_recent"),
    ],
  }),
  "awaiting_start",
);

// Após terminal efetivo (universo estável + pendências reais) SKU/custos reaparecem.
const afterTerminal = buildOperationalTasksPayload({
  universeStable: true,
  skuDependencyPendingCount: 12,
  missingProductCostsCount: 7,
  profilePhotoUrl: "https://example.com/a.png",
  companyLogoUrl: "https://example.com/a.png",
  primaryCompany: {
    cep: "01310100",
    address_street: "Av. Paulista",
    address_number: "1000",
    address_city: "São Paulo",
    address_state: "SP",
  },
  mlAccountSyncStates: [
    {
      marketplace_account_id: ACCOUNT,
      phase: "none",
      status: "active",
      store_name: "SMR - Nova",
      store_document_cnpj: "67802633000194",
    },
  ],
});
assert.ok(afterTerminal.tasks.some((t) => t.type === "sku_dependency_pending"));
assert.ok(afterTerminal.tasks.some((t) => t.type === "missing_product_costs"));
assert.ok(!afterTerminal.tasks.some((t) => String(t.type).includes("ml_initial_sync")));
console.log("SKU_TASK_REAPPEARS_AFTER_TERMINAL=PASS");
console.log("COST_TASK_REAPPEARS_AFTER_TERMINAL=PASS");

assert.equal(
  resolveAccountMlInitialSyncPhase({
    accountStatus: "active",
    universeStable: true,
    accountJobs: [realDone("ml_initial_listings_current"), realDone("ml_initial_products")],
  }),
  "none",
);
console.log("OPERATIONAL_TASK_LIFECYCLE=PASS");

assert.equal(shouldEnqueueHistoricalAfterHotSalesComplete("ml_initial_sales_recent", {}), true);
assert.equal(
  shouldEnqueueHistoricalAfterHotSalesComplete("ml_initial_sales_recent", {
    skipped: true,
    reason: DEV_GLOBAL_MAINTENANCE_REASON,
  }),
  true,
  "enqueue helper still keys off job_type; worker must not call it on stub path",
);
assert.ok(workerSrc.includes("defer_leave_pending"));
assert.ok(workerSrc.includes("complete_as_stub: false"));
assert.ok(!workerSrc.includes("sync_job_skipped_maintenance"));
assert.ok(workerSrc.includes("sync_job_deferred_maintenance"));
console.log("MAINTENANCE_SKIP_LEAVES_PENDING=PASS");
console.log("STUB_DONE_DOES_NOT_ENQUEUE_HISTORICAL=PASS");
