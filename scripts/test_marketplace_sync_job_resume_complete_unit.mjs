#!/usr/bin/env node
/**
 * T-RESUME-COMPLETE — job já em progress_total não deve reprocessar carga.
 */
import { resolveMarketplaceSyncJobAlreadyComplete } from "../src/services/marketplace/marketplaceSyncJobHelpers.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert("complete when equal totals", resolveMarketplaceSyncJobAlreadyComplete({ progress_current: 1434, progress_total: 1434 }));
assert("complete when current exceeds total", resolveMarketplaceSyncJobAlreadyComplete({ progress_current: 1500, progress_total: 1434 }));
assert("not complete when below total", !resolveMarketplaceSyncJobAlreadyComplete({ progress_current: 950, progress_total: 1434 }));
assert("not complete when total missing", !resolveMarketplaceSyncJobAlreadyComplete({ progress_current: 100, progress_total: null }));
assert("not complete when zero total", !resolveMarketplaceSyncJobAlreadyComplete({ progress_current: 0, progress_total: 0 }));

const cursor = '{"search_offset":1400,"idx_in_page":34,"seller_id":"2350765542"}';
const job = {
  id: "8b553445-5f5c-4dd5-b2d0-a7657cb6ee05",
  status: "running",
  progress_current: 1434,
  progress_total: 1434,
  last_cursor: cursor,
};
assert("inspazzo fixture complete", resolveMarketplaceSyncJobAlreadyComplete(job));

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, tests_passed: 6, policy: "resume_complete_without_reimport" }, null, 2));
