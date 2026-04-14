// ======================================================
// Frete por cenário — orquestração assíncrona (ML)
// 1) GET /items/:id/shipping_options (premium)
// 2–4) Cadeia síncrona: net_proceeds / GAP / health / auxiliar
// ======================================================

import Decimal from "decimal.js";
import {
  fetchMercadoLivreItemShippingOptions,
  parseMercadoLivreItemShippingOptionsForScenario,
} from "../../handlers/ml/_helpers/mercadoLivreItemShippingOptionsApi.js";
import {
  logPricingEvent,
  PRICING_LOG_LEVEL,
  PRICING_EVENT_CODE,
} from "./pricingInconsistencyLog.js";
import {
  inferMercadoLivreShippingContext,
  resolveMercadoLivreScenarioShipping,
} from "./mercadoLivreScenarioShipping.js";

const ROUND = Decimal.ROUND_HALF_UP;

/**
 * @typedef {{
 *   amount_brl: string | null;
 *   source: string;
 *   shipping_context: "buyer_pays" | "free_for_buyer" | null;
 *   shipping_subsidy_amount_brl: string | null;
 *   is_shipping_estimated: boolean;
 * }} MercadoLivreScenarioShippingResolution
 */

/**
 * @param {{
 *   accessToken: string | null | undefined;
 *   itemId: string | null | undefined;
 *   zipCode: string | null | undefined;
 *   scenarioSaleDec: Decimal;
 *   npRec: Record<string, unknown>;
 *   healthOriginal: Record<string, unknown> | null | undefined;
 *   listing: Record<string, unknown>;
 *   scenarioType: string;
 *   listingUuid?: string | null;
 * }} p
 * @returns {Promise<MercadoLivreScenarioShippingResolution>}
 */
export async function resolveMercadoLivreScenarioShippingAsync(p) {
  const {
    accessToken,
    itemId,
    zipCode,
    scenarioSaleDec,
    npRec,
    healthOriginal,
    listing,
    scenarioType,
    listingUuid,
  } = p;

  const priceStr =
    scenarioSaleDec != null && scenarioSaleDec.isFinite() && scenarioSaleDec.gt(0)
      ? scenarioSaleDec.toDecimalPlaces(2, ROUND).toFixed(2)
      : null;

  const id = itemId != null ? String(itemId).trim() : "";
  const zip = zipCode != null ? String(zipCode).trim() : "";

  if (accessToken && id && zip && priceStr) {
    const listingStatus =
      listing?.status != null && String(listing.status).trim() !== ""
        ? String(listing.status).trim()
        : null;
    const listingLogisticType =
      listing?.shipping &&
      typeof listing.shipping === "object" &&
      /** @type {Record<string, unknown>} */ (listing.shipping).logistic_type != null
        ? String(/** @type {Record<string, unknown>} */ (listing.shipping).logistic_type)
        : listing?.shipping_logistic_type != null
          ? String(listing.shipping_logistic_type)
          : null;
    const availableQtyRaw = listing?.available_quantity;
    const availableQty =
      availableQtyRaw != null && availableQtyRaw !== "" && Number.isFinite(Number(availableQtyRaw))
        ? Number(availableQtyRaw)
        : null;
    const marketplaceAccountId =
      listing?.marketplace_account_id != null && String(listing.marketplace_account_id).trim() !== ""
        ? String(listing.marketplace_account_id).trim()
        : null;
    const sellerId =
      listing?.seller_id != null && String(listing.seller_id).trim() !== ""
        ? String(listing.seller_id).trim()
        : null;
    const fetched = await fetchMercadoLivreItemShippingOptions(accessToken, id, {
      zipCode: zip,
      priceBrl: priceStr,
      scenario_type: scenarioType,
      diagnostics: {
        shipping_logistic_type: listingLogisticType,
        listing_status: listingStatus,
        available_quantity: availableQty,
        marketplace_account_id: marketplaceAccountId,
        seller_id: sellerId,
      },
    });
    if (fetched.ok && fetched.json) {
      const parsed = parseMercadoLivreItemShippingOptionsForScenario(fetched.json, listing);
      if (parsed?.seller_shipping_cost_brl != null) {
        logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_SCENARIO_SHIPPING_RESOLVED, {
          marketplace: "mercado_livre",
          item_id: id,
          listing_id: listingUuid ?? null,
          external_listing_id: id,
          scenario_type: scenarioType,
          sale_price_brl: priceStr,
          source: "ml_item_shipping_options_api",
          shipping_option_id: parsed.option_id ?? null,
          is_shipping_estimated: false,
        });
        return {
          amount_brl: parsed.seller_shipping_cost_brl,
          source: "ml_item_shipping_options_api",
          shipping_context: parsed.shipping_context,
          shipping_subsidy_amount_brl: parsed.shipping_subsidy_amount_brl,
          is_shipping_estimated: false,
        };
      }
    }
  }

  const sync = resolveMercadoLivreScenarioShipping({
    scenarioSaleDec,
    npRec,
    healthOriginal,
  });

  if (sync.source === "net_receivable_gap") {
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_SCENARIO_SHIPPING_FALLBACK_NET_PROCEEDS, {
      marketplace: "mercado_livre",
      item_id: id || null,
      listing_id: listingUuid ?? null,
      scenario_type: scenarioType,
      sale_price_brl: priceStr,
      source: sync.source,
    });
  } else if (
    sync.source === "ml_shipping_options_free_simulation" ||
    (typeof sync.source === "string" && sync.source.includes("simulation")) ||
    sync.source === "unresolved"
  ) {
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_SCENARIO_SHIPPING_ESTIMATED, {
      marketplace: "mercado_livre",
      item_id: id || null,
      listing_id: listingUuid ?? null,
      scenario_type: scenarioType,
      sale_price_brl: priceStr,
      source: sync.source,
    });
  }

  const ctxFallback = inferMercadoLivreShippingContext(npRec, healthOriginal);
  const isEstimated =
    sync.source === "unresolved" ||
    (typeof sync.source === "string" && sync.source.includes("simulation"));

  return {
    amount_brl: sync.amount_brl,
    source: sync.source,
    shipping_context: ctxFallback,
    shipping_subsidy_amount_brl: null,
    is_shipping_estimated: isEstimated,
  };
}
