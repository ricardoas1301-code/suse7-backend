#!/usr/bin/env node
/**
 * Backfill read-model pricing_current_state_projected_unit (Lista Precificações).
 *
 * Uso:
 *   node scripts/backfill_pricing_current_state.mjs --seller=<uuid> --limit=500 --concurrency=4
 *   node scripts/backfill_pricing_current_state.mjs --seller=<uuid> --only-missing=true
 *   node scripts/backfill_pricing_current_state.mjs --seller=<uuid> --listing-ids=MLB6086602390,MLB6784329822
 *   node scripts/backfill_pricing_current_state.mjs --seller=<uuid> --force-recalculate=true --limit=50
 */

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env") });
dotenv.config({ path: path.join(backendRoot, ".env.local"), override: true });

const { normalizePricingCurrentStateBackfillInput, runPricingCurrentStateBackfillBatch } =
  await import("../src/domain/pricing/pricingCurrentStateBackfillService.js");

/**
 * @param {string[]} argv
 * @param {string} key
 */
function readArg(argv, key) {
  const prefix = `--${key}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = argv.indexOf(`--${key}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return null;
}

const argv = process.argv.slice(2);
const sellerId =
  readArg(argv, "seller") ??
  readArg(argv, "seller-id") ??
  readArg(argv, "user-id") ??
  "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";

const input = normalizePricingCurrentStateBackfillInput({
  seller_id: sellerId,
  account_id: readArg(argv, "account-id"),
  listing_ids: readArg(argv, "listing-ids"),
  only_missing: readArg(argv, "only-missing"),
  force_recalculate: readArg(argv, "force-recalculate"),
  concurrency: readArg(argv, "concurrency"),
  limit: readArg(argv, "limit"),
});

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("[S7_PRICING_CURRENT_STATE_BACKFILL] missing SUPABASE env");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

try {
  const result = await runPricingCurrentStateBackfillBatch(sb, input);
  console.info("[S7_PRICING_CURRENT_STATE_BACKFILL] summary", result);
  process.exit(result.error_total > 0 ? 2 : 0);
} catch (err) {
  console.error("[S7_PRICING_CURRENT_STATE_BACKFILL] fatal", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}
