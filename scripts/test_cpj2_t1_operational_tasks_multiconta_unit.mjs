#!/usr/bin/env node
/**
 * CPJ-2 T1 — payload OT com 2 contas ML independentes.
 */
import assert from "node:assert/strict";
import { buildOperationalTasksPayload } from "../src/domain/dashboard/operationalTasksPayload.js";

const dual = buildOperationalTasksPayload({
  universeStable: true,
  mlAccountSyncStates: [
    {
      marketplace_account_id: "11111111-1111-4111-8111-111111111111",
      phase: "in_progress",
      account_label: "SMR - RP",
      account_avatar_url: "https://example.com/rp.png",
      status: "active",
    },
    {
      marketplace_account_id: "22222222-2222-4222-8222-222222222222",
      phase: "awaiting_start",
      account_label: "SMR - GO",
      account_avatar_url: "https://example.com/go.png",
      status: "invalid",
    },
  ],
});

assert.equal(dual.tasks.filter((t) => String(t.type).startsWith("ml_initial_sync")).length, 2);
const rp = dual.tasks.find((t) => t.marketplace_account_id === "11111111-1111-4111-8111-111111111111");
const go = dual.tasks.find((t) => t.marketplace_account_id === "22222222-2222-4222-8222-222222222222");
assert.ok(rp);
assert.ok(go);
assert.equal(rp.action?.type, "open_ml_sync_modal");
assert.equal(go.action?.type, "open_marketplace_connect");
assert.equal(rp.account_label, "SMR - RP");
assert.equal(go.account_label, "SMR - GO");
assert.notEqual(rp.dedupe_key, go.dedupe_key);

const single = buildOperationalTasksPayload({
  universeStable: true,
  mlInitialSyncPhase: "awaiting_start",
  mlMarketplaceAccountId: "11111111-1111-4111-8111-111111111111",
});
assert.equal(single.tasks.filter((t) => t.type === "ml_initial_sync_pending").length, 1);

console.log(
  JSON.stringify({
    pass: true,
    test: "cpj2_t1_operational_tasks_multiconta_unit",
    dual_ml_tasks: 2,
    single_compat: 1,
  }),
);
