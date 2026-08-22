#!/usr/bin/env node
/**
 * P0.3-C.1B-R3 — gap recovery exec (single operational candidate max).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { recoverSalesMissingManualReviewPending } from "../src/billing/services/billingManualReviewPendingReconcilerService.js";

const RF_ACCOUNT = "359327e4-9902-4213-a1c3-1de702ef92ee";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execute = process.argv.includes("--execute");

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

const env = parseEnvFile(path.join(root, ".env.local"));
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const dry = await recoverSalesMissingManualReviewPending(sb, {
  marketplaceAccountId: RF_ACCOUNT,
  lookbackDays: 3,
  limit: 25,
  dryRun: true,
  snapshot_origin: "operational_sync",
});

const targets = (dry.details ?? []).filter((d) => d.dry_run === true);
if (targets.length === 0) {
  console.log(JSON.stringify({ ok: true, message: "no_manual_review_gap_candidates" }));
  process.exit(0);
}
if (targets.length > 2) {
  console.error(JSON.stringify({ ok: false, stop: "too_many_candidates", count: targets.length }));
  process.exit(3);
}

if (!execute) {
  console.log(JSON.stringify({ ok: true, mode: "dry_run", targets, would_materialize: targets.length }));
  process.exit(0);
}

const result = await recoverSalesMissingManualReviewPending(sb, {
  marketplaceAccountId: RF_ACCOUNT,
  lookbackDays: 3,
  limit: 25,
  dryRun: false,
  snapshot_origin: "operational_sync",
});

const out = {
  ok: result.materialized >= 1,
  materialized: result.materialized,
  details: result.details?.filter((d) => d.ok || d.admission_id),
};
const outPath = path.join(root, "scripts/output/P0_3C1B_R3_GAP_RECOVERY_EXEC.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
