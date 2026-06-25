// ======================================================

// Variáveis comerciais opcionais no detalhe da venda (leitura).

// Fonte canônica: marketplace_listing_health do anúncio relacionado.

// Extensão opcional do payload — não altera cálculo de lucro/margem.

// ======================================================



import { readPricingSimulationConfigFromRawJson } from "../../domain/pricing/listingPricingSimulationConfig.js";

import {

  buildCommercialAdjustmentLines,
  fetchListingHealthCommercialFlagsDetailed,

  isSaleCommercialDebugEnabled,

  moneyFromPercentOfGross,

  resolveSaleCommercialLookup,

} from "../../domain/sales/saleListingHealthCommercial.js";
import { buildRayxContingencyAdjustmentLines } from "../../domain/sales/saleDetailContingencyMargin.js";



/** @param {unknown} raw */

function toNum(raw) {

  if (raw == null || String(raw).trim() === "") return null;

  const n = Number(String(raw).replace(",", "."));

  return Number.isFinite(n) ? n : null;

}



/**

 * @param {unknown} source

 */

function asObject(source) {

  if (!source || typeof source !== "object") return null;

  return /** @type {Record<string, unknown>} */ (source);

}



const FLAG_TO_VAR = {

  planned_promo: { amount: "discount_promotion_amount", percent: "discount_promotion_percent" },

  ml_ads: { amount: "ml_ads_amount", percent: "ml_ads_percent" },

  affiliates: { amount: "affiliates_amount", percent: "affiliates_percent" },

  safety_reserve: { amount: "safety_reserve_amount", percent: "safety_reserve_percent" },

};



/**

 * @param {Record<string, unknown>} pricingVariables

 * @param {Record<string, unknown>} pricingFlags

 * @param {Record<string, unknown>} financial

 */

function applyFlagsToPricingVariables(pricingVariables, pricingFlags, financial) {

  const gross = financial.gross_amount ?? financial.sale_price;



  for (const [flagKey, spec] of Object.entries(FLAG_TO_VAR)) {

    const f = asObject(pricingFlags[flagKey]);

    if (!f || f.enabled !== true) continue;



    if (f.percent != null && pricingVariables[spec.percent] == null) {

      pricingVariables[spec.percent] = String(f.percent);

    }

    if (f.amount != null && pricingVariables[spec.amount] == null) {

      pricingVariables[spec.amount] = f.amount;

    }



    if (pricingVariables[spec.amount] == null && gross != null) {

      const pct = f.percent ?? pricingVariables[spec.percent];

      const amt = moneyFromPercentOfGross(gross, pct);

      if (amt != null) {

        pricingVariables[spec.amount] = amt;

      }

    }

  }

}



/**

 * @param {Record<string, unknown>} target

 * @param {Record<string, unknown>} legacy

 */

function mergePricingFlags(target, legacy) {

  for (const [key, val] of Object.entries(legacy)) {

    const existing = asObject(target[key]);

    const incoming = asObject(val);

    if (existing?.enabled === true) continue;

    if (target[key]) continue;

    target[key] = val;

  }

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @param {string | null} listingInternalId

 * @param {Record<string, unknown>} item

 * @param {Record<string, unknown> | null} order

 * @param {Record<string, unknown>} financial

 * @param {Record<string, unknown> | null | undefined} uiRow

 */

export async function attachSaleDetailPricingVariables(

  supabase,

  userId,

  listingInternalId,

  item,

  order,

  financial,

  uiRow = null,

) {

  try {

  /** @type {Record<string, unknown>} */

  const pricingVariables = {

    ...(financial.pricing_variables && typeof financial.pricing_variables === "object"

      ? /** @type {Record<string, unknown>} */ (financial.pricing_variables)

      : {}),

  };



  /** @type {Record<string, unknown>} */

  const pricingFlags = {};



  const listingId = listingInternalId != null ? String(listingInternalId).trim() : "";

  /** @type {Record<string, unknown> | null} */

  let listingRow = null;

  if (listingId) {

    const { data: listing } = await supabase

      .from("marketplace_listings")

      .select("raw_json, marketplace_account_id, seller_company_id, external_listing_id, marketplace")

      .eq("user_id", userId)

      .eq("id", listingId)

      .maybeSingle();

    listingRow = listing && typeof listing === "object" ? listing : null;

  }



  const lookupHints = {

    listingIdDisplay: uiRow?.listing_id_display ?? null,

    listingExternalId: listingRow?.external_listing_id ?? null,

    listingMarketplace: listingRow?.marketplace ?? null,

  };



  const lookup = resolveSaleCommercialLookup(item, order, lookupHints);

  let healthResult = { flags: {}, row: null, marketplaceUsed: null };
  try {
    healthResult = await fetchListingHealthCommercialFlagsDetailed(supabase, userId, lookup);
  } catch (healthError) {
    console.warn("[sales/detail] marketplace_listing_health_commercial_read_failed", {
      message: healthError instanceof Error ? healthError.message : String(healthError),
    });
  }

  mergePricingFlags(pricingFlags, healthResult.flags);



  if (listingRow) {

    const fromListing = readPricingSimulationConfigFromRawJson(listingRow.raw_json);

    mergePricingFlags(pricingFlags, fromListing);

  }



  const listingConfig = readPricingSimulationConfigFromRawJson(item.raw_json);

  mergePricingFlags(pricingFlags, listingConfig);



  applyFlagsToPricingVariables(pricingVariables, pricingFlags, financial);



  const gross = financial.gross_amount ?? financial.sale_price;

  const commercialLines = buildRayxContingencyAdjustmentLines(
    /** @type {import("../../domain/sales/saleListingHealthCommercial.js").PricingSimulationConfig} */ (
      pricingFlags
    ),
    pricingVariables,
    gross,
  );



  if (isSaleCommercialDebugEnabled()) {

    console.info("[sales/detail] commercial_adjustments_debug", {

      external_listing_id: lookup.externalListingId,

      marketplace: lookup.marketplace,

      marketplace_used: healthResult.marketplaceUsed,

      marketplace_account_id: lookup.accountId || null,

      seller_company_id: lookup.sellerCompanyId || null,

      listing_internal_id: listingId || null,

      health_row_found: Boolean(healthResult.row),

      health_row: healthResult.row,

      pricing_variables: pricingVariables,

      pricing_variable_flags: pricingFlags,

      commercial_adjustment_lines: commercialLines,

    });

  }



  const hasActiveFlag = Object.values(pricingFlags).some((f) => f && typeof f === "object" && f.enabled === true);

  const hasVars = Object.keys(pricingVariables).some((k) => {

    const v = pricingVariables[k];

    return v != null && String(v).trim() !== "" && toNum(v) !== 0;

  });



  if (!hasVars && !hasActiveFlag && commercialLines.length === 0) return financial;



  return {

    ...financial,

    pricing_variables: pricingVariables,

    pricing_variable_flags: pricingFlags,

    commercial_adjustment_lines: commercialLines,

  };

  } catch (error) {
    console.warn("[sales/detail] attach_sale_detail_pricing_variables_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return financial;
  }

}

