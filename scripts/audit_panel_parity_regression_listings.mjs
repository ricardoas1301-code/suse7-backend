#!/usr/bin/env node
/**
 * Auditoria consolidada — paridade painel ML (listings de regressão homologados).
 * Uso: node scripts/audit_panel_parity_regression_listings.mjs [MLB...]
 */
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyPromotionPriceFamily } from "../src/domain/pricing/mercadoLivrePromotionPriceResolverRegistry.js";

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

process.env.S7_PROMOTIONS_PI_AUDIT = "0";
process.env.S7_PROMOTION_DEBUG = "0";
process.env.S7_ML_PROMOS_AUDIT = "0";
process.env.NODE_ENV = "production";

import { getValidMLToken } from "../src/handlers/ml/_helpers/mlToken.js";
import {
  fetchItem,
  fetchSellerPromotionsByItemDetailed,
  fetchSellerPromotionItemsForListing,
} from "../src/handlers/ml/_helpers/mercadoLibreItemsApi.js";
import {
  buildListingVariationContextForPromotions,
  buildPromotionCardContract,
  enrichOfficialSellerPromotionRowsFromApi,
  extractOfficialPromotionFinancialRawFields,
  isStructuralAnonymousPriceDiscountRow,
  normalizeOfficialSellerPromotionsFromApi,
  resolvePromotionUiFinancials,
} from "../src/domain/pricing/mercadoLivreOfficialSellerPromotions.js";

const DEFAULT_LISTINGS = [
  "MLB5742272490",
  "MLB6086602390",
  "MLB4578041035",
  "MLB4684020397",
  "MLB6248404078",
  "MLB6784329822",
  "MLB3303235755",
  "MLB6086986228",
];

const LISTINGS = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_LISTINGS;

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/** @param {string} listingId */
async function auditListing(listingId) {
  const { data: listing } = await sb
    .from("marketplace_listings")
    .select("user_id,marketplace_account_id,raw_json,variations_count")
    .eq("external_listing_id", listingId)
    .maybeSingle();

  if (!listing) {
    return { listing_id: listingId, error: "listing_not_found", promotions: [] };
  }

  const token = await getValidMLToken(String(listing.user_id), {
    marketplaceAccountId: listing.marketplace_account_id,
  });

  let listingForContext = listing;
  try {
    const liveItem = await fetchItem(token, listingId);
    if (liveItem != null && typeof liveItem === "object") {
      listingForContext = {
        ...listing,
        raw_json: {
          ...(listing.raw_json != null && typeof listing.raw_json === "object" ? listing.raw_json : {}),
          ...liveItem,
        },
      };
    }
  } catch {
    /* mantém snapshot persistido */
  }

  const listingContext = buildListingVariationContextForPromotions(listingForContext);

  let { rows, ok, error } = await fetchSellerPromotionsByItemDetailed(token, listingId);
  if (!ok) {
    return { listing_id: listingId, error: error ?? "fetch_failed", promotions: [] };
  }

  rows = await enrichOfficialSellerPromotionRowsFromApi(
    token,
    listingId,
    rows,
    fetchSellerPromotionItemsForListing
  );

  const sameListingOtherPromotionPrices = [];
  const seenPrices = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (isStructuralAnonymousPriceDiscountRow(row)) continue;
    const pre = resolvePromotionUiFinancials(row, {
      skipLiquidaCaseAudit: true,
      listingId,
      listingContext,
    });
    if (pre.final_price_brl != null && !seenPrices.has(pre.final_price_brl)) {
      seenPrices.add(pre.final_price_brl);
      sameListingOtherPromotionPrices.push(pre.final_price_brl);
    }
  }

  const normalized = normalizeOfficialSellerPromotionsFromApi(rows, {
    listingId,
    source: "live",
    listingContext,
  });

  /** @type {Record<string, unknown>[]} */
  const promotions = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (isStructuralAnonymousPriceDiscountRow(row)) continue;

    const ui = resolvePromotionUiFinancials(row, {
      sameListingSiblingRows: rows,
      sameListingOtherPromotionPrices,
      listingId,
      listingContext,
      skipLiquidaCaseAudit: String(row.name ?? "").toLowerCase().includes("liquida"),
    });

    const card = buildPromotionCardContract({
      listingExternalId: listingId,
      promotionRow: row,
      sameListingPromotionRows: rows,
      listingContext,
      liveFetchOk: true,
      promotionPayloadSource: "live",
      payloadLiveReceivedAt: new Date().toISOString(),
    });

    const rawFinancial = extractOfficialPromotionFinancialRawFields(row);
    const panel = ui.panel_parity ?? {};
    const promoType = row.type ?? row.promotion_type ?? row.sub_type ?? null;
    const family = classifyPromotionPriceFamily(row);

    /** @type {{ candidate_path?: string; price?: string; reason?: string }[]} */
    const ignoredCandidates = Array.isArray(panel.promotion_price_candidates)
      ? panel.promotion_price_candidates
          .filter((c) => c && c.selected !== true)
          .map((c) => ({
            candidate_path: c.candidate_path ?? c.candidate_key ?? null,
            price: c.final_price ?? c.price ?? null,
            reason: "not_selected_by_panel_parity",
          }))
      : [];

    promotions.push({
      promotion_id: row.id ?? row.promotion_id ?? null,
      promotion_name: row.name ?? row.promotion_name ?? null,
      promotion_type: promoType,
      promotion_family: family,
      full_price_brl: ui.original_price_brl,
      selected_final_price_brl: ui.final_price_brl,
      official_discount_amount_brl: rawFinancial.discount_amount ?? rawFinancial.seller_discount_amount ?? null,
      computed_discount_amount_brl: panel.raw_discount_amount_from_ml ?? null,
      selected_discount_amount_brl: ui.discount_amount_brl,
      discount_percent_display: ui.discount_percent_display,
      discount_source: ui.discount_source,
      payout_brl: panel.payout_brl ?? rawFinancial.amount_to_receive ?? null,
      selected_rule: panel.selected_rule ?? card.selected_rule ?? null,
      selected_source: panel.selected_source_path ?? card.selected_source ?? null,
      source_trace: panel.source_trace ?? card.source_trace ?? [],
      candidates_count: panel.promotion_price_candidates?.length ?? 0,
      ignored_candidates: ignoredCandidates,
      variation_range_audit: ui.variation_range_audit ?? null,
      api_raw: {
        original_price: row.original_price ?? null,
        price: row.price ?? null,
        suggested_discounted_price: row.suggested_discounted_price ?? null,
        max_discounted_price: row.max_discounted_price ?? null,
        min_discounted_price: row.min_discounted_price ?? null,
        seller_percentage: row.seller_percentage ?? null,
        meli_percentage: row.meli_percentage ?? null,
        _suse7_list_min_discounted_price: row._suse7_list_min_discounted_price ?? null,
      },
    });
  }

  return {
    listing_id: listingId,
    api_rows_total: rows.length,
    api_named_count: rows.filter((r) => r && !isStructuralAnonymousPriceDiscountRow(r)).length,
    normalized_count: normalized.normalized_total,
    listing_variations_count: listingContext.variations_count,
    has_listing_variations: listingContext.has_listing_variations === true,
    promotions,
  };
}

/** @type {Record<string, unknown>[]} */
const report = [];
for (const listingId of LISTINGS) {
  try {
    report.push(await auditListing(listingId));
  } catch (err) {
    report.push({
      listing_id: listingId,
      error: String(err?.message ?? err),
      promotions: [],
    });
  }
}

console.log(JSON.stringify({ generated_at: new Date().toISOString(), listings: report }, null, 2));
