#!/usr/bin/env node
/**
 * P0.3-C.1M — validação estática da migration manual review pending.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(
  root,
  "supabase/migrations/20260821160000_s7_billing_manual_review_pending_p0_3c1m.sql",
);
const sql = fs.readFileSync(migrationPath, "utf8");
const hardening = fs.readFileSync(
  path.join(root, "supabase/migrations/20260723140000_s7_billing_billable_sale_admission_atomic_hardening_6_9a10.sql"),
  "utf8",
);

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

check("migration file exists", fs.existsSync(migrationPath));
check("CHECK includes PENDING_MANUAL_REVIEW", sql.includes("'PENDING_MANUAL_REVIEW'"));
check("CHECK includes FINAL_NOT_BILLABLE", sql.includes("'FINAL_NOT_BILLABLE'"));
check("legacy states preserved in CHECK", sql.includes("'RECOVERY_REQUIRED'") && sql.includes("'REJECTED_QUOTA'"));
check("upsert RPC present", sql.includes("billing_upsert_manual_review_pending_v1"));
check("SECURITY DEFINER + search_path", /SECURITY DEFINER[\s\S]*SET search_path = public/.test(sql));
check("REVOKE new RPC", sql.includes("REVOKE ALL ON FUNCTION public.billing_upsert_manual_review_pending_v1"));
check("pending selector index", sql.includes("billing_billable_sale_admissions_pending_review_idx"));
check("active_order_uidx includes pending", /active_order_uidx[\s\S]*PENDING_MANUAL_REVIEW/.test(sql));
check("idempotency_uidx includes pending", /idempotency_uidx[\s\S]*PENDING_MANUAL_REVIEW/.test(sql));
check("no sales_orders mutation", !/ALTER TABLE public\.sales_orders/i.test(sql));
check("no trigger on sales_orders", !/CREATE TRIGGER[\s\S]*sales_orders/i.test(sql));
check("no DROP column", !/DROP COLUMN/i.test(sql));
check("historical import guard in RPC", sql.includes("historical_import_blocked"));
check("uses canonical idempotency builder", sql.includes("billing_internal_build_admission_idempotency_key"));
check("slot counter unchanged in migration", !/CREATE OR REPLACE FUNCTION public\.billing_count_active_billable_slots/.test(sql));
check(
  "hardening slot counter excludes pending (baseline)",
  hardening.includes("AND admission_result IN ('RESERVED', 'PERSISTED', 'RECOVERY_REQUIRED')"),
);
check("expand-first BEGIN/COMMIT", sql.includes("BEGIN;") && sql.includes("COMMIT;"));
check("pre-expand row validation DO block", sql.includes("p0_3c1m: admission_result inesperado"));

if (failures.length) {
  console.error("[P0.3-C.1M static] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("[P0.3-C.1M static] OK", { migration: path.basename(migrationPath), checks: 19 });
