#!/usr/bin/env node
/**
 * CPJ2 T11 — watermark inbound leve (Option B). Sem scan de sales_orders.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeSalesInboundWatermarkFromAccountRows,
  readSalesInboundWatermark,
  shouldTouchSalesInboundWatermark,
  touchSalesInboundWatermark,
} from "../src/services/marketplace/mlSalesAccountWatermark.js";

const root = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(root, "..", rel), "utf8");

const LOJA_A = "ab85841e-fa8f-44a1-8db1-853560170241";
const LOJA_B = "9ee145d1-b6ff-4a44-a0ca-3bab5d7e9ef0";
const USER = "40e77149-aaaa-bbbb-cccc-dddddddddddd";

assert.equal(shouldTouchSalesInboundWatermark(null), false);
assert.equal(shouldTouchSalesInboundWatermark({ ok: false, reason: "lookup_failed" }), false);
assert.equal(shouldTouchSalesInboundWatermark({ ok: true, salesOrderId: "x" }), true);
console.log("T11_WRITE_BOUNDARY=PASS");

assert.equal(composeSalesInboundWatermarkFromAccountRows([]), null);
assert.equal(
  composeSalesInboundWatermarkFromAccountRows([
    { id: LOJA_A, ml_sales_last_sync_at: "2026-09-11T10:00:00.000Z" },
    { id: LOJA_B, ml_sales_last_sync_at: "2026-09-11T12:00:00.000Z" },
  ]),
  "2026-09-11T12:00:00.000Z",
);
assert.equal(
  composeSalesInboundWatermarkFromAccountRows([{ id: LOJA_A, ml_sales_last_sync_at: "2026-09-11T10:00:00.000Z" }]),
  "2026-09-11T10:00:00.000Z",
);
console.log("T11_COMPOSE_MAX=PASS");

{
  const eqs = [];
  let payload = null;
  const sb = {
    from(table) {
      assert.equal(table, "marketplace_accounts");
      return {
        update(body) {
          payload = body;
          return {
            eq(col, val) {
              eqs.push([col, val]);
              return { error: null };
            },
          };
        },
      };
    },
  };
  await touchSalesInboundWatermark(sb, LOJA_A, "2026-09-11T12:00:00.000Z");
  assert.equal(payload.ml_sales_last_sync_at, "2026-09-11T12:00:00.000Z");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "ml_sales_last_synced_order_created_to"), false);
  assert.deepEqual(eqs, [["id", LOJA_A]]);
  console.log("T11_TOUCH_DOES_NOT_ADVANCE_CREATED_TO=PASS");
}

{
  const eqs = [];
  const rows = [
    { id: LOJA_A, ml_sales_last_sync_at: "2026-09-11T10:00:00.000Z" },
    { id: LOJA_B, ml_sales_last_sync_at: "2026-09-11T12:00:00.000Z" },
  ];
  const q = {
    select() {
      return q;
    },
    eq(col, val) {
      eqs.push([col, val]);
      return q;
    },
    then(resolve) {
      let out = rows;
      const userEq = eqs.find((e) => e[0] === "user_id");
      const idEq = eqs.find((e) => e[0] === "id");
      assert.ok(userEq, "sempre filtra user_id");
      if (userEq[1] !== USER) out = [];
      if (idEq) out = out.filter((r) => r.id === idEq[1]);
      resolve({ data: out, error: null });
    },
  };
  const sb = { from: () => q };
  const all = await readSalesInboundWatermark(sb, USER, null);
  assert.equal(all.watermark, "2026-09-11T12:00:00.000Z");
  assert.equal(all.account_count, 2);
  eqs.length = 0;
  const one = await readSalesInboundWatermark(sb, USER, LOJA_A);
  assert.equal(one.watermark, "2026-09-11T10:00:00.000Z");
  assert.equal(one.account_count, 1);
  eqs.length = 0;
  const otherUser = await readSalesInboundWatermark(sb, "other-user", LOJA_A);
  assert.equal(otherUser.watermark, null);
  assert.equal(otherUser.account_count, 0);
  console.log("T11_ISOLATION_ALL_AND_STORE=PASS");
}

{
  const apply = read("src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js");
  assert.equal(apply.includes("touchSalesInboundWatermark"), true);
  assert.equal(apply.includes("shouldTouchSalesInboundWatermark"), true);
  const webhook = read("src/handlers/ml/mlWebhookProcessor.js");
  assert.equal(webhook.includes("advanceMlSalesWatermark"), false);
  assert.equal(webhook.includes("ml_sales_last_synced_order_created_to"), false);
  const router = read("api/index.js");
  assert.equal(router.includes("/api/sales/inbound-watermark"), true);
  const handler = read("src/handlers/sales/inboundWatermark.js");
  assert.equal(handler.includes("sales_orders"), false);
  assert.equal(handler.includes("gatePremiumHandler"), true);
  assert.equal(handler.includes("requireAuthUser"), true);
  console.log("T11_ENDPOINT_AND_WEBHOOK_INVARIANT=PASS");
}

console.log("T11_WATERMARK_UNIT_ALL=PASS");
