#!/usr/bin/env node
/**
 * Regression guards — GET sync-status read-only (T-NUDGE-01..05).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeSyncStatusOperationalSignals,
  resolveSyncStatusOverall,
} from "../src/handlers/marketplace/accountSyncStatusSignals.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const handlerPath = path.join(root, "../src/handlers/marketplace/accountSyncStatus.js");
const handlerSource = fs.readFileSync(handlerPath, "utf8");

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const FORBIDDEN_PATTERNS = [
  /shouldNudgeDrain/,
  /drain-nudge/,
  /drainNudgeLastPostAtMs/,
  /marketplace-account-sync\?limit/,
  /fetch\s*\(\s*dispatchUrl/,
];

for (const re of FORBIDDEN_PATTERNS) {
  assert(`handler must not contain ${re}`, !re.test(handlerSource));
}

const nowMs = Date.parse("2026-08-20T20:00:00.000Z");
const staleMs = 90_000;
const pendingMs = 120_000;

const runningRow = {
  status: "running",
  updated_at: new Date(nowMs - staleMs - 5000).toISOString(),
};
const pendingRow = {
  status: "pending",
  updated_at: new Date(nowMs - pendingMs - 5000).toISOString(),
};

// T-NUDGE-01 — sinais corretos com running + pending + stale + queuedTooLong
{
  const signals = computeSyncStatusOperationalSignals({
    runningRows: [runningRow],
    pendingRows: [pendingRow],
    nowMs,
    staleProgressMs: staleMs,
    pendingQueueWarningMs: pendingMs,
  });
  assert("T-NUDGE-01 staleRunning", signals.staleRunning === true);
  assert("T-NUDGE-01 queuedTooLong", signals.queuedTooLong === true);
  const overall = resolveSyncStatusOverall({
    hasEngagedInitialSync: true,
    typedStatuses: ["running", "pending"],
    hasPartialWarnings: false,
  });
  assert("T-NUDGE-01 overall running", overall === "running");
}

// T-NUDGE-02 — 100 chamadas consecutivas aos sinais (proxy do GET) sem side effect
{
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return /** @type {Response} */ ({ status: 200 });
  };
  try {
    for (let i = 0; i < 100; i += 1) {
      computeSyncStatusOperationalSignals({
        runningRows: [runningRow],
        pendingRows: [pendingRow],
        nowMs: nowMs + i,
        staleProgressMs: staleMs,
        pendingQueueWarningMs: pendingMs,
      });
      resolveSyncStatusOverall({
        hasEngagedInitialSync: true,
        typedStatuses: ["running", "pending"],
        hasPartialWarnings: false,
      });
    }
    assert("T-NUDGE-02 zero fetch in 100 signal passes", fetchCalls === 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// T-NUDGE-03 — dez contas observadas (somente leitura por conta)
{
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return /** @type {Response} */ ({ status: 200 });
  };
  try {
    for (let i = 0; i < 10; i += 1) {
      computeSyncStatusOperationalSignals({
        runningRows: [{ status: "running", updated_at: new Date(nowMs - 30_000).toISOString() }],
        pendingRows: [{ status: "pending", updated_at: new Date(nowMs - 30_000).toISOString() }],
        nowMs,
        staleProgressMs: staleMs,
        pendingQueueWarningMs: pendingMs,
      });
    }
    assert("T-NUDGE-03 ten observers no fetch", fetchCalls === 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// T-NUDGE-04 — conta A observada não implica processamento cross-account (handler filtra por accountId)
{
  assert(
    "T-NUDGE-04 handler scopes jobs by marketplace_account_id",
    /\.eq\("marketplace_account_id", accountId\)/.test(handlerSource)
  );
  assert(
    "T-NUDGE-04 handler has no global pool fetch in sync-status",
    !/fetchJobsPool|runMarketplaceAccountSyncWorker/.test(handlerSource)
  );
}

// T-NUDGE-05 — documentação: única mutação conhecida restante é reconcile histórico vazio (opt-in por prova)
{
  assert(
    "T-NUDGE-05 historical reconcile is explicit block",
    /tryFinalizeEmptyHistoricalBackfillIfProven/.test(handlerSource)
  );
  assert("T-NUDGE-05 no drain side effect remains", !/shouldNudgeDrain/.test(handlerSource));
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      tests_passed: 12,
      policy: "sync_status_read_only_no_drain_nudge",
    },
    null,
    2
  )
);
