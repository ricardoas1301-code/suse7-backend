#!/usr/bin/env node
/**
 * DB-SSOT — billingPlanRepository lê public.plans; hardcodes mapeados
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, "..");
const billingRepo = readFileSync(join(repo, "src/billing/services/billingPlanRepository.js"), "utf8");
const usage = readFileSync(join(repo, "src/billing/services/billingUsageService.js"), "utf8");
const subscriptionPlans = readFileSync(join(repo, "../suse7-frontend/src/constants/subscriptionPlans.js"), "utf8");

/** @type {string[]} */
const failures = [];
function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert("repository reads plans table", billingRepo.includes('.from("plans")'));
assert("usage loads plan by id", usage.includes("getActivePlanById"));
assert("usage uses sales_limit_monthly", usage.includes("sales_limit_monthly"));

const frontendBilling = join(repo, "../suse7-frontend/src/billing");
let subscriptionPlansImported = false;
for (const file of walk(frontendBilling)) {
  const content = readFileSync(file, "utf8");
  if (content.includes("subscriptionPlans") || content.includes("SUSE7_SUBSCRIPTION_PLANS")) {
    subscriptionPlansImported = true;
  }
}
assert("legacy subscriptionPlans.js not imported in billing UI", !subscriptionPlansImported);

function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

if (failures.length) {
  console.error("[plans db ssot static] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("[OK] test_dev_v2_plans_db_ssot_unit.mjs");
