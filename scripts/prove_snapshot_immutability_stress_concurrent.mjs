#!/usr/bin/env node
/**
 * FIN.SSOT.SNAPSHOT-IMMUTABILITY.02 — stress concorrente + polling PostgreSQL.
 * Read-only validation + reprocess controlado (sem mass drain).
 */

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
  diffImmutableSnapshotComponents,
  extractImmutableSnapshotComponents,
  fingerprintImmutableSnapshotComponents,
  isSnapshotRegressionReading,
} from "./lib/salesOrderItemSnapshotFingerprint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local") });
dotenv.config({ path: path.join(root, ".env.vercel") });

const STRESS_ORDER = process.env.S7_STRESS_ORDER_ID || "2000017855918634";
const REPROCESS_COUNT = Number(process.env.S7_STRESS_REPROCESS_COUNT || "20");
const POLL_MS = Number(process.env.S7_STRESS_POLL_MS || "40");
const OUT_PATH =
  process.env.S7_STRESS_OUTPUT ||
  path.join(root, "scripts", "output", "PROVE_SNAPSHOT_IMMUTABILITY_STRESS_02.json");

const REGRESSION_BASELINES = {
  "2000017855918634": {
    snapshot_created_at: "2026-08-10T22:15:37.391Z",
    immutable_since: "2026-08-10T22:15:37.391Z",
    internal_tax_brl: "1.37",
    tax_percent_applied: "3.0000",
    product_cost_brl: "29.90",
    shipping_share_amount: "6.85",
    net_amount: "31.23",
  },
  "2000017855961990": {
    snapshot_created_at: "2026-08-10T22:06:53.708Z",
    immutable_since: "2026-08-10T22:06:53.708Z",
    internal_tax_brl: "3.39",
    tax_percent_applied: "3.0000",
    product_cost_brl: "59.00",
    shipping_share_amount: "29.78",
    net_amount: "69.07",
  },
  "2000017856064294": {
    snapshot_created_at: "2026-08-10T22:06:23.399Z",
    immutable_since: "2026-08-10T22:06:23.399Z",
    internal_tax_brl: "21.38",
    tax_percent_applied: "16.0000",
    product_cost_brl: null,
    shipping_share_amount: "57.68",
    net_amount: "53.89",
  },
};

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * @param {string} externalOrderId
 */
async function readOrderItems(externalOrderId) {
  const { data: so } = await sb
    .from("sales_orders")
    .select("id")
    .eq("external_order_id", externalOrderId)
    .maybeSingle();
  if (!so?.id) return [];
  const { data: items } = await sb
    .from("sales_order_items")
    .select("id,fee_amount,shipping_share_amount,net_amount,raw_json,updated_at")
    .eq("sales_order_id", so.id);
  return items ?? [];
}

/**
 * @param {string} externalOrderId
 */
async function readOrderFingerprint(externalOrderId) {
  const items = await readOrderItems(externalOrderId);
  const primary = items[0] ?? {};
  const components = extractImmutableSnapshotComponents(primary);
  return {
    external_order_id: externalOrderId,
    items_count: items.length,
    ...fingerprintImmutableSnapshotComponents(components),
    components,
  };
}

function spawnSync(orderId) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["scripts/sync_ml_orders_by_id.mjs", orderId], {
      cwd: root,
      stdio: "pipe",
      env: process.env,
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`sync ${orderId} exit ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const startedAt = new Date().toISOString();
  const beforeStress = await readOrderFingerprint(STRESS_ORDER);
  const baselineComponents = beforeStress.components;

  /** @type {Record<string, unknown>[]} */
  const pollLog = [];
  /** @type {Record<string, unknown>[]} */
  const regressions = [];
  let pollCount = 0;
  let polling = true;

  const pollLoop = (async () => {
    while (polling) {
      pollCount += 1;
      const items = await readOrderItems(STRESS_ORDER);
      for (const item of items) {
        const components = extractImmutableSnapshotComponents(item);
        const entry = {
          poll: pollCount,
          at: new Date().toISOString(),
          item_id: item.id,
          has_s7_financial: components.has_s7_financial,
          snapshot_created_at: components.snapshot_created_at,
          immutable_since: components.immutable_since,
          internal_tax_brl: components.internal_tax_brl,
          shipping_share_amount: components.shipping_share_amount,
          net_amount: components.net_amount,
        };
        pollLog.push(entry);
        if (isSnapshotRegressionReading(components, baselineComponents)) {
          regressions.push({ ...entry, kind: "transient_regression" });
        }
      }
      await sleep(POLL_MS);
    }
  })();

  /** @type {Promise<void>[]} */
  const syncJobs = [];
  for (let i = 0; i < REPROCESS_COUNT; i += 1) {
    syncJobs.push(
      spawnSync(STRESS_ORDER).catch((err) => {
        regressions.push({
          at: new Date().toISOString(),
          kind: "sync_error",
          message: err.message,
        });
      }),
    );
  }
  await Promise.all(syncJobs);
  polling = false;
  await pollLoop;

  const afterStress = await readOrderFingerprint(STRESS_ORDER);
  const regressionOrders = {};
  for (const [oid, expected] of Object.entries(REGRESSION_BASELINES)) {
    const fp = await readOrderFingerprint(oid);
    /** @type {Record<string, { expected: unknown; actual: unknown }>} */
    const delta = {};
    for (const [key, expectedValue] of Object.entries(expected)) {
      const actualValue = fp.components[key] ?? null;
      const normExpected =
        key.includes("tax_percent") && expectedValue != null
          ? Number(expectedValue).toFixed(4)
          : expectedValue;
      const normActual =
        key.includes("tax_percent") && actualValue != null
          ? Number(actualValue).toFixed(4)
          : actualValue;
      if (normActual !== normExpected) {
        delta[key] = { expected: normExpected, actual: normActual };
      }
    }
    regressionOrders[oid] = {
      fingerprint: fp.hash,
      delta_vs_historical: delta,
      pass: Object.keys(delta).length === 0,
    };
  }

  const fingerprintEqual =
    beforeStress.hash === afterStress.hash &&
    JSON.stringify(beforeStress.components) === JSON.stringify(afterStress.components);

  const report = {
    mission: "FIN.SSOT.SNAPSHOT-IMMUTABILITY.02",
    started_at_utc: startedAt,
    finished_at_utc: new Date().toISOString(),
    stress_order: STRESS_ORDER,
    reprocess_count: REPROCESS_COUNT,
    poll_interval_ms: POLL_MS,
    poll_readings: pollCount,
    poll_rows_logged: pollLog.length,
    s7_financial_missing_any_reading: pollLog.some((r) => r.has_s7_financial === false),
    transient_regressions_count: regressions.filter((r) => r.kind === "transient_regression").length,
    transient_state: regressions.some((r) => r.kind === "transient_regression")
      ? "REPRODUCED"
      : "NOT_REPRODUCED_POST_FIX",
    fingerprint_before: beforeStress.hash,
    fingerprint_after: afterStress.hash,
    fingerprint_equal: fingerprintEqual,
    before_components: beforeStress.components,
    after_components: afterStress.components,
    regression_orders: regressionOrders,
    regressions,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));

  if (report.s7_financial_missing_any_reading || report.transient_state === "REPRODUCED") {
    process.exit(2);
  }
  const regressionFail = Object.values(regressionOrders).some((r) => !r.pass);
  if (regressionFail) process.exit(3);
}

main().catch((err) => {
  console.error("[FAIL] prove_snapshot_immutability_stress_concurrent", err);
  process.exit(1);
});
