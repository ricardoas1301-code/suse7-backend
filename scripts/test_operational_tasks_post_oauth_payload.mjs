#!/usr/bin/env node
import { buildOperationalTasksPayload } from "../src/domain/dashboard/operationalTasksPayload.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const awaiting = buildOperationalTasksPayload({
  mlInitialSyncPhase: "awaiting_start",
  mlMarketplaceAccountId: "9ee145d1-0000-4000-8000-000000000001",
  universeStable: true,
  profilePhotoUrl: null,
  companyLogoUrl: null,
  primaryCompany: null,
});
assert("sync pending visible", awaiting.tasks.some((t) => t.id === "ml_initial_sync_pending"));
assert(
  "sync pending opens modal not direct sync",
  awaiting.tasks.find((t) => t.id === "ml_initial_sync_pending")?.action?.type === "open_ml_initial_sync_modal",
);

const inProgress = buildOperationalTasksPayload({
  mlInitialSyncPhase: "in_progress",
  mlMarketplaceAccountId: "9ee145d1-0000-4000-8000-000000000001",
  universeStable: false,
});
assert("sync in progress visible", inProgress.tasks.some((t) => t.id === "ml_initial_sync_in_progress"));

const noSkuBeforeStable = buildOperationalTasksPayload({
  universeStable: false,
  skuDependencyPendingCount: 99,
  missingProductCostsCount: 99,
});
assert(
  "sku hidden before stable universe",
  !noSkuBeforeStable.tasks.some((t) => t.id === "sku_dependency_pending"),
);
assert(
  "costs hidden before stable universe",
  !noSkuBeforeStable.tasks.some((t) => t.id === "missing_product_costs"),
);

const withCounts = buildOperationalTasksPayload({
  universeStable: true,
  skuDependencyPendingCount: 3,
  missingProductCostsCount: 2,
  profilePhotoUrl: "https://example.com/a.png",
  companyLogoUrl: "https://example.com/a.png",
  primaryCompany: {
    cep: "01310100",
    address_street: "Av. Paulista",
    address_number: "1000",
    address_city: "São Paulo",
    address_state: "SP",
  },
});
assert("sku when count > 0", withCounts.tasks.some((t) => t.id === "sku_dependency_pending"));
assert("costs when count > 0", withCounts.tasks.some((t) => t.id === "missing_product_costs"));
assert("avatar hidden when present", !withCounts.tasks.some((t) => t.id === "store_avatar_pending"));
assert("address hidden when complete", !withCounts.tasks.some((t) => t.id === "store_address_pending"));
assert("phone task removed", !withCounts.tasks.some((t) => t.id === "phone_whatsapp_pending"));

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ pass: true, test: "operational_tasks_post_oauth_payload", cases: 8 }, null, 2));
