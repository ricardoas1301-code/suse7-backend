#!/usr/bin/env node
/**
 * Paridade PROD — GET /api/sales/top10 handler presente no artefato.
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
const apiIndex = readFileSync(join(root, "../api/index.js"), "utf8");
const top10Src = readFileSync(join(root, "../src/handlers/sales/top10.js"), "utf8");

assert("router registra /api/sales/top10", apiIndex.includes('path === "/api/sales/top10"'));
assert("top10 export default handler", top10Src.includes("export default async function handleSalesTop10"));
assert("top10 fail-soft empty payload", top10Src.includes("buildEmptyExecutiveSummaryPayload"));
assert("top10 requer auth seller", top10Src.includes("requireAuthUser"));

if (failures.length) {
  console.error(JSON.stringify({ pass: false, test: "sales_top10_route_unit", failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ pass: true, test: "sales_top10_route_unit", cases: 4 }));
