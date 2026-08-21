#!/usr/bin/env node
/**
 * P0.3-C.1B-R — handler HTTP + budget + cycle integrity unit tests (H1–H14).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ok, fail } from "../src/infra/http.js";
import {
  BILLING_RECONCILER_INVOCATION_BUDGET_MS,
  createReconcilerInvocationBudget,
  resolveBoundedBatchLimit,
} from "../src/billing/jobs/billingReconcilerInvocationBudget.js";
import {
  pendingCycleKeysAligned,
  resolvePendingMaterializationCycleKey,
} from "../src/billing/services/billingManualReviewPendingMetadataService.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const handlerSrc = fs.readFileSync(
  path.join(root, "src/handlers/jobs/billingBillableSaleAdmissionReconcilerJob.js"),
  "utf8",
);
const reconcilerSvcSrc = fs.readFileSync(
  path.join(root, "src/billing/services/billingManualReviewPendingReconcilerService.js"),
  "utf8",
);

const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

function mockRes() {
  /** @type {{ statusCode: number; body: unknown; headers: Record<string, string> }} */
  const state = { statusCode: 0, body: null, headers: {} };
  return {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return this;
    },
    setHeader(k, v) {
      state.headers[k] = v;
    },
    end(payload) {
      state.body = payload;
    },
    get state() {
      return state;
    },
  };
}

// H1/H2 handler contract (static + mock)
check("H1 handler uses canonical ok() signature", handlerSrc.includes('ok: true, job: "billing-billable-sale-admission-reconciler"'));
check("H2 handler uses canonical fail() object signature", handlerSrc.includes('code: "RECONCILER_FAILED"'));
check("H2 no inverted fail(res, 500, string)", !handlerSrc.match(/fail\(res,\s*500,\s*"/));

const resOk = mockRes();
ok(resOk, { ok: true, traceId: "t1" });
check("H1 mock ok status 200", resOk.state.statusCode === 200);
check("H1 mock ok body", resOk.state.body?.ok === true);

const resFail = mockRes();
fail(resFail, { code: "RECONCILER_FAILED", message: "boom" }, 500, "trace-x");
check("H2 mock fail status 500", resFail.state.statusCode === 500);
check("H2 mock fail structured", resFail.state.body?.code === "RECONCILER_FAILED");
check("H2 mock fail traceId", resFail.state.body?.traceId === "trace-x");

// H3–H5 budget
const budget = createReconcilerInvocationBudget({ budgetMs: 100, startedAtMs: Date.now() - 95 });
check("H3 budget near expiry shouldYield", budget.shouldYield(10) === true);
const bounded = resolveBoundedBatchLimit(budget, 50, 25);
check("H4 bounded batch shrinks under budget", bounded < 25);
check("H5 budget SSOT 45s", BILLING_RECONCILER_INVOCATION_BUDGET_MS === 45_000);

// H6–H9 cycle
check(
  "H6 remain_pending preserves row cycle_key on upsert",
  reconcilerSvcSrc.includes("cycle_key: String(pendingRow.cycle_key)") &&
    reconcilerSvcSrc.includes('outcome: "remain_pending"'),
);
check(
  "H7 promote guarded by cycle alignment",
  reconcilerSvcSrc.includes("pendingCycleKeysAligned") &&
    reconcilerSvcSrc.includes("cycle_identity_unresolved"),
);
check(
  "H8 indeterminate cycle skips materialization",
  fs
    .readFileSync(path.join(root, "src/billing/services/billingManualReviewPendingService.js"), "utf8")
    .includes("cycle_identity_indeterminate"),
);
const indeterminate = resolvePendingMaterializationCycleKey(
  { manual_review_required: true, reason: "quota_counting_started_at_missing" },
  {},
);
check("H9 no cycle when indeterminate", indeterminate === null);
check(
  "H9 aligned cycles",
  pendingCycleKeysAligned("2026-08-01", "2026-08-01") &&
    !pendingCycleKeysAligned("p0_3c1b-t20-x", "2026-08-01"),
);

// H3 stress — budget yields before timeout (pure budget math)
const tightBudget = createReconcilerInvocationBudget({ budgetMs: 5000, startedAtMs: Date.now() - 1000 });
const tightBatch = resolveBoundedBatchLimit(tightBudget, 800, 50);
check("H3 stress bounded batch partial", tightBatch > 0 && tightBatch < 50);
check("H3 stress shouldYield near limit", tightBudget.shouldYield(4000) === true);

// H4 job budget module (no full mock job — recovery chain complex)
check("H4 budget remaining positive after start", createReconcilerInvocationBudget().remainingMs() > 0);

// H11 static Class A path
check(
  "H10 Class A reconcile RPC path",
  fs.readFileSync(path.join(root, "src/billing/jobs/billingBillableSaleAdmissionReconcilerJob.js"), "utf8").includes(
    "reconcileExpiredBillableSaleReservations",
  ),
);

// H12–H14 static
check("H12 soft_yield in job", fs.readFileSync(path.join(root, "src/billing/jobs/billingBillableSaleAdmissionReconcilerJob.js"), "utf8").includes("soft_yield"));
check("H13 no migration in hardening files", !fs.existsSync(path.join(root, "supabase/migrations/20260821190000_p0_3c1b_r.sql")));
check("H14 handler local HTTP export", typeof (await import("../src/handlers/jobs/billingBillableSaleAdmissionReconcilerJob.js")).default === "function");

const summary = {
  ok: failures.length === 0,
  tests_run: 24,
  failures,
  generated_at: new Date().toISOString(),
};

const outPath = path.join(root, "scripts/output/P0_3C1B_R_HARDENING_TESTS.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(failures.length ? 1 : 0);
