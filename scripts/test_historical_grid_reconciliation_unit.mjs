#!/usr/bin/env node
/**
 * GRID-01..10 — reconciliação da grade histórica ML (expected vs existing).
 */
import {
  ML_SALES_HISTORY_FIXED_TEST_CUTOVER,
  buildHistoricalSalesBackfillWindows,
} from "../src/services/marketplace/mlSalesHistoryWindow.js";
import {
  buildHistoricalSalesWindowIdentity,
  historicalSalesWindowIdentityKey,
  findMissingHistoricalSalesBackfillWindows,
  resolveHistoricalBackfillPack,
  reconcileHistoricalSalesBackfillJobs,
  buildHistoricalSalesBackfillJobRows,
} from "../src/services/marketplace/createMlInitialSyncJobs.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const CUTOVER = ML_SALES_HISTORY_FIXED_TEST_CUTOVER;
const pack = buildHistoricalSalesBackfillWindows(CUTOVER);
const EXPECTED = pack.windows.length;

function metaForWindow(w, status = "pending") {
  return {
    id: `job-${w.window_index}`,
    marketplace_account_id: "acc-grid",
    job_type: "ml_historical_sales_backfill",
    status,
    metadata: {
      window_index: w.window_index,
      date_from: w.date_from,
      date_to: w.date_to,
      target_history_end_iso: pack.target_history_end_iso,
      hot_end_iso: pack.hot_end_iso,
    },
  };
}

function existingFromIndices(indices, statusByIndex = {}) {
  return indices.map((i) => metaForWindow(pack.windows[i], statusByIndex[i] ?? "pending"));
}

/**
 * Mock transacional com proteção de identidade (simula unique constraint futura).
 * @param {Record<string, unknown>[]} seed
 */
function createReconcileMock(seed = []) {
  /** @type {Record<string, unknown>[]} */
  const store = seed.map((r) => ({ ...r, metadata: { ...(r.metadata || {}) } }));
  const accId = "acc-grid";

  function identityKeyFromRow(row) {
    const m = row.metadata || {};
    return historicalSalesWindowIdentityKey(
      buildHistoricalSalesWindowIdentity({
        window_index: m.window_index,
        date_from: m.date_from,
        date_to: m.date_to,
      })
    );
  }

  return {
    store,
    sb: {
      from(table) {
        if (table !== "marketplace_account_sync_jobs") throw new Error("unexpected table");
        return {
          select() {
            return {
              eq(_c1, v1) {
                return {
                  eq(_c2, v2) {
                    return Promise.resolve({
                      data: store.filter(
                        (r) =>
                          String(r.marketplace_account_id || accId) === String(v1) &&
                          String(r.job_type) === String(v2)
                      ),
                      error: null,
                    });
                  },
                };
              },
            };
          },
          insert(rows) {
            const keys = new Set(store.map(identityKeyFromRow));
            for (const row of rows) {
              const k = identityKeyFromRow(row);
              if (keys.has(k)) {
                return Promise.resolve({ error: { message: "duplicate_window_identity", code: "23505" } });
              }
              keys.add(k);
              store.push({ ...row, id: row.id || `ins-${store.length}`, marketplace_account_id: accId, job_type: "ml_historical_sales_backfill" });
            }
            return Promise.resolve({ error: null });
          },
        };
      },
    },
    ctx: {
      userId: "user-grid",
      marketplaceAccountId: accId,
      sellerCompanyId: "sc-grid",
      cutoverIso: CUTOVER,
    },
  };
}

// GRID-10 — identidades distintas
{
  const a = pack.windows[1];
  const b = pack.windows[2];
  const ka = historicalSalesWindowIdentityKey(buildHistoricalSalesWindowIdentity(a));
  const kb = historicalSalesWindowIdentityKey(buildHistoricalSalesWindowIdentity(b));
  assert("GRID-10 distinct keys", ka !== kb);
}

// GRID-01 — grade vazia
{
  const { sb, ctx, store } = createReconcileMock([]);
  const out = await reconcileHistoricalSalesBackfillJobs(sb, ctx);
  assert("GRID-01 created all", out.created === EXPECTED);
  assert("GRID-01 final count", store.length === EXPECTED);
}

// GRID-02 — grade completa
{
  const { sb, ctx, store } = createReconcileMock(existingFromIndices([...Array(EXPECTED).keys()]));
  const before = store.length;
  const out = await reconcileHistoricalSalesBackfillJobs(sb, ctx);
  assert("GRID-02 created zero", out.created === 0 && out.skipped === true);
  assert("GRID-02 count stable", store.length === before);
}

// GRID-03 — grade parcial 0,1,2
{
  const { sb, ctx, store } = createReconcileMock(existingFromIndices([0, 1, 2]));
  const out = await reconcileHistoricalSalesBackfillJobs(sb, ctx);
  assert("GRID-03 created missing", out.created === EXPECTED - 3);
  assert("GRID-03 converged", store.length === EXPECTED);
}

// GRID-04 — buraco no meio (falta idx 2)
{
  const indices = [...Array(EXPECTED).keys()].filter((i) => i !== 2);
  const { sb, ctx, store } = createReconcileMock(existingFromIndices(indices));
  const out = await reconcileHistoricalSalesBackfillJobs(sb, ctx);
  assert("GRID-04 created one", out.created === 1);
  assert("GRID-04 converged", store.length === EXPECTED);
  const has2 = store.some((r) => r.metadata?.window_index === 2);
  assert("GRID-04 window 2 present", has2);
}

// GRID-05 — buraco múltiplo
{
  const { sb, ctx, store } = createReconcileMock(existingFromIndices([0, 2, 5, 9]));
  const out = await reconcileHistoricalSalesBackfillJobs(sb, ctx);
  assert("GRID-05 created missing count", out.created === EXPECTED - 4);
  assert("GRID-05 converged", store.length === EXPECTED);
}

// GRID-06 — concorrência (race real paralela + constraint simulada)
{
  const { sb, ctx, store } = createReconcileMock([]);
  const [a, b] = await Promise.all([
    reconcileHistoricalSalesBackfillJobs(sb, ctx),
    reconcileHistoricalSalesBackfillJobs(sb, ctx),
  ]);
  const totalCreated = (a.created ?? 0) + (b.created ?? 0);
  assert("GRID-06 final ten", store.length === EXPECTED);
  assert("GRID-06 no duplicate identities", new Set(store.map((r) => r.metadata?.window_index)).size === EXPECTED);
  assert("GRID-06 created sum bounded", totalCreated >= EXPECTED && totalCreated <= EXPECTED * 2);
}

// GRID-07 — crash após insert parcial simulado (seed 0,1,2) → reconcilia resto
{
  const { sb, ctx, store } = createReconcileMock(existingFromIndices([0, 1, 2]));
  const out = await reconcileHistoricalSalesBackfillJobs(sb, ctx);
  assert("GRID-07 fills remainder", out.created === EXPECTED - 3);
  assert("GRID-07 converged", store.length === EXPECTED);
}

// GRID-08 — done + pending existentes, só faltantes criadas
{
  const doneIdx = [0, 1];
  const pendingIdx = [2, 3];
  const allPresent = [...doneIdx, ...pendingIdx];
  const statusMap = Object.fromEntries([
    ...doneIdx.map((i) => [i, "done"]),
    ...pendingIdx.map((i) => [i, "pending"]),
  ]);
  const { sb, ctx, store } = createReconcileMock(existingFromIndices(allPresent, statusMap));
  const out = await reconcileHistoricalSalesBackfillJobs(sb, ctx);
  assert("GRID-08 only missing created", out.created === EXPECTED - allPresent.length);
  assert("GRID-08 done preserved", store.filter((r) => r.status === "done").length === doneIdx.length);
}

// GRID-09 — running não duplicado
{
  const { sb, ctx, store } = createReconcileMock(existingFromIndices([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], { 4: "running" }));
  const out = await reconcileHistoricalSalesBackfillJobs(sb, ctx);
  assert("GRID-09 no recreate running", out.created === 0);
  const running = store.filter((r) => r.metadata?.window_index === 4 && r.status === "running");
  assert("GRID-09 single running idx4", running.length === 1);
}

// findMissing pure — identidade temporal estável com cutover ancorado
{
  const anchored = resolveHistoricalBackfillPack(existingFromIndices([0]), CUTOVER);
  const missing = findMissingHistoricalSalesBackfillWindows(anchored, existingFromIndices([0]));
  assert("GRID anchor missing count", missing.length === EXPECTED - 1);
  const rows = buildHistoricalSalesBackfillJobRows(anchored, missing.slice(0, 1), {
    userId: "u",
    marketplaceAccountId: "a",
  });
  assert("GRID anchor row window_index", rows[0]?.metadata?.window_index === 1);
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      tests_passed: 11,
      expected_windows: EXPECTED,
      policy: "historical_grid_reconcile",
    },
    null,
    2
  )
);
