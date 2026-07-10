#!/usr/bin/env node
/**
 * Benchmark leitura local_only — enrich pricing read-model (sem HTTP auth).
 */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env") });
dotenv.config({ path: path.join(backendRoot, ".env.local"), override: true });

const USER_ID = process.argv[2]?.trim() || "c8a62ec6-cfbe-4ad9-98ea-49fadebeda50";

const { fetchAllListingHealthRowsCompat } = await import("../src/handlers/ml/_helpers/mlHealthSchemaCompat.js");
const { buildListingGridRow } = await import("../src/handlers/ml/_helpers/listingGridAssembler.js");
const { enrichListingGridRowsPricingCurrentStateProjectedUnit } = await import(
  "../src/handlers/ml/_helpers/listingGridPricingCurrentStateEnrich.js"
);
const { getListingGridRow, putListingGridRowAliases } = await import(
  "../src/handlers/ml/_helpers/listingGridJoinKeys.js"
);

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const t0 = Date.now();
const { data: listings, error } = await sb
  .from("marketplace_listings")
  .select("*")
  .eq("user_id", USER_ID);
if (error) throw error;

const { data: healthRows } = await fetchAllListingHealthRowsCompat(sb, USER_ID);
/** @type {Map<string, Record<string, unknown>>} */
const healthByKey = new Map();
for (const h of healthRows ?? []) {
  putListingGridRowAliases(healthByKey, h.marketplace, h, (r) => r.external_listing_id);
}

const gridRows = (listings ?? []).map((listing) => buildListingGridRow(listing, healthByKey));
const fetchMs = Date.now() - t0;

const enrichT0 = Date.now();
await enrichListingGridRowsPricingCurrentStateProjectedUnit(sb, USER_ID, gridRows, listings ?? [], healthByKey, {
  localOnly: true,
});
const enrichMs = Date.now() - enrichT0;

const homolog = ["MLB6086602390", "MLB6784329822"].map((ext) => {
  const row = gridRows.find((r) => String(r.external_listing_id) === ext);
  const pcs = row?.pricing_current_state ?? null;
  return {
    external_listing_id: ext,
    current_effective_price_brl: pcs?.current_effective_price_brl ?? null,
    row_projected_profit_brl: pcs?.row_projected_profit_brl ?? null,
    row_projected_profit_percent: pcs?.row_projected_profit_percent ?? null,
    missing_data_flags: pcs?.missing_data_flags ?? null,
  };
});

console.info("[S7_BENCHMARK_LOCAL_ONLY]", {
  user_id: USER_ID,
  total_listings: gridRows.length,
  fetch_ms: fetchMs,
  enrich_ms: enrichMs,
  total_ms: Date.now() - t0,
  homolog,
});
