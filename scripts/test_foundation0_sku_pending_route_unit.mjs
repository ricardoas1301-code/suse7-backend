#!/usr/bin/env node
/**
 * Foundation 0 — contrato mínimo GET /api/ml/listings/sku-pending
 */
import handleMlListingsSkuPending from "../src/handlers/ml/listingsSkuPending.js";

/** @type {Array<{ name: string; detail: unknown }>} */
const failures = [];

function fail(name, detail) {
  failures.push({ name, detail: detail ?? true });
}

function mockRes() {
  /** @type {{ statusCode: number; body: unknown }} */
  const state = { statusCode: 200, body: null };
  return {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    },
    get state() {
      return state;
    },
  };
}

{
  const res = mockRes();
  await handleMlListingsSkuPending({ method: "POST", headers: {} }, res);
  if (res.state.statusCode !== 405) fail("method_not_allowed", res.state);
}

{
  const res = mockRes();
  await handleMlListingsSkuPending({ method: "GET", headers: {} }, res);
  if (res.state.statusCode !== 401) fail("unauthenticated_401", res.state);
  if (res.state.body?.error !== "Token não informado") fail("unauthenticated_message", res.state.body);
}

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "foundation0_sku_pending_route",
      cases: ["method_not_allowed", "unauthenticated_401"],
    },
    null,
    2,
  ),
);
