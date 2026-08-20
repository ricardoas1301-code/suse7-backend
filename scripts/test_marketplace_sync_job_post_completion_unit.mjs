#!/usr/bin/env node
/**
 * Regression guards — post-completion hot sales (T-POST-01..06).
 */
import {
  shouldEnqueueHistoricalAfterHotSalesComplete,
  shouldTryEmptyHistoricalFinalizeAfterHot,
  runMlSalesHotJobPostCompletion,
} from "../src/services/marketplace/mlSalesHotJobPostCompletion.js";
import {
  buildHistoricalSalesBackfillWindows,
  ML_SALES_HISTORY_FIXED_TEST_CUTOVER,
} from "../src/services/marketplace/mlSalesHistoryWindow.js";
import { historicalSalesWindowIdentityKey, buildHistoricalSalesWindowIdentity } from "../src/services/marketplace/createMlInitialSyncJobs.js";

const pack = buildHistoricalSalesBackfillWindows(ML_SALES_HISTORY_FIXED_TEST_CUTOVER);
const EXPECTED_WINDOW_COUNT = pack.windows.length;

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

// T-POST-01 / T-POST-02 gate
assert("recent triggers enqueue", shouldEnqueueHistoricalAfterHotSalesComplete("ml_initial_sales_recent", {}));
assert("history partial triggers", shouldEnqueueHistoricalAfterHotSalesComplete("ml_initial_sales_history", {}));
assert("history full skip", !shouldEnqueueHistoricalAfterHotSalesComplete("ml_initial_sales_history", { import_full_history: true }));
assert("backfill skip", !shouldEnqueueHistoricalAfterHotSalesComplete("ml_historical_sales_backfill", {}));

// empty finalize gate
assert("progress>0 skip empty finalize", !shouldTryEmptyHistoricalFinalizeAfterHot({ metadata: {}, progressCurrent: 1434 }));
assert("zero saved triggers empty finalize", shouldTryEmptyHistoricalFinalizeAfterHot({ metadata: { ml_sales_import_saved: 0 }, progressCurrent: 0 }));

/** @type {Record<string, unknown>[]} */
const store = [];

function mockSupabase(existingComplete = false) {
  store.length = 0;
  if (existingComplete) {
    for (const w of pack.windows) {
      store.push({
        id: `existing-${w.window_index}`,
        marketplace_account_id: "acc-1",
        job_type: "ml_historical_sales_backfill",
        metadata: {
          window_index: w.window_index,
          date_from: w.date_from,
          date_to: w.date_to,
          target_history_end_iso: pack.target_history_end_iso,
        },
      });
    }
  }
  return {
    from(table) {
      if (table !== "marketplace_account_sync_jobs") throw new Error("unexpected table");
      return {
        select() {
          return {
            eq(_col, val) {
              return {
                eq(_col2, val2) {
                  return Promise.resolve({
                    data: store.filter(
                      (r) => String(r.marketplace_account_id) === String(val) && String(r.job_type) === String(val2)
                    ),
                    error: null,
                  });
                },
              };
            },
          };
        },
        insert(rows) {
          const keys = new Set(
            store.map((r) => {
              const m = r.metadata || {};
              return historicalSalesWindowIdentityKey(
                buildHistoricalSalesWindowIdentity({
                  window_index: m.window_index,
                  date_from: m.date_from,
                  date_to: m.date_to,
                })
              );
            })
          );
          for (const row of rows) {
            const m = row.metadata || {};
            const k = historicalSalesWindowIdentityKey(
              buildHistoricalSalesWindowIdentity({
                window_index: m.window_index,
                date_from: m.date_from,
                date_to: m.date_to,
              })
            );
            if (keys.has(k)) return Promise.resolve({ error: { message: "duplicate" } });
            keys.add(k);
            store.push(row);
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

async function runPostCompletion(path, existingComplete = false) {
  const sb = mockSupabase(existingComplete);
  return runMlSalesHotJobPostCompletion(sb, {
    jobId: "hot-1",
    jobType: "ml_initial_sales_recent",
    userId: "user-1",
    marketplaceAccountId: "acc-1",
    sellerCompanyId: "sc-1",
    metadata: { ml_sales_import_saved: 100, ml_sales_import_api_total: 100 },
    progressCurrent: 100,
    completionPath: path,
  });
}

// T-POST-01 normal path equivalent
{
  const out = await runPostCompletion("normal_batch");
  assert("T-POST-01 ran", out.ran === true);
  assert("T-POST-01 created windows", out.enqueue?.created === EXPECTED_WINDOW_COUNT && store.length === EXPECTED_WINDOW_COUNT);
}

// T-POST-02 resume path equivalent
{
  const out = await runPostCompletion("resume_complete");
  assert("T-POST-02 ran", out.ran === true);
  assert("T-POST-02 created windows", out.enqueue?.created === EXPECTED_WINDOW_COUNT);
}

// T-POST-03 equivalent outcomes
{
  const normal = await runPostCompletion("normal_batch");
  const resume = await runPostCompletion("resume_complete");
  assert("T-POST-03 same created count", normal.enqueue?.created === resume.enqueue?.created);
  assert("T-POST-03 both skipped false on first", normal.enqueue?.skipped === false && resume.enqueue?.skipped === false);
}

// T-POST-04 double post-completion — second call skipped (idempotent)
{
  const first = await runPostCompletion("normal_batch", false);
  const second = await runPostCompletion("resume_complete", true);
  assert("T-POST-04 first creates", first.enqueue?.created === EXPECTED_WINDOW_COUNT);
  assert("T-POST-04 second skipped", second.enqueue?.skipped === true && second.enqueue?.created === 0);
}

// T-POST-05 historical already exists
{
  const out = await runPostCompletion("done_job_replay", true);
  assert("T-POST-05 skipped existing", out.enqueue?.skipped === true && out.enqueue?.created === 0);
}

// T-POST-06 concurrency simulation — parallel reconcile
{
  const sb = mockSupabase(false);
  const ctx = {
    jobId: "h1",
    jobType: "ml_initial_sales_recent",
    userId: "u",
    marketplaceAccountId: "acc-c",
    metadata: {},
    progressCurrent: 10,
  };
  const [a, b] = await Promise.all([
    runMlSalesHotJobPostCompletion(sb, { ...ctx, completionPath: "normal_batch" }),
    runMlSalesHotJobPostCompletion(sb, { ...ctx, completionPath: "resume_complete" }),
  ]);
  assert("T-POST-06 final bounded", store.length <= EXPECTED_WINDOW_COUNT);
  assert("T-POST-06 at least one batch", (a.enqueue?.created ?? 0) + (b.enqueue?.created ?? 0) >= EXPECTED_WINDOW_COUNT);
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, tests_passed: 16, policy: "ml_sales_hot_post_completion" }, null, 2));
