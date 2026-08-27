#!/usr/bin/env node
/**
 * CPJ2 T16 — unit tests for Vercel wake policy (anti-dual / owner único).
 */
import assert from "node:assert/strict";
import {
  evaluateMarketplaceSyncWakeExecution,
  isMarketplaceSyncVercelWakeEnabled,
  resolveMarketplaceSyncWakeDefaultLimit,
  resolveMarketplaceSyncWakeSource,
} from "../src/domain/marketplace/marketplaceSyncWakePolicy.js";

assert.equal(isMarketplaceSyncVercelWakeEnabled({}), false);
assert.equal(isMarketplaceSyncVercelWakeEnabled({ MARKETPLACE_SYNC_VERCEL_WAKE_ENABLED: "1" }), true);
assert.equal(isMarketplaceSyncVercelWakeEnabled({ MARKETPLACE_SYNC_VERCEL_WAKE_ENABLED: "true" }), true);

assert.equal(
  resolveMarketplaceSyncWakeSource({ headers: { "x-vercel-cron": "1" } }, { authMode: "cron-secret" }),
  "vercel_cron"
);
assert.equal(
  resolveMarketplaceSyncWakeSource({ headers: {} }, { authMode: "x-job-secret" }),
  "job_secret"
);
assert.equal(
  resolveMarketplaceSyncWakeSource({ headers: {} }, { authMode: "cron-secret" }),
  "cron_secret"
);

{
  const off = evaluateMarketplaceSyncWakeExecution({
    wakeSource: "vercel_cron",
    env: { MARKETPLACE_SYNC_VERCEL_WAKE_ENABLED: "0" },
  });
  assert.equal(off.execute, false);
  assert.equal(off.skip_reason, "vercel_wake_disabled");
}

{
  const on = evaluateMarketplaceSyncWakeExecution({
    wakeSource: "vercel_cron",
    env: { MARKETPLACE_SYNC_VERCEL_WAKE_ENABLED: "1" },
  });
  assert.equal(on.execute, true);
  assert.equal(on.skip_reason, null);
}

{
  const nudge = evaluateMarketplaceSyncWakeExecution({
    wakeSource: "job_secret",
    env: {},
  });
  assert.equal(nudge.execute, true);
}

assert.equal(
  resolveMarketplaceSyncWakeDefaultLimit({ wakeSource: "vercel_cron", requestedLimit: null }),
  1
);
assert.equal(
  resolveMarketplaceSyncWakeDefaultLimit({ wakeSource: "job_secret", requestedLimit: null }),
  null
);
assert.equal(
  resolveMarketplaceSyncWakeDefaultLimit({ wakeSource: "vercel_cron", requestedLimit: 5 }),
  5
);

// Architectural: policy has no marketplace=ML hardcode
const src = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../src/domain/marketplace/marketplaceSyncWakePolicy.js", import.meta.url), "utf8")
);
assert.equal(/mercado.?livre|mercadolivre|mlb/i.test(src), false);

console.log(
  JSON.stringify({
    ok: true,
    test: "marketplace_sync_vercel_wake_unit",
    cases: ["flag", "source", "anti_dual_skip", "nudge_allows", "default_limit", "no_ml_hardcode"],
  })
);
