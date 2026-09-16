#!/usr/bin/env node
/**
 * CPJ2 — filtro exato GET /api/sales?external_listing_id=
 * Uso: node ./scripts/test_cpj2_listing_xray_exact_listing_filter_unit.mjs
 */

import assert from "node:assert/strict";
import {
  expandExactExternalListingIds,
  mergeListingScopeIds,
  parseExactExternalListingIdQuery,
} from "../src/domain/sales/resolverFiltroExatoListingIdLista.js";

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

test("ausência do parâmetro não aplica filtro", () => {
  const r = parseExactExternalListingIdQuery(undefined);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ids, []);
  assert.equal(parseExactExternalListingIdQuery("").ok, true);
  assert.deepEqual(parseExactExternalListingIdQuery("   ").ids, []);
});

test("wildcard / ILIKE rejeitados", () => {
  for (const raw of ["MLB%", "%4709614771%", "MLB*", "MLB_1", "MLB 123"]) {
    const r = parseExactExternalListingIdQuery(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(r.ids.length, 0);
  }
});

test("id longo demais falha fechado", () => {
  const r = parseExactExternalListingIdQuery("X".repeat(81));
  assert.equal(r.ok, false);
});

test("MLB expande para igualdade canônica, sem wildcard", () => {
  const ids = expandExactExternalListingIds("MLB4709614771");
  assert.ok(ids.includes("MLB4709614771"));
  assert.ok(ids.includes("4709614771"));
  assert.equal(ids.some((id) => id.includes("%")), false);
});

test("dígitos expandem para MLB/MLA exatos", () => {
  const ids = expandExactExternalListingIds("4709614771");
  assert.ok(ids.includes("4709614771"));
  assert.ok(ids.includes("MLB4709614771"));
  assert.ok(ids.includes("MLA4709614771"));
});

test("identificador semelhante não entra no conjunto exato", () => {
  const ids = new Set(expandExactExternalListingIds("MLB4709614771"));
  assert.equal(ids.has("MLB47096147719"), false);
  assert.equal(ids.has("MLB470961477"), false);
});

test("produto sozinho preserva IN dos anúncios vinculados", () => {
  const merged = mergeListingScopeIds({
    exactListingIds: [],
    productListingIds: ["MLB1", "MLB2"],
  });
  assert.deepEqual(merged, ["MLB1", "MLB2"]);
});

test("anúncio exato sozinho não usa universo do produto", () => {
  const merged = mergeListingScopeIds({
    exactListingIds: ["MLB1", "1"],
    productListingIds: null,
  });
  assert.deepEqual(merged, ["MLB1", "1"]);
});

test("anúncio exato AND produto = interseção", () => {
  const merged = mergeListingScopeIds({
    exactListingIds: ["MLB9", "MLB1"],
    productListingIds: ["MLB1", "MLB2"],
  });
  assert.deepEqual(merged, ["MLB1"]);
});

test("interseção vazia = universo vazio", () => {
  const merged = mergeListingScopeIds({
    exactListingIds: ["MLB9"],
    productListingIds: ["MLB1"],
  });
  assert.deepEqual(merged, []);
});

test("sem listing scope = null (Página Vendas)", () => {
  assert.equal(mergeListingScopeIds({}), null);
  assert.equal(mergeListingScopeIds({ exactListingIds: [], productListingIds: [] }), null);
});

if (failed > 0) {
  console.error(`LISTING EXACT FILTER FAIL ${failed}/${passed + failed}`);
  process.exit(1);
}
console.log(`LISTING EXACT FILTER PASS ${passed}/${passed}`);
