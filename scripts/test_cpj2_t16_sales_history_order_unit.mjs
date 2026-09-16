#!/usr/bin/env node
/**
 * CPJ2-T16 — page_size 100 já cabe no backend; fallback PostgREST ganha desempate por id.
 * Uso: node ./scripts/test_cpj2_t16_sales_history_order_unit.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveExecutiveSummaryPeriod,
  resolveSalesListPeriod,
} from "../src/domain/sales/saleExecutivePeriod.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const beRoot = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(beRoot, "src/handlers/sales/list.js"), "utf8");
const srcCanonical = fs.readFileSync(
  path.join(beRoot, "src/domain/sales/vendasListCanonicalOrder.js"),
  "utf8",
);

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

test("page_size aceita 100 (teto 200)", () => {
  assert.match(src, /Math\.min\(200, toPositiveInt\(req\.query\?\.page_size, 50\)\)/);
});

test("embed path já ordena por id DESC", () => {
  assert.match(src, /paginateVendasItemsCanonical|sortSalesOrderItemsForVendasList/);
  assert.match(srcCanonical, /idb\.localeCompare\(ida\)/);
});

test("fallback postgrest_plain também desempata por id DESC", () => {
  const idxPlain = src.indexOf('listSource = "postgrest_plain"');
  assert.ok(idxPlain > 0);
  assert.match(src, /postgrest_plain_canonical/);
  assert.match(src, /paginateVendasItemsCanonical/);
});

test("paginação real usa offset canônico after scan", () => {
  assert.match(src, /paginateVendasItemsCanonical\(stripped, embeddedOrders, from, pageSize\)/);
});

test("lista /api/sales usa resolveSalesListPeriod", () => {
  assert.match(src, /resolveSalesListPeriod\(req\.query \?\? \{\}, \{ productId \}\)/);
});

test("sem período, listagem genérica continua 60d", () => {
  const r = resolveExecutiveSummaryPeriod({});
  assert.equal(r.ok, true);
  assert.equal(r.period.preset, "60d");
  assert.ok(r.period.start_ms != null);
});

test("produto sem período explícito na lista = lifetime, não 60d", () => {
  const r = resolveSalesListPeriod({}, { productId: "prod-1" });
  assert.equal(r.ok, true);
  assert.equal(r.period.preset, "lifetime");
  assert.equal(r.period.start_ms, null);
  assert.equal(r.period.end_ms_exclusive, null);
});

test("produto com período custom da Página Vendas permanece recortado", () => {
  const r = resolveSalesListPeriod(
    { period_preset: "custom", start_date: "2026-08-15", end_date: "2026-09-14" },
    { productId: "prod-1" },
  );
  assert.equal(r.ok, true);
  assert.equal(r.period.preset, "custom");
  assert.equal(r.period.start_date, "2026-08-15");
  assert.equal(r.period.end_date, "2026-09-14");
});

test("lifetime explícito não vira 60d", () => {
  const r = resolveSalesListPeriod({ period_preset: "lifetime" }, { productId: null });
  assert.equal(r.ok, true);
  assert.equal(r.period.preset, "lifetime");
  assert.equal(r.period.start_ms, null);
});

test("lista lê o parâmetro dedicado external_listing_id", () => {
  assert.match(src, /parseExactExternalListingIdQuery\(req\.query\?\.external_listing_id\)/);
  assert.match(src, /mergeListingScopeIds/);
  assert.match(src, /exactListingIds\.length > 0/);
});

test("filtro exato de anúncio entra em listingScopeIds antes do q textual", () => {
  const idxFn = src.indexOf("function applySalesItemListFilters");
  assert.ok(idxFn > 0);
  const slice = src.slice(idxFn, idxFn + 1600);
  const idxListing = slice.indexOf('q.in("external_listing_id", f.listingScopeIds)');
  const idxQ = slice.indexOf("if (f.qNormalized)");
  assert.ok(idxListing > 0, "listingScopeIds deve filtrar external_listing_id");
  assert.ok(idxQ > idxListing, "q textual deve vir depois do filtro exato");
  assert.match(slice, /buildVendasSalesItemQOrFilter/);
  assert.doesNotMatch(slice, /productListingIds/);
});

test("scan e paginação canônica usam a mesma applySalesItemListFilters", () => {
  assert.match(src, /select\(ITEM_ORDER_EMBED\)/);
  const idxScan = src.indexOf("applySalesItemListFilters(");
  const idxCanonical = src.lastIndexOf("paginateVendasItemsCanonical");
  assert.ok(idxScan > 0);
  assert.ok(idxCanonical > idxScan);
});

test("RPC é ignorada quando há filtro exato de anúncio", () => {
  const idxSkip = src.indexOf("const skipRpcForListFilters");
  const slice = src.slice(idxSkip, idxSkip + 700);
  assert.match(slice, /exactListingIds\.length > 0/);
});

test("q textual da Página Vendas permanece no handler", () => {
  assert.match(src, /req\.query\?\.q != null/);
  assert.match(src, /buildVendasSalesItemQOrFilter/);
  assert.match(src, /fetchVendasSearchOrderIds/);
});

if (failed > 0) {
  console.error(`T16 BE FAIL ${failed}/${passed + failed}`);
  process.exit(1);
}
console.log(`T16 BE PASS ${passed}/${passed}`);
