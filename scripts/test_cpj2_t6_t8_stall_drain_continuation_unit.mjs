#!/usr/bin/env node
/**
 * CPJ2 T6–T8 — drain não aborta após soft-yield; Local tem wake; start sem limit=1.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countMlSyncStepBuckets, isMlSyncStepIncompletePersistedProgress } from "../src/services/marketplace/mlSyncPresentationState.js";

const root = dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(join(root, "../src/services/marketplace/marketplaceAccountSyncWorker.js"), "utf8");
const startSync = readFileSync(join(root, "../src/handlers/marketplace/accountStartInitialSync.js"), "utf8");
const devServer = readFileSync(join(root, "../src/dev-server.js"), "utf8");
const syncStatus = readFileSync(join(root, "../src/handlers/marketplace/accountSyncStatus.js"), "utf8");

assert.ok(!worker.includes("if (waveHungry) break"), "drain must not abort on waveHungry");
assert.ok(worker.includes("jobsDispatchedTotal = Math.max(0, jobsDispatchedTotal - 1)"), "soft-yield refunds drain slot");
assert.ok(worker.includes("continuation_released"), "continuation release preserved");
console.log("DRAIN_CONTINUES_AFTER_SOFT_YIELD=PASS");

assert.ok(!startSync.includes("marketplace-account-sync?limit=1"), "start nudge must not pin limit=1");
assert.ok(startSync.includes("/api/jobs/marketplace-account-sync"), "start still nudges worker");
console.log("START_NUDGE_FULL_DRAIN=PASS");

assert.ok(devServer.includes("startDevLocalMarketplaceSyncWake"), "local wake function present");
assert.ok(devServer.includes("/api/jobs/marketplace-account-sync"), "local wake drains existing jobs");
assert.ok(!devServer.includes("/start-initial-sync"), "local wake does not start a new cycle");
const listingsSync = readFileSync(join(root, "../src/handlers/ml/_helpers/mlInitialOnboardingListingsSync.js"), "utf8");
assert.ok(listingsSync.includes("enqueueListingsMetricsRebuild"), "listings metrics rebuild does not block drain");
assert.ok(!listingsSync.includes("await rebuildListingSalesMetricsForUser"), "metrics rebuild is fire-and-forget");
console.log("LOCAL_WAKE_PRESENT=PASS");

assert.ok(!syncStatus.includes("Importação em fila no servidor"), "helper text removed from sync-status");
assert.equal(
  isMlSyncStepIncompletePersistedProgress({
    status: "pending",
    progress_current: 20,
    progress_total: 27,
  }),
  true,
);
assert.equal(
  isMlSyncStepIncompletePersistedProgress({
    status: "pending",
    progress_current: 1,
    progress_total: 1,
    metadata: { skipped: true, reason: "DEV_GLOBAL_MAINTENANCE" },
  }),
  false,
);
const counts = countMlSyncStepBuckets([
  { key: "listings", label: "Anúncios", status: "pending", progress_current: 20, progress_total: 27 },
  { key: "products", label: "Produtos", status: "pending" },
]);
assert.equal(counts.running, 1);
assert.equal(counts.pending, 1);
assert.equal(counts.runningStepLabel, "Anúncios");
console.log("INCOMPLETE_PROGRESS_COUNTS_AS_RUNNING=PASS");
console.log("CPJ2_T6_T8_STALL_DRAIN_CONTINUATION=PASS");
