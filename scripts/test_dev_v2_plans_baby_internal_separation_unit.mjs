#!/usr/bin/env node
/**
 * BABY_INTERNAL_FREE não altera catálogo comercial public.plans
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const internalBaby = readFileSync(join(__dirname, "../src/billing/services/internalBabyPlanService.js"), "utf8");

/** @type {string[]} */
const failures = [];
function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert("no UPDATE plans", !/\bUPDATE\s+public\.plans\b/i.test(internalBaby));
assert("no UPDATE plans shorthand", !/\bUPDATE\s+plans\b/i.test(internalBaby));
assert("inserts billing_subscriptions only", internalBaby.includes('.from("billing_subscriptions").insert'));
assert("uses commercial baby anchor", internalBaby.includes("resolveInternalBabyCommercialPlan"));
assert("internal amount zero", internalBaby.includes('amount: "0.00"'));
assert("internal provider", internalBaby.includes('provider: "internal"'));

if (failures.length) {
  console.error("[baby internal separation] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("[OK] test_dev_v2_plans_baby_internal_separation_unit.mjs");
