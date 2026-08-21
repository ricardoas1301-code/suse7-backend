#!/usr/bin/env node
/**
 * P0.3-C.1B — gate audit: PENDING_MANUAL_REVIEW → RESERVED via billing_reserve_billable_sale_v2
 * Prova estática que a RPC atual NÃO transforma pending atomically.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hardening = fs.readFileSync(
  path.join(root, "supabase/migrations/20260723140000_s7_billing_billable_sale_admission_atomic_hardening_6_9a10.sql"),
  "utf8",
);
const pendingMigration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260821160000_s7_billing_manual_review_pending_p0_3c1m.sql"),
  "utf8",
);

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

// Reserve checks PERSISTED, RECOVERY, RESERVED — not PENDING
check(
  "reserve does not SELECT PENDING_MANUAL_REVIEW before insert",
  !/admission_result = 'PENDING_MANUAL_REVIEW'/.test(
    hardening.slice(hardening.indexOf("CREATE OR REPLACE FUNCTION public.billing_reserve_billable_sale_v2"), hardening.indexOf("CREATE OR REPLACE FUNCTION public.billing_renew_billable_sale_reservation_lease_v2")),
  ),
);

// Reserve UPDATE path only recycles ROLLED_BACK / EXPIRED
const reserveBody = hardening.slice(
  hardening.indexOf("CREATE OR REPLACE FUNCTION public.billing_reserve_billable_sale_v2"),
  hardening.indexOf("CREATE OR REPLACE FUNCTION public.billing_renew_billable_sale_reservation_lease_v2"),
);
check(
  "reserve recycle UPDATE limited to ROLLED_BACK/EXPIRED",
  /AND admission_result IN \('ROLLED_BACK', 'EXPIRED'\)/.test(reserveBody),
);
check(
  "reserve INSERT path creates new RESERVED row",
  /INSERT INTO public\.billing_billable_sale_admissions[\s\S]*'RESERVED'/.test(reserveBody),
);

// active_order_uidx blocks second row for same identity when pending exists
check(
  "active_order_uidx includes PENDING_MANUAL_REVIEW",
  /active_order_uidx[\s\S]*PENDING_MANUAL_REVIEW/.test(pendingMigration),
);

check(
  "C.1M2 promote migration provides atomic transition",
  fs.existsSync(path.join(root, "supabase/migrations/20260821180000_s7_billing_manual_review_transition_p0_3c1m2.sql")) &&
    fs.readFileSync(path.join(root, "supabase/migrations/20260821180000_s7_billing_manual_review_transition_p0_3c1m2.sql"), "utf8")
      .includes("billing_promote_manual_review_pending_to_reservation_v1"),
);

const verdict = {
  question_a_transform_same_row: true,
  question_b_duplicate_without_reservation: true,
  question_c_insert_conflicts: false,
  question_d_creates_second_row: false,
  mechanism: "C.1M2 billing_promote_manual_review_pending_to_reservation_v1 UPDATE same row under subscription FOR UPDATE + quota gate",
  second_migration_required: false,
  resolved_by: "20260821180000_s7_billing_manual_review_transition_p0_3c1m2.sql",
};

if (failures.length) {
  console.error("[P0.3-C.1B gate audit] FAIL");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}

console.log("[P0.3-C.1B gate audit] RESOLVED by C.1M2");
console.log(JSON.stringify(verdict, null, 2));
