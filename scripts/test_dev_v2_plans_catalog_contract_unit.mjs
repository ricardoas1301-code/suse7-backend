#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUSE7_FRESH_PLANS_CATALOG_BASELINE,
  planCentsToPriceMonthlyString,
} from "./fixtures/suse7FreshPlansCatalogBaseline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "../../suse7-frontend/supabase/migrations/20260301220001_plans_commercial_schema_bootstrap.sql");
const seedPath = path.join(__dirname, "../../suse7-frontend/supabase/migrations/20260301220002_plans_fresh_initial_catalog_seed.sql");
const schema = fs.readFileSync(schemaPath, "utf8");
const seed = fs.readFileSync(seedPath, "utf8");

const failures = [];
function assert(name, cond) {
  if (!cond) failures.push(name);
}

const expectedKeys = ["baby", "start", "crescer", "pro", "scale", "elite", "enterprise", "infinity"];
assert("fixture has 8 plans", SUSE7_FRESH_PLANS_CATALOG_BASELINE.length === 8);
for (const key of expectedKeys) {
  assert(`fixture contains ${key}`, SUSE7_FRESH_PLANS_CATALOG_BASELINE.some((p) => p.plan_key === key));
}

for (const plan of SUSE7_FRESH_PLANS_CATALOG_BASELINE) {
  assert(`${plan.plan_key} id in seed`, seed.includes(plan.canonical_id));
  if (plan.pricing_mode === "fixed") assert(`${plan.plan_key} price in seed`, seed.includes(String(plan.price_cents)));
}

assert("schema has ADD COLUMN IF NOT EXISTS", schema.includes("ADD COLUMN IF NOT EXISTS"));
assert("schema no INSERT commercial", !/INSERT\s+INTO\s+public\.plans/i.test(schema));
assert("seed fresh-only guard", seed.includes("v_existing_count > 0"));
assert("seed no ON CONFLICT UPDATE commercial", !/ON CONFLICT \(name\) DO UPDATE SET/i.test(seed));
assert("schema no baby=50 validation", !schema.includes("baby sales_limit_monthly esperado 50"));

if (failures.length) {
  console.error("[plans catalog contract] FAIL", failures);
  process.exit(1);
}
console.log("[OK] test_dev_v2_plans_catalog_contract_unit.mjs");
