#!/usr/bin/env node
import {
  aggregateHistoricalSalesJobs,
  isContaminatedHistoricalDoneJob,
} from "../src/services/marketplace/mlAccountSyncChecklist.js";

const failures = [];
function assert(name, cond) {
  if (!cond) failures.push(name);
}

const contaminated = {
  job_type: "ml_historical_sales_backfill",
  status: "done",
  progress_current: 1,
  progress_total: 1,
  metadata: { soft_yield_reason: "before_orders_search", window_index: 3 },
};
const realDone = {
  job_type: "ml_historical_sales_backfill",
  status: "done",
  progress_current: 10,
  progress_total: 10,
  metadata: { last_orders_search_started_at: "2026-08-21T10:00:00Z", window_index: 1 },
};

assert("contaminated_detect", isContaminatedHistoricalDoneJob(contaminated));
assert("real_not_contaminated", !isContaminatedHistoricalDoneJob(realDone));

const aggMixed = aggregateHistoricalSalesJobs([realDone, contaminated]);
assert("mixed_not_done", aggMixed?.status !== "done");
assert("contaminated_count", (aggMixed?.windows_contaminated_done ?? 0) === 1);

const aggAllReal = aggregateHistoricalSalesJobs([realDone, { ...realDone, metadata: { ...realDone.metadata, window_index: 2 } }]);
assert("all_real_done", aggAllReal?.status === "done");

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, tests: 5 }));
