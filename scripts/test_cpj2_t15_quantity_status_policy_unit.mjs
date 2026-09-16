#!/usr/bin/env node
/**
 * CPJ2-T15 — quantity canônica + política de status elegível (reuso, sem regra nova).
 * Uso: node ./scripts/test_cpj2_t15_quantity_status_policy_unit.mjs
 */

import assert from "node:assert/strict";
import { saleDetailToQty } from "../src/domain/sales/saleDetailInternalCosts.js";
import { isExecutiveSummaryEligibleOrder } from "../src/domain/sales/saleExecutiveOrderValidity.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`, error instanceof Error ? error.message : error);
  }
}

test("quantity 1 → 1", () => {
  assert.equal(saleDetailToQty(1), 1);
});

test("quantity 5 → 5", () => {
  assert.equal(saleDetailToQty(5), 5);
});

test("quantity nulo/inválido → 1 (política existente)", () => {
  assert.equal(saleDetailToQty(null), 1);
  assert.equal(saleDetailToQty(""), 1);
  assert.equal(saleDetailToQty(0), 1);
});

test("soma 3+2 → 5", () => {
  assert.equal(saleDetailToQty(3) + saleDetailToQty(2), 5);
});

test("cancelados/devolvidos excluídos pela política canônica", () => {
  assert.equal(isExecutiveSummaryEligibleOrder("paid"), true);
  assert.equal(isExecutiveSummaryEligibleOrder("cancelled"), false);
  assert.equal(isExecutiveSummaryEligibleOrder("canceled"), false);
  assert.equal(isExecutiveSummaryEligibleOrder("refunded"), false);
  assert.equal(isExecutiveSummaryEligibleOrder("charged_back"), false);
});

if (failed > 0) {
  console.error(`T15 BE FAIL ${failed}/${passed + failed}`);
  process.exit(1);
}
console.log(`T15 BE PASS ${passed}/${passed}`);
