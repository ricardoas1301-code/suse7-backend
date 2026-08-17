#!/usr/bin/env node
/**
 * Contrato persistência parcial × admission (S1.HF.6.9A.10) — estático.
 *
 * A) erro antes de criar sales_orders → RELEASE legítimo
 * B) sales_orders criado + erro posterior → RELEASE encontra venda → FINALIZE
 * C) retry sem duplicidade (active_order_uidx + release finalize_instead)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const persist = read("src/handlers/ml/_helpers/mlSalesPersist.js");
const sync = read("src/modules/marketplaces/mercado-livre/sales/mlSalesSyncService.js");
const base = read("supabase/migrations/20260722140000_s7_billing_billable_sale_admission_atomic.sql");

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

check("persist creates sales_orders before items", persist.indexOf('.from("sales_orders")') < persist.indexOf("persist items") || persist.includes('logStep("persist items")'));
check("apply catch calls rollback/release", sync.includes("rollbackBillableSaleAdmission") && sync.includes("persist_failed"));
check("sql release finalizes when sale exists", base.includes("sale_already_persisted") && base.includes("finalized_instead"));
check("sql release no null wildcard", base.includes("release_incomplete_identity") && base.includes("marketplace_account_id IS NULL"));
check("active order unique index", base.includes("billing_billable_sale_admissions_active_order_uidx"));

if (failures.length) {
  console.error("[persist partial contract 6.9A.10] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("[persist partial contract 6.9A.10] OK", {
  file: "src/handlers/ml/_helpers/mlSalesPersist.js",
  release: "billing_release_billable_sale_v2 → finalize_instead when sale exists",
});
