#!/usr/bin/env node
/** P0.3-C.1B-R — phase timings read-only diagnostic (DEV). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { reconcileExpiredBillableSaleReservations } from "../src/billing/services/billingBillableSaleAdmissionService.js";
import { reconcileManualReviewPendingBatch, recoverSalesMissingManualReviewPending } from "../src/billing/services/billingManualReviewPendingReconcilerService.js";
import { createReconcilerInvocationBudget, BILLING_RECONCILER_INVOCATION_BUDGET_MS } from "../src/billing/jobs/billingReconcilerInvocationBudget.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

const env = { ...parseEnvFile(path.join(root, ".env.local")) };
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const budget = createReconcilerInvocationBudget({ budgetMs: BILLING_RECONCILER_INVOCATION_BUDGET_MS });
const timings = {};

const t0 = Date.now();
timings.class_a_expired_ms = 0;
try {
  const a0 = Date.now();
  await reconcileExpiredBillableSaleReservations(sb, { batchLimit: 100 });
  timings.class_a_expired_ms = Date.now() - a0;
} catch (e) {
  timings.class_a_error = e instanceof Error ? e.message : String(e);
}

const b0 = Date.now();
const classB = await reconcileManualReviewPendingBatch(sb, { limit: 12, deadline: budget });
timings.class_b_pending_ms = Date.now() - b0;

const r0 = Date.now();
const recovery = await recoverSalesMissingManualReviewPending(sb, { limit: 25, deadline: budget });
timings.sale_pending_recovery_ms = Date.now() - r0;

timings.total_ms = Date.now() - t0;
timings.budget = budget.snapshot();

const out = {
  generated_at: new Date().toISOString(),
  phase_timings_ms: timings,
  class_b_summary: {
    selected: classB.selected_count,
    errors: classB.errors,
    remained: classB.remained_pending,
    promoted: classB.promoted,
  },
  recovery_summary: {
    scanned: recovery.scanned,
    materialized: recovery.materialized,
    skipped: recovery.skipped,
    errors: recovery.errors,
  },
};

const outPath = path.join(root, "scripts/output/P0_3C1B_R_PHASE_TIMINGS.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
