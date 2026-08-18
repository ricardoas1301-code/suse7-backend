#!/usr/bin/env node
/**
 * Guard tests — caller audit patterns (static)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const apiIndex = read(path.join(ROOT, "suse7-backend", "api", "index.js"));
assert(apiIndex.includes("billing-billable-sale-admission-reconciler"), "api index deve rotear admission reconciler");

const prodCron = read(path.join(ROOT, "suse7-backend", ".github", "workflows", "billing-maintenance-cron.yml"));
assert(!/billing_admit_billable_sale_v1|billing_reserve_billable_sale_v2/.test(prodCron), "cron PROD não deve referenciar RPC v1/v2");

const devHomolog = read(path.join(ROOT, "scripts", "dev_homologation_cycle_reset.mjs"));
assert(devHomolog.includes("billing_count_admitted_billable_sales"), "script DEV homolog usa count RPC");

const frontendSrc = path.join(ROOT, "suse7-frontend", "src");
let frontendHits = 0;
if (fs.existsSync(frontendSrc)) {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(e.name)) {
        const t = read(p);
        if (/billing_admit_billable_sale_v1|billing_reserve_billable_sale_v2/.test(t)) frontendHits++;
      }
    }
  };
  walk(frontendSrc);
}
assert(frontendHits === 0, "frontend não deve chamar RPCs billing admission v1/v2");

console.log(JSON.stringify({ pass: true, tests: 4 }, null, 2));
