#!/usr/bin/env node
/**
 * P0.3-C.1B-R3 — gap recovery dry-run (RF account, operational only).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { recoverSalesMissingManualReviewPending } from "../src/billing/services/billingManualReviewPendingReconcilerService.js";

const RF_ACCOUNT = "359327e4-9902-4213-a1c3-1de702ef92ee";
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

const env = parseEnvFile(path.join(root, ".env.local"));
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const result = await recoverSalesMissingManualReviewPending(sb, {
  marketplaceAccountId: RF_ACCOUNT,
  lookbackDays: 3,
  limit: 25,
  dryRun: true,
  snapshot_origin: "operational_sync",
});

const safeDetails = (result.details ?? []).map((d) => ({
  external_order_id: d.external_order_id,
  date: d.date ?? null,
  classification: d.classification ?? d.class ?? null,
  reason: d.reason ?? null,
  skipped: d.skipped ?? false,
  dry_run: d.dry_run ?? false,
}));

const manualReviewCandidates = safeDetails.filter((d) => d.dry_run === true);
const out = {
  ok: true,
  generated_at: new Date().toISOString(),
  rf_account_id: RF_ACCOUNT,
  scanned: result.scanned,
  manual_review_candidates: manualReviewCandidates,
  skipped_count: safeDetails.filter((d) => d.skipped).length,
  materialized: result.materialized,
};

const outPath = path.join(root, "scripts/output/P0_3C1B_R3_GAP_RECOVERY_DRY_RUN.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

if (out.manual_review_candidates.length > 5) {
  console.error("[gap recovery] STOP — unexpected manual_review volume", out.manual_review_candidates.length);
  process.exit(3);
}
