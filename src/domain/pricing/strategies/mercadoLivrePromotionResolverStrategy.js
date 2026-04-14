// ======================================================
// Mercado Livre — normalização de subsídios promocionais (domínio).
// Separa incentivo ML vs desconto bancado pelo seller; resiliente a shape variável.
// ======================================================

import Decimal from "decimal.js";
import { pickPromotionIdFromSalePricePayload } from "../../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import {
  mercadoLivreListingPayloadForMoneyFields,
  mercadoLivreToFiniteGrid,
} from "../../../handlers/ml/_helpers/mercadoLivreListingMoneyShared.js";
import { coalesceMercadoLibreItemForMoneyExtract } from "../../../handlers/ml/_helpers/mlItemMoneyExtract.js";
import {
  logPricingEvent,
  PRICING_LOG_LEVEL,
  PRICING_EVENT_CODE,
} from "../pricingInconsistencyLog.js";

const ROUND = Decimal.ROUND_HALF_UP;

/** @param {unknown} v @returns {Decimal | null} */
function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null} d @returns {string | null} */
function decStr2(d) {
  if (d == null) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/**
 * Localiza linha em `prices[]` compatível com o promotion_id do cenário.
 * @param {Record<string, unknown>} listing
 * @param {string} promotionId
 * @returns {Record<string, unknown> | null}
 */
function findPriceRowForPromotion(listing, promotionId) {
  const merged = coalesceMercadoLibreItemForMoneyExtract(
    mercadoLivreListingPayloadForMoneyFields(listing, null)
  );
  const prices = merged.prices;
  if (!Array.isArray(prices)) return null;
  const want = String(promotionId).trim();
  for (const pr of prices) {
    if (!pr || typeof pr !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (pr);
    const pid = pickPromotionIdFromSalePricePayload(row);
    const cand =
      pid != null && String(pid).trim() !== ""
        ? String(pid).trim()
        : row.promotion_id != null
          ? String(row.promotion_id).trim()
          : row.id != null
            ? String(row.id).trim()
            : "";
    if (cand === want) return row;
  }
  return null;
}

/**
 * Extrai pares numéricos conhecidos de metadata / root (defensivo).
 * @param {Record<string, unknown>} row
 */
function extractSubsidyHintsFromRow(row) {
  const meta =
    row.metadata != null && typeof row.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (row.metadata)
      : /** @type {Record<string, unknown>} */ ({});

  const tryKeys = [
    "meli_funded_amount",
    "meli_discount_amount",
    "meli_subsidy_amount",
    "marketplace_subsidy_amount",
    "campaign_subsidy_amount",
    "seller_funded_amount",
    "seller_discount_amount",
    "seller_co_funded_amount",
  ];

  /** @type {Record<string, unknown>} */
  const bag = { ...meta, ...row };
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of tryKeys) {
    if (k in bag) out[k] = bag[k];
  }
  return out;
}

/**
 * @param {{
 *   listing: Record<string, unknown>;
 *   promotionId: string;
 *   promoPriceBrl: string;
 *   baselineCatalogBrl: string | null;
 * }} p
 * @returns {{
 *   promotion_subsidy_amount_brl: string | null;
 *   seller_discount_amount_brl: string | null;
 *   promotion_source: string;
 *   is_promotion_estimated: boolean;
 * }}
 */
export function resolveMercadoLivrePromotionFinancials(p) {
  const { listing, promotionId, promoPriceBrl, baselineCatalogBrl } = p;
  const row = findPriceRowForPromotion(listing, promotionId);

  const promoN = toDec(promoPriceBrl);
  const catN = baselineCatalogBrl != null ? toDec(baselineCatalogBrl) : null;

  if (!row) {
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_PROMOTION_SUBSIDY_FALLBACK, {
      marketplace: "mercado_livre",
      promotion_id: promotionId,
      reason: "price_row_not_found",
    });
    const sellerDisc =
      catN != null && promoN != null && catN.gt(promoN) ? decStr2(catN.minus(promoN)) : null;
    return {
      promotion_subsidy_amount_brl: null,
      seller_discount_amount_brl: sellerDisc,
      promotion_source: "catalog_minus_promo_fallback",
      is_promotion_estimated: true,
    };
  }

  const hints = extractSubsidyHintsFromRow(row);
  let meliSubsidy = toDec(hints.meli_funded_amount ?? hints.meli_discount_amount ?? hints.meli_subsidy_amount);
  let sellerFund = toDec(hints.seller_funded_amount ?? hints.seller_discount_amount ?? hints.seller_co_funded_amount);

  if (meliSubsidy == null && sellerFund == null && catN != null && promoN != null && catN.gt(promoN)) {
    sellerFund = catN.minus(promoN);
  }

  const resolved = meliSubsidy != null || sellerFund != null;
  if (resolved) {
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_PROMOTION_SUBSIDY_RESOLVED, {
      marketplace: "mercado_livre",
      promotion_id: promotionId,
      promotion_source: "item_prices_metadata",
      has_meli_subsidy: meliSubsidy != null,
      has_seller_funded: sellerFund != null,
    });
  } else {
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_PROMOTION_SUBSIDY_FALLBACK, {
      marketplace: "mercado_livre",
      promotion_id: promotionId,
      reason: "no_metadata_subsidy_fields",
    });
  }

  return {
    promotion_subsidy_amount_brl: meliSubsidy != null ? decStr2(meliSubsidy) : null,
    seller_discount_amount_brl: sellerFund != null ? decStr2(sellerFund) : catN != null && promoN != null && catN.gt(promoN) ? decStr2(catN.minus(promoN)) : null,
    promotion_source: resolved ? "item_prices_metadata" : "catalog_minus_promo_fallback",
    is_promotion_estimated: !resolved,
  };
}

/**
 * Preço de catálogo (valor original) para comparação com promo — usa mesma base do grid quando possível.
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 */
export function resolveMercadoLivreBaselineCatalogBrl(listing, health) {
  const dbList = mercadoLivreToFiniteGrid(health?.list_or_original_price_brl);
  const orig = mercadoLivreToFiniteGrid(listing.original_price);
  const base = mercadoLivreToFiniteGrid(listing.base_price);
  const n = dbList ?? orig ?? base;
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return new Decimal(n).toDecimalPlaces(2, ROUND).toFixed(2);
}
