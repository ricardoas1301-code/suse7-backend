#!/usr/bin/env node
/**
 * Probe genérico — paridade painel ML (S7_PROMOTION_DEBUG=1)
 * Uso: node suse7-backend/scripts/probe_panel_parity_listing.mjs MLB5742272490
 */
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, "..");
const require = createRequire(path.join(backendRoot, "package.json"));
const { createClient } = require("@supabase/supabase-js");

function parseDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = {
  ...parseDotEnv(path.join(backendRoot, ".env.vercel")),
  ...parseDotEnv(path.join(backendRoot, ".env.local")),
  ...process.env,
};
for (const [k, v] of Object.entries(env)) {
  if (v && !process.env[k]) process.env[k] = v;
}

process.env.S7_PROMOTION_DEBUG = "1";

import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import {
  fetchSellerPromotionsByItemDetailed,
  fetchSellerPromotionItemsForListing,
} from "../src/handlers/ml/_helpers/mercadoLibreItemsApi.js";
import {
  buildPromotionCardContract,
  enrichOfficialSellerPromotionRowsFromApi,
  resolvePromotionUiFinancials,
} from "../src/domain/pricing/mercadoLivreOfficialSellerPromotions.js";

const LISTING = process.argv[2];
if (!LISTING) {
  console.error("Uso: node probe_panel_parity_listing.mjs <listing_id>");
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: listing } = await sb
  .from("marketplace_listings")
  .select("user_id,marketplace_account_id")
  .eq("external_listing_id", LISTING)
  .maybeSingle();

if (!listing) {
  console.error("listing not found");
  process.exit(1);
}

const token = await getValidMLToken(String(listing.user_id), {
  marketplaceAccountId: listing.marketplace_account_id,
});
let { rows } = await fetchSellerPromotionsByItemDetailed(token, LISTING);
rows = await enrichOfficialSellerPromotionRowsFromApi(
  token,
  LISTING,
  rows,
  fetchSellerPromotionItemsForListing
);

console.log(`\n=== RAW PROMOTIONS ${LISTING} (${rows.length}) ===\n`);
for (const row of rows) {
  console.log(
    JSON.stringify(
      {
        id: row.id,
        name: row.name,
        type: row.type,
        sub_type: row.sub_type,
        status: row.status,
        original_price: row.original_price,
        price: row.price,
        suggested_discounted_price: row.suggested_discounted_price,
        max_discounted_price: row.max_discounted_price,
        min_discounted_price: row.min_discounted_price,
        top_deal_price: row.top_deal_price,
        seller_percentage: row.seller_percentage,
        meli_percentage: row.meli_percentage,
        _suse7_list_min_discounted_price: row._suse7_list_min_discounted_price,
        _suse7_price_enriched: row._suse7_price_enriched,
      },
      null,
      2
    )
  );
}

console.log(`\n=== PANEL PARITY DECISIONS ${LISTING} ===\n`);
for (const row of rows) {
  const ui = resolvePromotionUiFinancials(row, {
    sameListingSiblingRows: rows,
    sameListingOtherPromotionPrices: rows
      .filter((o) => o !== row)
      .map((o) => {
        const u = resolvePromotionUiFinancials(o, { skipLiquidaCaseAudit: true });
        return u.final_price_brl;
      })
      .filter(Boolean),
    listingId: LISTING,
  });
  const card = buildPromotionCardContract({
    listingExternalId: LISTING,
    promotionRow: row,
    sameListingPromotionRows: rows,
    liveFetchOk: true,
    promotionPayloadSource: "live",
    payloadLiveReceivedAt: new Date().toISOString(),
  });
  console.log(
    JSON.stringify(
      {
        promotion_id: row.id,
        promotion_name: row.name,
        type: row.type,
        sub_type: row.sub_type,
        selected_final: card.selected_final_price ?? card.real_promotion_final_price_brl,
        selected_disc: card.selected_discount_amount ?? card.discount_amount_brl,
        selected_pct: card.selected_discount_percent ?? card.discount_percent_display,
        selected_source: card.selected_source,
        selected_rule: card.selected_rule,
        payload_source: card.promotion_payload_source,
        payload_age_ms: card.promotion_payload_age_ms,
        source_trace: card.source_trace,
        candidates: card.promotion_price_candidates,
        panel_parity: ui.panel_parity,
      },
      null,
      2
    )
  );
  console.log("---");
}
