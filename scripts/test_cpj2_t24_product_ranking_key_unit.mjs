#!/usr/bin/env node
/**
 * CPJ2-T24 — chave de ranking do Top 3 e account id dominante.
 * Uso: node ./scripts/test_cpj2_t24_product_ranking_key_unit.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExecutiveProductRankingKey } from "../src/domain/sales/resolveExecutiveProductRankingKey.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beRoot = path.resolve(__dirname, "..");

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

test("produto canônico agrupa por product_id", () => {
  const key = resolveExecutiveProductRankingKey({
    attributionProductId: "prod-1",
    listingId: "MLB-A",
    accountId: "acc-rp",
  });
  assert.equal(key, "pid::prod-1");
});

test("sem product_id — SKU não é descartado quando há mapa de listing", () => {
  const key = resolveExecutiveProductRankingKey({
    attributionProductId: null,
    skuNorm: "PARAFUSO-8",
    sellerCo: "co-1",
    listingId: "MLB-A",
    accountId: "acc-rp",
  });
  assert.equal(key, "sku::co-1::PARAFUSO-8");
});

test("sem product_id e sem SKU — listing+conta permanece elegível", () => {
  const a = resolveExecutiveProductRankingKey({
    listingId: "MLB-A",
    marketplace: "mercado_livre",
    accountId: "acc-rp",
  });
  const b = resolveExecutiveProductRankingKey({
    listingId: "MLB-B",
    marketplace: "mercado_livre",
    accountId: "acc-churrasco",
  });
  assert.equal(a, "listing::mercado_livre::acc-rp::MLB-A");
  assert.equal(b, "listing::mercado_livre::acc-churrasco::MLB-B");
  assert.notEqual(a, b);
});

test("sem listing e sem produto → excluído de forma explícita", () => {
  assert.equal(resolveExecutiveProductRankingKey({}), null);
});

test("payload do ranking de produtos serializa marketplace_account_id", () => {
  const src = fs.readFileSync(path.join(beRoot, "src/domain/sales/buildSaleExecutiveSummary.js"), "utf8");
  assert.ok(src.includes("resolveExecutiveProductRankingKey"));
  assert.ok(src.includes("marketplace_account_id: row.marketplace_account_id ?? null"));
  assert.ok(src.includes("accountQtyById"));
  assert.equal(src.includes("!listingProductMap && skuNorm"), false);
});

console.log(`\nResumo T24 ranking key: ${passed} OK, ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
