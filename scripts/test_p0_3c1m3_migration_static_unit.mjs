#!/usr/bin/env node
/**
 * P0.3-C.1M3 — validação estática da migration unresolved cycle.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(
  root,
  "supabase/migrations/20260821200000_s7_billing_manual_review_unresolved_cycle_p0_3c1m3.sql",
);
const c1mPath = path.join(
  root,
  "supabase/migrations/20260821160000_s7_billing_manual_review_pending_p0_3c1m.sql",
);
const c1m2Path = path.join(
  root,
  "supabase/migrations/20260821180000_s7_billing_manual_review_transition_p0_3c1m2.sql",
);

const sql = fs.readFileSync(migrationPath, "utf8");
const c1m = fs.readFileSync(c1mPath, "utf8");
const c1m2 = fs.readFileSync(c1m2Path, "utf8");

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

check("migration file exists", fs.existsSync(migrationPath));
check("cycle_key DROP NOT NULL", /ALTER COLUMN cycle_key DROP NOT NULL/.test(sql));
check("cycle null CHECK pending/final", /billing_billable_sale_admissions_cycle_null_chk/.test(sql));
check("cycle required CHECK active states", /billing_billable_sale_admissions_cycle_required_chk/.test(sql));
check("pending unresolved partial unique", /billing_billable_sale_admissions_pending_unresolved_order_uidx/.test(sql));
check("final unresolved partial unique", /billing_billable_sale_admissions_final_unresolved_order_uidx/.test(sql));
check("idempotency pending partial unique", /billing_billable_sale_admissions_idempotency_pending_uidx/.test(sql));
check("active_order requires cycle NOT NULL", /active_order_uidx[\s\S]*cycle_key IS NOT NULL/.test(sql));
check("upsert v2 present", sql.includes("billing_upsert_manual_review_pending_v2"));
check("resolve cycle RPC present", sql.includes("billing_resolve_pending_cycle_v1"));
check("pending idempotency builder", sql.includes("billing_internal_build_pending_manual_review_idempotency_key"));
check("forbidden sentinel guard", sql.includes("billing_internal_is_forbidden_cycle_sentinel"));
check("promote cycle_unresolved guard", /reason', 'cycle_unresolved'/.test(sql));
check("SECURITY DEFINER + search_path v2", /billing_upsert_manual_review_pending_v2[\s\S]*SECURITY DEFINER[\s\S]*SET search_path = public/.test(sql));
check("REVOKE upsert v2", sql.includes("REVOKE ALL ON FUNCTION public.billing_upsert_manual_review_pending_v2"));
check("REVOKE resolve", sql.includes("REVOKE ALL ON FUNCTION public.billing_resolve_pending_cycle_v1"));
check("no RF admission IDs", !/17802411-c323-407e-ab8d-159a0ea740b7/.test(sql));
check("no data remediation UPDATE", !/UPDATE public\.billing_billable_sale_admissions[\s\S]*SET cycle_key = NULL/.test(sql));
check("v1 untouched", !/CREATE OR REPLACE FUNCTION public\.billing_upsert_manual_review_pending_v1/.test(sql));
check("expand-first BEGIN/COMMIT", sql.includes("BEGIN;") && sql.includes("COMMIT;"));
check("pre-expand validation block", sql.includes("p0_3c1m3: cycle_key NULL preexistente"));
check("C.1M file untouched", c1m.includes("billing_upsert_manual_review_pending_v1"));
check("C.1M2 file untouched", c1m2.includes("billing_finalize_manual_review_not_billable_v1"));
check("no sentinel strings as cycle defaults", !/DEFAULT 'UNRESOLVED'/.test(sql));
check("no current-cycle fallback", !/current_timestamp/.test(sql.toLowerCase().replace(/pending_cycle_resolved_at = v_now/, "")));

if (failures.length) {
  console.error("[P0.3-C.1M3 static] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("[P0.3-C.1M3 static] OK", { migration: path.basename(migrationPath), checks: 24 });
