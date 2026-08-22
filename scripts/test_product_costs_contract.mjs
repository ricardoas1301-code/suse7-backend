#!/usr/bin/env node
/**
 * P0.4.3 — product costs domain/handlers contract (restaurados de 9f867bf).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isValidProductId,
  parseMoneyDecimalString,
  validateProductCostsPayload,
} from "../src/domain/products/persistProductCosts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const rel of [
  "src/handlers/products/costsPendingList.js",
  "src/handlers/products/costsBatchSave.js",
  "src/domain/products/persistProductCosts.js",
  "src/domain/products/productCostsPendingRepository.js",
]) {
  assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
}

const v = validateProductCostsPayload({
  cost_price: "39,00",
  packaging_cost: "0,31",
  operational_cost: "0,22",
});
assert.equal(v.ok, true);
assert.equal(v.costs.cost_price, "39.00");
assert.equal(v.costs.packaging_cost, "0.31");
assert.equal(v.costs.operational_cost, "0.22");

assert.equal(parseMoneyDecimalString("39,00").value, "39.00");
assert.equal(isValidProductId("00000000-0000-4000-8000-000000000001"), true);
assert.equal(isValidProductId("not-uuid"), false);

console.log(JSON.stringify({ ok: true, test: "test_product_costs_contract" }));
