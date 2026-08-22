#!/usr/bin/env node
/**
 * P0.3-C.1B-R3 — backend v2 + unresolved pending unit tests.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
function check(name, cond) {
  if (!cond) failures.push(name);
}

const pendingSvc = fs.readFileSync(
  path.join(root, "src/billing/services/billingManualReviewPendingService.js"),
  "utf8",
);
const reconcilerSvc = fs.readFileSync(
  path.join(root, "src/billing/services/billingManualReviewPendingReconcilerService.js"),
  "utf8",
);

check("upsert uses v2 RPC", pendingSvc.includes("billing_upsert_manual_review_pending_v2"));
check("materialize no skip indeterminate", !pendingSvc.includes('reason: "cycle_identity_indeterminate"'));
check("resolve cycle RPC wrapper", pendingSvc.includes("billing_resolve_pending_cycle_v1"));
check("normalizePendingCycleKeyForUpsert", pendingSvc.includes("normalizePendingCycleKeyForUpsert"));
check("reconciler resolve cycle import", reconcilerSvc.includes("resolveManualReviewPendingCycle"));
check("reconciler cycle_unresolved promote guard", reconcilerSvc.includes('reason === "cycle_unresolved"'));
check("reconciler normalize cycle on remain", reconcilerSvc.includes("normalizePendingCycleKeyForUpsert(pendingRow.cycle_key)"));

import { resolvePendingMaterializationCycleKey } from "../src/billing/services/billingManualReviewPendingMetadataService.js";
import { normalizePendingCycleKeyForUpsert } from "../src/billing/services/billingManualReviewPendingService.js";
import { BILLING_SALE_PERIOD_CLASS } from "../src/billing/billingConstants.js";

const nullCycle = resolvePendingMaterializationCycleKey(
  { manual_review_required: true, reason: "quota_counting_started_at_missing" },
  {},
);
check("V1 metadata null cycle", nullCycle === null);
check("normalize null", normalizePendingCycleKeyForUpsert(null) === null);
check("normalize empty", normalizePendingCycleKeyForUpsert("  ") === null);
check("normalize known", normalizePendingCycleKeyForUpsert("2026-08-01") === "2026-08-01");

if (failures.length) {
  console.error("[P0.3-C.1B-R3 unit] FAIL", failures);
  process.exit(1);
}
console.log("[P0.3-C.1B-R3 unit] OK", { checks: 11 });
