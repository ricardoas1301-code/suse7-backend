#!/usr/bin/env node
/**
 * CPJ2-T17 — parser items[] + rota sku-pending + zero à esquerda.
 * Uso: node ./scripts/test_cpj2_t17_sku_linking_unit.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBulkSetSkuPayload, preservarSkuLiteral } from "../src/handlers/listings/parseBulkSetSkuPayload.js";
import { normalizeSkuForDbLookup } from "../src/domain/productCatalogCompleteness.js";

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

test("SKU vazio permanece vazio", () => {
  assert.equal(preservarSkuLiteral("   "), "");
  assert.equal(preservarSkuLiteral(null), "");
});

test("0170 preserva zero à esquerda", () => {
  const sku = preservarSkuLiteral("0170");
  assert.equal(sku, "0170");
  assert.equal(normalizeSkuForDbLookup(sku), "0170");
  assert.notEqual(sku, String(Number(sku)));
});

test("UPPER de lookup é contrato preexistente; literal não muda case", () => {
  assert.equal(preservarSkuLiteral("ab-0170"), "ab-0170");
  assert.equal(preservarSkuLiteral("AB-0170"), "AB-0170");
  assert.equal(preservarSkuLiteral(" ab-0170 "), "ab-0170");
  assert.equal(normalizeSkuForDbLookup("ab-0170"), "AB-0170");
  assert.equal(normalizeSkuForDbLookup("AB-0170"), "AB-0170");
  assert.equal(normalizeSkuForDbLookup(" ab-0170 "), "AB-0170");
});

test("payload items[] unitário", () => {
  const parsed = parseBulkSetSkuPayload({
    marketplace: "mercado_livre",
    items: [{ listing_id: "listing-a", sku: "0170", selected_product_id: "prod-1" }],
  });
  assert.equal(parsed.mode, "items");
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].skuRaw, "0170");
  assert.deepEqual(parsed.groups[0].listingTokens, ["listing-a"]);
  assert.deepEqual(parsed.allListingTokens, ["listing-a"]);
});

test("payload legado sku + listing_ids continua válido", () => {
  const parsed = parseBulkSetSkuPayload({
    sku: "0170",
    listing_ids: ["listing-a", "listing-b"],
  });
  assert.equal(parsed.mode, "legacy");
  assert.equal(parsed.groups[0].skuRaw, "0170");
  assert.deepEqual(parsed.allListingTokens, ["listing-a", "listing-b"]);
});

test("items[] não lê body.sku de topo — evita falso SKU obrigatório", () => {
  const parsed = parseBulkSetSkuPayload({
    items: [{ listing_id: "listing-a", sku: "0170" }],
  });
  assert.equal(parsed.groups[0].skuRaw, "0170");
  assert.notEqual(parsed.mode, "legacy");
});

test("rota sku-pending registrada no router", () => {
  const src = fs.readFileSync(path.join(beRoot, "api/index.js"), "utf8");
  assert.match(src, /path === "\/api\/ml\/listings\/sku-pending"/);
  assert.match(src, /listingSkuPending\.js/);
});

test("inventário billing classifica sku-pending sem mudar política de plano", () => {
  const src = fs.readFileSync(
    path.join(beRoot, "src/billing/services/billingEntitlementRouteRegistry.js"),
    "utf8",
  );
  assert.match(src, /"\/api\/ml\/listings\/sku-pending"/);
});

if (failed > 0) {
  console.error(`T17 BE FAIL ${failed}/${passed + failed}`);
  process.exit(1);
}
console.log(`T17 BE PASS ${passed}/${passed}`);
