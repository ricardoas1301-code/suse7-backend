#!/usr/bin/env node
/**
 * CPJ-0004 — serializeLinkedListingIds (contrato rankings.products).
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const beRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modUrl = pathToFileURL(
  path.join(beRoot, "src/domain/sales/buildSaleExecutiveSummary.js"),
).href;

const { serializeLinkedListingIds } = await import(modUrl);

assert.deepEqual(serializeLinkedListingIds(new Set(["MLB2", "MLB1", "MLB2"])), ["MLB1", "MLB2"]);
assert.deepEqual(serializeLinkedListingIds(["MLB9", "", "MLB3", "MLB9"]), ["MLB3", "MLB9"]);
assert.deepEqual(serializeLinkedListingIds(null), []);
assert.deepEqual(serializeLinkedListingIds(undefined), []);
assert.equal(serializeLinkedListingIds(new Set(["ONLY"])).length, 1);
assert.equal(serializeLinkedListingIds(new Set(["A", "B"])).length, 2);

console.log("[OK] test_cpj4_linked_listing_ids_unit");
