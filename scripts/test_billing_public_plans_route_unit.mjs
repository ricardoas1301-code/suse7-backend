#!/usr/bin/env node
/**
 * Paridade PROD — GET /api/billing/plans público (visitante sem token).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const root = dirname(fileURLToPath(import.meta.url));
const billingRoutes = readFileSync(join(root, "../src/billing/routes/billingRoutes.js"), "utf8");

const plansBlock = billingRoutes.slice(
  billingRoutes.indexOf('if (pathNorm === "/api/billing/plans")'),
  billingRoutes.indexOf('if (pathNorm === "/api/billing/checkout/card")'),
);

assert("plans route exists", plansBlock.includes("/api/billing/plans"));
assert("plans allows anonymous via service role", plansBlock.includes("auth.error") && plansBlock.includes("createClient"));
assert("plans does not hard-fail UNAUTHORIZED for anonymous", !plansBlock.includes('code: "UNAUTHORIZED"'));
assert("plans still uses listActivePlans", plansBlock.includes("listActivePlans"));

if (failures.length) {
  console.error(JSON.stringify({ pass: false, test: "billing_public_plans_route_unit", failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ pass: true, test: "billing_public_plans_route_unit", cases: 4 }));
