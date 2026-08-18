#!/usr/bin/env node
/**
 * LOTE A — contrato mínimo GET /api/sales/top10 (sem rede real).
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://alkelcaoexxbamqddaqv.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role-key-not-used";

const { default: handleSalesTop10 } = await import("../src/handlers/sales/top10.js");

/** @type {Array<{ name: string; detail: unknown }>} */
const failures = [];

function fail(name, detail) {
  failures.push({ name, detail });
}

/** @param {string} method */
function mockReq(method = "GET") {
  return {
    method,
    headers: {},
    query: {},
  };
}

function mockRes() {
  /** @type {Record<string, unknown>} */
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
    getState: () => state,
  };
}

{
  const req = mockReq("POST");
  const res = mockRes();
  await handleSalesTop10(req, res);
  const st = res.getState();
  if (st.statusCode !== 405) fail("method_not_allowed", st);
}

{
  const req = mockReq("GET");
  const res = mockRes();
  await handleSalesTop10(req, res);
  const st = res.getState();
  if (st.statusCode !== 401 && st.statusCode !== 503) {
    fail("unauthenticated_expected", st);
  }
}

if (failures.length) {
  console.error(JSON.stringify({ pass: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "lote_a_sales_top10_route_unit",
      cases: ["method_not_allowed", "unauthenticated"],
    },
    null,
    2,
  ),
);
