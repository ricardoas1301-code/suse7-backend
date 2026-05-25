#!/usr/bin/env node
/**
 * S_4.8.4 — Unit tests input customers-global
 */
import {
  normalizeCustomersGlobalSearchQuery,
  isValidGlobalCustomerId,
  CUSTOMERS_GLOBAL_SEARCH_MAX_LEN,
} from "../src/handlers/devCenter/devCenterCustomersGlobalInput.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert("empty q", normalizeCustomersGlobalSearchQuery("") === "");
assert("trim q", normalizeCustomersGlobalSearchQuery("  AbC  ") === "abc");
assert("collapse spaces", normalizeCustomersGlobalSearchQuery("a   b") === "a b");
assert("unicode", normalizeCustomersGlobalSearchQuery("ação café") === "ação café");
assert("special chars", normalizeCustomersGlobalSearchQuery("jo@o+100%") === "jo@o+100%");
assert(
  "max len",
  normalizeCustomersGlobalSearchQuery("x".repeat(CUSTOMERS_GLOBAL_SEARCH_MAX_LEN + 50)).length ===
    CUSTOMERS_GLOBAL_SEARCH_MAX_LEN,
);

const validUuid = "550e8400-e29b-41d4-a716-446655440000";
assert("valid uuid", isValidGlobalCustomerId(validUuid) === true);
assert("malformed", isValidGlobalCustomerId("not-a-uuid") === false);
assert("empty id", isValidGlobalCustomerId("") === false);
assert("long id", isValidGlobalCustomerId(`${validUuid}${"0".repeat(100)}`) === false);

if (failures.length) {
  console.error("[S_4.8.4 input unit] FAIL", failures);
  process.exit(1);
}

console.log("[S_4.8.4 input unit] OK");
