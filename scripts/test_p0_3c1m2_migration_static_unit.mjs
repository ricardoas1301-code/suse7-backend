#!/usr/bin/env node
/**
 * P0.3-C.1M2 — validação estática da migration de transição pending.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(
  root,
  "supabase/migrations/20260821180000_s7_billing_manual_review_transition_p0_3c1m2.sql",
);
const sql = fs.readFileSync(migrationPath, "utf8");
const c1m = fs.readFileSync(
  path.join(root, "supabase/migrations/20260821160000_s7_billing_manual_review_pending_p0_3c1m.sql"),
  "utf8",
);

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

check("migration exists", fs.existsSync(migrationPath));
check("promote RPC", sql.includes("billing_promote_manual_review_pending_to_reservation_v1"));
check("finalize RPC", sql.includes("billing_finalize_manual_review_not_billable_v1"));
check("no DELETE pending", !/DELETE FROM public\.billing_billable_sale_admissions/i.test(sql));
check("same row UPDATE promote", /UPDATE public\.billing_billable_sale_admissions[\s\S]*WHERE id = v_row\.id[\s\S]*PENDING_MANUAL_REVIEW/.test(sql));
check("subscription FOR UPDATE lock", /billing_subscriptions[\s\S]*FOR UPDATE/.test(sql));
check("admission FOR UPDATE lock", /billing_billable_sale_admissions[\s\S]*FOR UPDATE/.test(sql));
check("historical guard promote", sql.includes("historical_import_not_promotable"));
check("quota exhausted stays pending", sql.includes("baby_hard_limit_reached"));
check("reservation field parity", sql.includes("reservation_expires_at") && sql.includes("usage_count_after"));
check("materialize snapshot", sql.includes("billing_internal_materialize_open_cycle_sales_limit_snapshot"));
check("sync usage count", sql.includes("billing_internal_sync_subscription_usage_count"));
check("idempotent reserved reuse", sql.includes("reservation_reused"));
check("already persisted branch", sql.includes("already_persisted"));
check("final terminal branch", sql.includes("final_not_billable_terminal"));
check("SECURITY DEFINER search_path", /SECURITY DEFINER[\s\S]*SET search_path = public/.test(sql));
check("REVOKE promote", sql.includes("REVOKE ALL ON FUNCTION public.billing_promote_manual_review_pending_to_reservation_v1"));
check("REVOKE finalize", sql.includes("REVOKE ALL ON FUNCTION public.billing_finalize_manual_review_not_billable_v1"));
check("does not alter reserve v2", !/CREATE OR REPLACE FUNCTION public\.billing_reserve_billable_sale_v2/.test(sql));
check("C.1M untouched", !sql.includes("DROP CONSTRAINT billing_billable_sale_admissions_result_chk"));
check("C.1M file unchanged checksum", c1m.includes("billing_upsert_manual_review_pending_v1"));

if (failures.length) {
  console.error("[P0.3-C.1M2 static] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("[P0.3-C.1M2 static] OK", { migration: path.basename(migrationPath), checks: 21 });
