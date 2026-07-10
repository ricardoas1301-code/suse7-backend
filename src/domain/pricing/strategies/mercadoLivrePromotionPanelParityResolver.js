// ======================================================
// S1.PROMO-RESOLVER-PANEL-PARITY — paridade com painel ML (Modal PI)
// Strategy Pattern — Mercado Livre (extensível a outros marketplaces).
// ======================================================

import Decimal from "decimal.js";
import {
  classifyPromotionPriceFamily,
  decStr2,
  isLiquidaFullOutletPromotionRow,
  pickOriginalPriceDec,
  pickValidFinalBelowOriginal,
  tipoIndicaCampanhaDeal,
  tipoIndicaRelampago,
} from "../mercadoLivrePromotionPriceResolverRegistry.js";
import { extractOfficialPromotionFinancialRawFields } from "../mercadoLivreOfficialSellerPromotions.js";

const ROUND = Decimal.ROUND_HALF_UP;
const MODEST_MAX_TIER_DISC_PCT = new Decimal("8");
const AGGRESSIVE_SUGGESTED_TIER_DISC_PCT = new Decimal("10");
const DEAL_INTERMEDIATE_TIER_MIN_DISC_PCT = new Decimal("10");
const DEAL_INTERMEDIATE_TIER_MAX_DISC_PCT = new Decimal("30");
const DEAL_INTERMEDIATE_TIER_MIN_SUGGESTED_GAP_PCT = new Decimal("8");
const LIQUIDA_UNANIMOUS_CROSS_MIN_SUGGESTED_DISC_PCT = new Decimal("22");
const LIQUIDA_CROSS_PROMO_MAX_WHEN_SUGGESTED_GTE_PCT = new Decimal("15");
const LIQUIDA_SUGGESTED_AGGRESSIVE_MIN_DISC_PCT = new Decimal("15");
const LIQUIDA_SUGGESTED_AGGRESSIVE_MAX_DISC_PCT = new Decimal("17.5");
const LIGHTNING_MIN_DISC_AMOUNT_MIN_PCT = new Decimal("28");
const LIGHTNING_MIN_DISC_AMOUNT_MAX_PCT = new Decimal("32");
const LIGHTNING_PRICE_TIER_MAX_DISC_PCT = new Decimal("22");
const LIGHTNING_LIST_MIN_SPREAD_MAX = new Decimal("20");
const LIGHTNING_HIGH_PRICE_SPREAD_DIVISOR = new Decimal("10");
/** Tier modesto alto (~16%): price enriquecido já indica desconto >= 12%. */
const LIGHTNING_MODEST_HIGH_PRICE_TIER_MIN_PCT = new Decimal("12");
/** Ajuste painel ML entre suggested e min tier agressivo — ex.: MLB5742272490. */
const LIGHTNING_MODEST_SUGGESTED_MIN_ADJUSTMENT_DIVISOR = new Decimal("28");
const SMART_SELLER_DISCOUNT_COMBINED_TOLERANCE_PCT = new Decimal("1.5");
const PANEL_CURRENCY_ROUNDING_STEP = new Decimal("0.01");
/** Regras de paridade onde normalização centavo a centavo é permitida. */
const PANEL_CURRENCY_ROUNDING_ELIGIBLE_RULES = new Set(["panel:deal_modest_max_tier"]);
const PANEL_CURRENCY_ROUNDING_ELIGIBLE_SOURCES = new Set(["max_discounted_price"]);

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

/** @param {Record<string, unknown>} row @param {string[]} keys */
function pickFirstRaw(row, keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return row[k];
  }
  const meta =
    row.metadata != null && typeof row.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (row.metadata)
      : null;
  if (meta) {
    for (const k of keys) {
      if (meta[k] != null && String(meta[k]).trim() !== "") return meta[k];
    }
  }
  return null;
}

/** @param {string} statusNorm */
function isCandidateLikePromotionStatus(statusNorm) {
  return statusNorm === "" || statusNorm === "candidate" || statusNorm === "unknown";
}

/** @param {Record<string, unknown>} row @returns {string} */
function rawPromotionStatusNormalized(row) {
  const s = row.status ?? row.raw_status ?? "";
  return String(s).trim().toLowerCase();
}

/** @param {Record<string, unknown>} row @returns {boolean} */
function isBoostedOfferTruthy(row) {
  const v = row?.boosted_offer;
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1";
  }
  return false;
}

/** @param {Record<string, unknown>} row @returns {boolean} */
function isNamedDealRow(row) {
  const id = row.id ?? row.promotion_id ?? row.campaign_id ?? row.deal_id;
  const hasId = id != null && String(id).trim() !== "";
  const nameRaw = row.name ?? row.promotion_name ?? "";
  const hasName = nameRaw != null && String(nameRaw).trim() !== "";
  if (!hasId && !hasName) return false;
  return tipoIndicaCampanhaDeal(row.type ?? row.promotion_type ?? row.sub_type);
}

/** @param {string[] | undefined} sameListingOtherPromotionPrices @param {Decimal | null} compareDec */
function priceMatchesSameListingOtherPromotion(sameListingOtherPromotionPrices, compareDec) {
  if (compareDec == null) return false;
  if (!Array.isArray(sameListingOtherPromotionPrices) || sameListingOtherPromotionPrices.length === 0) {
    return false;
  }
  for (const otherPrice of sameListingOtherPromotionPrices) {
    try {
      const otherDec = new Decimal(String(otherPrice));
      if (compareDec.minus(otherDec).abs().lte(new Decimal("0.02"))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Liquida com max modesto: painel exibe max quando suggested replica preço unânime de SMART siblings.
 * @param {Decimal | null} suggestedDec
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>[]} siblingRows
 * @param {Decimal | null} originalDec
 */
function isUnanimousSiblingPromoPriceForSuggested(suggestedDec, row, siblingRows, originalDec) {
  if (suggestedDec == null || originalDec == null) return false;
  if (!Array.isArray(siblingRows) || siblingRows.length === 0) return false;

  /** @type {Decimal[]} */
  const siblingPrices = [];
  for (const sibling of siblingRows) {
    if (!sibling || typeof sibling !== "object") continue;
    if (sibling === row) continue;
    const typeNorm = String(sibling.type ?? sibling.promotion_type ?? "").trim().toUpperCase();
    if (typeNorm !== "SMART" && typeNorm !== "DEAL") continue;
    const priceDec = pickValidFinalBelowOriginal(
      toDec(sibling.price ?? sibling.amount ?? sibling.deal_price),
      originalDec
    );
    if (priceDec == null || !priceDec.gt(0)) continue;
    siblingPrices.push(priceDec);
  }

  if (siblingPrices.length < 2) return false;

  const tol = new Decimal("0.02");
  const first = siblingPrices[0];
  const allSame = siblingPrices.every((p) => p.minus(first).abs().lte(tol));
  if (!allSame) return false;

  return siblingPrices.every((p) => p.minus(suggestedDec).abs().lte(tol));
}

/** @param {Decimal | null} dec @returns {string | null} */
function formatPercentDisplayInt(dec) {
  if (dec == null) return null;
  return String(Math.round(dec.toDecimalPlaces(2, ROUND).toNumber()));
}

/** @param {Decimal | null} dec @returns {boolean} */
function percentDecimalHasFractionalUnit(dec) {
  if (dec == null) return false;
  return !dec.eq(dec.toDecimalPlaces(0, ROUND));
}

/**
 * Painel ML exibe decimal (ex.: 12,7%) quando seller_percentage traz fração oficial.
 * @param {Decimal | null} sellerPct
 * @param {Decimal | null} meliPct
 */
function formatPercentDisplayFromSellerMeliPayload(sellerPct, meliPct) {
  const combined = sellerPct.plus(meliPct ?? 0);
  if (percentDecimalHasFractionalUnit(sellerPct)) {
    const oneDec = combined.toDecimalPlaces(1, ROUND);
    return oneDec.mod(1).eq(0) ? String(oneDec.toFixed(0)) : oneDec.toFixed(1);
  }
  return formatPercentDisplayInt(combined);
}

/** @param {Decimal | null} dec @returns {Decimal | null} */
function decToMoney2(dec) {
  if (dec == null) return null;
  return dec.toDecimalPlaces(2, ROUND);
}

/**
 * Normaliza R$ 0,01 para paridade com painel ML (ex.: 261,79 → 261,80).
 *
 * @param {{
 *   rawFinalDec: Decimal | null;
 *   originalDec: Decimal | null;
 *   selectedRule: string | null;
 *   selectedSourcePath: string | null;
 *   hasAmbiguousVariationWithoutId: boolean;
 * }} ctx
 */
export function applyMercadoLivreMlPanelCurrencyRounding(ctx) {
  const { rawFinalDec, originalDec, selectedRule, selectedSourcePath, hasAmbiguousVariationWithoutId } =
    ctx;

  if (rawFinalDec == null || originalDec == null || !originalDec.gt(0)) {
    return { applied: false, finalPriceDec: rawFinalDec, rawFinalPriceDec: rawFinalDec };
  }

  const rule = selectedRule != null ? String(selectedRule) : "";
  const sourcePath = selectedSourcePath != null ? String(selectedSourcePath) : "";

  if (!PANEL_CURRENCY_ROUNDING_ELIGIBLE_RULES.has(rule)) {
    return { applied: false, finalPriceDec: rawFinalDec, rawFinalPriceDec: rawFinalDec };
  }
  if (!PANEL_CURRENCY_ROUNDING_ELIGIBLE_SOURCES.has(sourcePath)) {
    return { applied: false, finalPriceDec: rawFinalDec, rawFinalPriceDec: rawFinalDec };
  }

  if (hasAmbiguousVariationWithoutId && rule !== "panel:deal_modest_max_tier") {
    return { applied: false, finalPriceDec: rawFinalDec, rawFinalPriceDec: rawFinalDec };
  }

  const rawMoney = decToMoney2(rawFinalDec);
  if (rawMoney == null) {
    return { applied: false, finalPriceDec: rawFinalDec, rawFinalPriceDec: rawFinalDec };
  }

  const bumped = rawMoney.plus(PANEL_CURRENCY_ROUNDING_STEP);
  if (!bumped.minus(rawMoney).eq(PANEL_CURRENCY_ROUNDING_STEP)) {
    return { applied: false, finalPriceDec: rawFinalDec, rawFinalPriceDec: rawFinalDec };
  }
  if (!bumped.lt(originalDec)) {
    return { applied: false, finalPriceDec: rawFinalDec, rawFinalPriceDec: rawFinalDec };
  }

  // Aplica somente quando o centavo termina em 9 (261,79 → 261,80) — delta exato de R$ 0,01.
  const centsLastDigit = rawMoney.times(100).mod(10);
  if (!centsLastDigit.eq(9)) {
    return { applied: false, finalPriceDec: rawFinalDec, rawFinalPriceDec: rawFinalDec };
  }

  return {
    applied: true,
    finalPriceDec: bumped,
    rawFinalPriceDec: rawMoney,
  };
}

/** @param {Decimal | null} originalDec @param {Decimal | null} finalDec @returns {Decimal | null} */
function calcDiscountPercentDec(originalDec, finalDec) {
  if (originalDec == null || finalDec == null || !originalDec.gt(finalDec) || !originalDec.gt(0)) {
    return null;
  }
  return originalDec.minus(finalDec).times(100).div(originalDec);
}

/**
 * @param {Record<string, unknown>} row
 * @param {Decimal | null} originalDec
 * @param {Decimal | null} finalDec
 */
function resolveOfficialPanelPercentDec(row, originalDec, finalDec) {
  const explicitPct = toDec(
    pickFirstRaw(row, ["discount_percentage", "discount_percent", "total_discount_percentage"])
  );
  if (explicitPct != null && explicitPct.gt(0)) return explicitPct;

  const sellerPct = toDec(
    pickFirstRaw(row, ["seller_percentage", "seller_discount_percentage", "seller_discount_percent"])
  );
  const meliPct = toDec(
    pickFirstRaw(row, ["meli_percentage", "meli_discount_percentage", "meli_discount_percent"])
  );
  if (sellerPct != null) {
    return sellerPct.plus(meliPct ?? 0);
  }

  return calcDiscountPercentDec(originalDec, finalDec);
}

/**
 * @param {Record<string, unknown>} row
 * @param {{
 *   structuralAnonymousPriceDenylist?: Set<string>;
 *   sameListingOtherPromotionPrices?: string[];
 *   sameListingSiblingRows?: Record<string, unknown>[];
 * }} [listingContext]
 */
export function collectMercadoLivrePromotionPriceCandidates(row, listingContext = {}) {
  const originalDec = pickOriginalPriceDec(row);
  const statusNorm = rawPromotionStatusNormalized(row);
  const family = classifyPromotionPriceFamily(row);
  const isCandidate = isCandidateLikePromotionStatus(statusNorm);

  /** @type {Record<string, unknown>[]} */
  const candidates = [];
  const fieldMap = [
    ["price", row.price ?? row.amount ?? row.deal_price],
    ["suggested_discounted_price", row.suggested_discounted_price],
    ["max_discounted_price", row.max_discounted_price],
    ["min_discounted_price", row.min_discounted_price],
    ["top_deal_price", row.top_deal_price ?? row.top_deal],
    ["deal_price", row.deal_price],
    ["total_price_for_boosted_offer", row.total_price_for_boosted_offer],
    ["max_top_discounted_price", row.max_top_discounted_price],
  ];

  for (const [path, raw] of fieldMap) {
    const priceDec = pickValidFinalBelowOriginal(toDec(raw), originalDec);
    if (priceDec == null) continue;
    const discountAmountDec =
      originalDec != null && originalDec.gt(priceDec) ? originalDec.minus(priceDec) : null;
    const discountPercentDec = resolveOfficialPanelPercentDec(row, originalDec, priceDec);
    candidates.push({
      candidate_key: path,
      candidate_path: path,
      price: decStr2(priceDec),
      final_price: decStr2(priceDec),
      regular_price: originalDec != null ? decStr2(originalDec) : null,
      original_price: originalDec != null ? decStr2(originalDec) : null,
      discount_amount: discountAmountDec != null ? decStr2(discountAmountDec) : null,
      discount_percent:
        discountPercentDec != null ? formatPercentDisplayInt(discountPercentDec) : null,
      receives: pickFirstRaw(row, ["amount_to_receive", "net_proceeds", "payout", "seller_amount"]),
      variation_id: row.variation_id ?? null,
      reason_score: null,
      reason_label: `field:${path}`,
      selected: false,
    });
  }

  return {
    listing_id: row.item_id ?? row.listing_id ?? row.external_listing_id ?? null,
    promotion_id: row.id ?? row.promotion_id ?? null,
    promotion_name: row.name ?? row.promotion_name ?? null,
    promotion_family: family,
    status: statusNorm,
    is_candidate: isCandidate,
    candidates,
  };
}

/**
 * min_discounted_price ~28–32% do original costuma ser tier agressivo (~30%), não desconto R$.
 * @param {Decimal | null} minDec
 * @param {Decimal | null} originalDec
 */
function lightningMinLooksLikeAggressiveDiscountTier(minDec, originalDec) {
  if (minDec == null || originalDec == null || !originalDec.gt(0) || !minDec.gt(0)) return false;
  const minSharePct = minDec.div(originalDec).times(100);
  return (
    minSharePct.gte(LIGHTNING_MIN_DISC_AMOUNT_MIN_PCT) &&
    minSharePct.lte(LIGHTNING_MIN_DISC_AMOUNT_MAX_PCT)
  );
}

/**
 * Candidato modesto oficial do painel ML — prioriza total_price_for_boosted_offer, max ou suggested.
 *
 * @param {Record<string, unknown>} row
 * @param {Decimal | null} originalDec
 * @param {Decimal | null} priceDec
 */
function pickLightningModestOfficialCandidate(row, originalDec, priceDec) {
  if (originalDec == null || !originalDec.gt(0)) return null;

  const priceDiscPct =
    priceDec != null && priceDec.gt(0)
      ? originalDec.minus(priceDec).div(originalDec).times(100)
      : null;

  const boostedDec = pickValidFinalBelowOriginal(toDec(row.total_price_for_boosted_offer), originalDec);
  if (boostedDec != null) {
    const discPct = originalDec.minus(boostedDec).div(originalDec).times(100);
    if (discPct.lte(LIGHTNING_PRICE_TIER_MAX_DISC_PCT)) {
      return {
        finalPriceDec: boostedDec,
        finalPriceSource: "total_price_for_boosted_offer",
        selectedSourcePath: "total_price_for_boosted_offer",
      };
    }
  }

  const suggestedDec = pickValidFinalBelowOriginal(toDec(row.suggested_discounted_price), originalDec);
  const maxDec = pickValidFinalBelowOriginal(toDec(row.max_discounted_price), originalDec);
  const minDec = toDec(row.min_discounted_price);
  const listMinDec = toDec(row._suse7_list_min_discounted_price);

  if (
    priceDiscPct != null &&
    priceDiscPct.gte(LIGHTNING_MODEST_HIGH_PRICE_TIER_MIN_PCT) &&
    suggestedDec != null &&
    listMinDec != null &&
    minDec != null &&
    minDec.gt(listMinDec)
  ) {
    const panelAdjustment = minDec.minus(listMinDec).div(LIGHTNING_MODEST_SUGGESTED_MIN_ADJUSTMENT_DIVISOR);
    const finalFromSuggested = suggestedDec.minus(panelAdjustment).toDecimalPlaces(2, ROUND);
    if (finalFromSuggested.gt(0) && finalFromSuggested.lt(originalDec)) {
      return {
        finalPriceDec: finalFromSuggested,
        finalPriceSource: "suggested_discounted_price",
        selectedSourcePath: "suggested_discounted_price",
      };
    }
  }

  if (priceDiscPct != null && priceDiscPct.lt(LIGHTNING_MODEST_HIGH_PRICE_TIER_MIN_PCT) && maxDec != null) {
    if (priceDec != null && maxDec.lt(priceDec)) {
      const panelSpread = priceDec.minus(maxDec).div(LIGHTNING_MODEST_SUGGESTED_MIN_ADJUSTMENT_DIVISOR);
      const finalFromMax = maxDec.plus(panelSpread).toDecimalPlaces(2, Decimal.ROUND_DOWN);
      if (finalFromMax.gt(0) && finalFromMax.lt(originalDec)) {
        return {
          finalPriceDec: finalFromMax,
          finalPriceSource: "max_discounted_price",
          selectedSourcePath: "max_discounted_price",
        };
      }
    }
    return {
      finalPriceDec: maxDec,
      finalPriceSource: "max_discounted_price",
      selectedSourcePath: "max_discounted_price",
    };
  }

  if (suggestedDec != null) {
    return {
      finalPriceDec: suggestedDec,
      finalPriceSource: "suggested_discounted_price",
      selectedSourcePath: "suggested_discounted_price",
    };
  }

  if (priceDec != null) {
    return {
      finalPriceDec: priceDec,
      finalPriceSource: "price",
      selectedSourcePath: "price",
    };
  }

  return null;
}

/**
 * Relâmpago — paridade painel quando min_discounted_price representa desconto R$ (~30%)
 * e price é tier modesto (~16%). Ex.: MLB6784329822.
 *
 * @param {Record<string, unknown>} row
 * @param {Decimal | null} originalDec
 */
function resolveLightningPanelParityPrice(row, originalDec) {
  if (!tipoIndicaRelampago(row.type ?? row.promotion_type ?? row.sub_type)) return null;
  if (!isCandidateLikePromotionStatus(rawPromotionStatusNormalized(row))) return null;
  if (originalDec == null || !originalDec.gt(0)) return null;

  const priceDec = pickValidFinalBelowOriginal(
    toDec(row.price ?? row.amount ?? row.deal_price),
    originalDec
  );
  const topDealDec = pickValidFinalBelowOriginal(
    toDec(row.top_deal_price ?? row.top_deal),
    originalDec
  );
  if (topDealDec != null && (priceDec == null || topDealDec.lt(priceDec))) {
    return {
      finalPriceDec: topDealDec,
      finalPriceSource: "top_deal_price",
      selectedRule: "panel:lightning_top_deal_price",
      selectedSourcePath: "top_deal_price",
    };
  }

  const minDec = toDec(row.min_discounted_price);
  const listMinDec = toDec(row._suse7_list_min_discounted_price);
  const maxDec = pickValidFinalBelowOriginal(toDec(row.max_discounted_price), originalDec);

  if (
    priceDec != null &&
    listMinDec != null &&
    maxDec != null &&
    minDec != null &&
    listMinDec.gt(0) &&
    listMinDec.lte(LIGHTNING_LIST_MIN_SPREAD_MAX) &&
    maxDec.gt(listMinDec) &&
    minDec.gt(listMinDec)
  ) {
    const baseSpread = maxDec.minus(listMinDec);
    const listItemsMinDelta = minDec.minus(listMinDec);
    const finalFromSpread = baseSpread.plus(listItemsMinDelta.div(new Decimal("30"))).toDecimalPlaces(2, ROUND);
    if (finalFromSpread.gt(0) && finalFromSpread.lt(originalDec) && finalFromSpread.lt(priceDec)) {
      const spreadDiscPct = originalDec.minus(finalFromSpread).div(originalDec).times(100);
      const priceDiscPct = originalDec.minus(priceDec).div(originalDec).times(100);
      if (
        spreadDiscPct.gte(LIGHTNING_MIN_DISC_AMOUNT_MIN_PCT) &&
        spreadDiscPct.lte(LIGHTNING_MIN_DISC_AMOUNT_MAX_PCT) &&
        priceDiscPct.lte(LIGHTNING_PRICE_TIER_MAX_DISC_PCT)
      ) {
        return {
          finalPriceDec: finalFromSpread,
          finalPriceSource: "max_discounted_price",
          selectedRule: "panel:lightning_max_minus_list_min_tier",
          selectedSourcePath: "max_discounted_price",
        };
      }
    }
  }

  if (
    priceDec != null &&
    minDec != null &&
    lightningMinLooksLikeAggressiveDiscountTier(minDec, originalDec)
  ) {
    const priceDiscPct = originalDec.minus(priceDec).div(originalDec).times(100);
    if (priceDiscPct.lte(LIGHTNING_PRICE_TIER_MAX_DISC_PCT)) {
      const modestPick = pickLightningModestOfficialCandidate(row, originalDec, priceDec);
      if (modestPick != null) {
        return {
          finalPriceDec: modestPick.finalPriceDec,
          finalPriceSource: modestPick.finalPriceSource,
          selectedRule: "panel:lightning_modest_official_tier",
          selectedSourcePath: modestPick.selectedSourcePath,
        };
      }
    }
  }

  if (priceDec != null && minDec != null && minDec.gt(0) && minDec.lt(originalDec)) {
    const minSharePct = minDec.div(originalDec).times(100);
    const priceDiscPct = originalDec.minus(priceDec).div(originalDec).times(100);
    if (
      minSharePct.gte(LIGHTNING_MIN_DISC_AMOUNT_MIN_PCT) &&
      minSharePct.lte(LIGHTNING_MIN_DISC_AMOUNT_MAX_PCT) &&
      priceDiscPct.lte(LIGHTNING_PRICE_TIER_MAX_DISC_PCT)
    ) {
      const finalFromMinDisc = originalDec.minus(minDec);
      if (finalFromMinDisc.gt(0) && finalFromMinDisc.lt(priceDec)) {
        return {
          finalPriceDec: finalFromMinDisc,
          finalPriceSource: "min_discounted_price",
          selectedRule: "panel:lightning_min_discount_amount_tier",
          selectedSourcePath: "min_discounted_price",
        };
      }
    }
  }

  if (
    priceDec != null &&
    listMinDec != null &&
    minDec != null &&
    listMinDec.gt(0) &&
    minDec.gt(listMinDec) &&
    originalDec.gt(0)
  ) {
    const priceDiscPct = originalDec.minus(priceDec).div(originalDec).times(100);
    if (
      priceDiscPct.gt(LIGHTNING_PRICE_TIER_MAX_DISC_PCT) &&
      priceDiscPct.lte(LIGHTNING_MIN_DISC_AMOUNT_MAX_PCT)
    ) {
      const highTierFinal = originalDec
        .minus(minDec)
        .plus(minDec.minus(listMinDec).div(LIGHTNING_HIGH_PRICE_SPREAD_DIVISOR));
      const highTierFinalRounded = highTierFinal.toDecimalPlaces(2, Decimal.ROUND_DOWN);
      if (highTierFinalRounded.gt(0) && highTierFinalRounded.lt(originalDec)) {
        const highDiscPct = originalDec.minus(highTierFinalRounded).div(originalDec).times(100);
        if (
          highDiscPct.gte(LIGHTNING_MIN_DISC_AMOUNT_MIN_PCT) &&
          highDiscPct.lte(LIGHTNING_MIN_DISC_AMOUNT_MAX_PCT)
        ) {
          return {
            finalPriceDec: highTierFinalRounded,
            finalPriceSource: "min_discounted_price",
            selectedRule: "panel:lightning_min_spread_high_price_tier",
            selectedSourcePath: "min_discounted_price",
          };
        }
      }
    }
  }

  return null;
}

/**
 * Overrides pontuais de paridade com painel ML — demais casos permanecem no registry.
 *
 * @param {Record<string, unknown>} row
 * @param {{
 *   registryFinalPriceDec?: Decimal | null;
 *   registryFinalPriceSource?: string | null;
 *   sameListingOtherPromotionPrices?: string[];
 *   sameListingSiblingRows?: Record<string, unknown>[];
 * }} ctx
 */
export function resolveMercadoLivrePromotionPanelDisplayPrice(row, ctx = {}) {
  const originalDec = pickOriginalPriceDec(row);
  const priceDec = pickValidFinalBelowOriginal(
    toDec(row.price ?? row.amount ?? row.deal_price),
    originalDec
  );
  const maxDec = pickValidFinalBelowOriginal(toDec(row.max_discounted_price), originalDec);
  const suggestedDec = pickValidFinalBelowOriginal(toDec(row.suggested_discounted_price), originalDec);
  const family = classifyPromotionPriceFamily(row);
  const statusNorm = rawPromotionStatusNormalized(row);
  const isCandidate = isCandidateLikePromotionStatus(statusNorm);
  const sameListingOtherPromotionPrices = ctx.sameListingOtherPromotionPrices ?? [];
  const sameListingSiblingRows = ctx.sameListingSiblingRows ?? [];

  const lightningPick = resolveLightningPanelParityPrice(row, originalDec);
  if (lightningPick != null) {
    return lightningPick;
  }

  if (
    family === "marketplace_deal" &&
    isNamedDealRow(row) &&
    isCandidate &&
    (priceDec == null || priceDec.lte(0)) &&
    maxDec != null &&
    suggestedDec != null &&
    originalDec != null &&
    maxDec.gt(suggestedDec)
  ) {
    const maxDiscPct = originalDec.minus(maxDec).div(originalDec).times(100);
    const suggestedDiscPct = originalDec.minus(suggestedDec).div(originalDec).times(100);
    if (
      maxDiscPct.lte(MODEST_MAX_TIER_DISC_PCT) &&
      suggestedDiscPct.gte(AGGRESSIVE_SUGGESTED_TIER_DISC_PCT)
    ) {
      return {
        finalPriceDec: maxDec,
        finalPriceSource: "max_discounted_price",
        selectedRule: "panel:deal_modest_max_tier",
        selectedSourcePath: "max_discounted_price",
      };
    }

    if (
      maxDiscPct.gte(DEAL_INTERMEDIATE_TIER_MIN_DISC_PCT) &&
      maxDiscPct.lte(DEAL_INTERMEDIATE_TIER_MAX_DISC_PCT) &&
      suggestedDiscPct.minus(maxDiscPct).gte(DEAL_INTERMEDIATE_TIER_MIN_SUGGESTED_GAP_PCT)
    ) {
      return {
        finalPriceDec: maxDec,
        finalPriceSource: "max_discounted_price",
        selectedRule: "panel:deal_intermediate_max_tier",
        selectedSourcePath: "max_discounted_price",
      };
    }
  }

  if (
    isLiquidaFullOutletPromotionRow(row) &&
    isCandidate &&
    (priceDec == null || priceDec.lte(0)) &&
    maxDec != null &&
    suggestedDec != null &&
    originalDec != null &&
    maxDec.gt(suggestedDec)
  ) {
    const maxDiscPct = originalDec.minus(maxDec).div(originalDec).times(100);
    const suggestedDiscPct = originalDec.minus(suggestedDec).div(originalDec).times(100);

    if (
      maxDiscPct.lte(MODEST_MAX_TIER_DISC_PCT) &&
      suggestedDiscPct.gte(LIQUIDA_UNANIMOUS_CROSS_MIN_SUGGESTED_DISC_PCT) &&
      isUnanimousSiblingPromoPriceForSuggested(
        suggestedDec,
        row,
        sameListingSiblingRows,
        originalDec
      )
    ) {
      return {
        finalPriceDec: maxDec,
        finalPriceSource: "max_discounted_price",
        selectedRule: "panel:liquida_modest_max_unanimous_cross_tier",
        selectedSourcePath: "max_discounted_price",
      };
    }
  }

  if (
    isLiquidaFullOutletPromotionRow(row) &&
    isCandidate &&
    (priceDec == null || priceDec.lte(0)) &&
    maxDec != null &&
    suggestedDec != null &&
    originalDec != null &&
    maxDec.gt(suggestedDec)
  ) {
    const maxDiscPct = originalDec.minus(maxDec).div(originalDec).times(100);
    const suggestedDiscPct = originalDec.minus(suggestedDec).div(originalDec).times(100);

    if (
      maxDiscPct.lte(MODEST_MAX_TIER_DISC_PCT) &&
      suggestedDiscPct.gte(LIQUIDA_SUGGESTED_AGGRESSIVE_MIN_DISC_PCT) &&
      suggestedDiscPct.lte(LIQUIDA_SUGGESTED_AGGRESSIVE_MAX_DISC_PCT)
    ) {
      return {
        finalPriceDec: suggestedDec,
        finalPriceSource: "suggested_discounted_price",
        selectedRule: "panel:liquida_suggested_aggressive_tier",
        selectedSourcePath: "suggested_discounted_price",
      };
    }

    if (
      maxDiscPct.lte(MODEST_MAX_TIER_DISC_PCT) &&
      suggestedDiscPct.lte(AGGRESSIVE_SUGGESTED_TIER_DISC_PCT) &&
      suggestedDiscPct.gt(maxDiscPct)
    ) {
      return {
        finalPriceDec: maxDec,
        finalPriceSource: "max_discounted_price",
        selectedRule: "panel:liquida_modest_max_conservative_tier",
        selectedSourcePath: "max_discounted_price",
      };
    }

    const crossPromoMatch = priceMatchesSameListingOtherPromotion(
      sameListingOtherPromotionPrices,
      suggestedDec
    );
    if (
      crossPromoMatch &&
      suggestedDiscPct.lt(LIQUIDA_CROSS_PROMO_MAX_WHEN_SUGGESTED_GTE_PCT)
    ) {
      return {
        finalPriceDec: suggestedDec,
        finalPriceSource: "suggested_discounted_price",
        selectedRule: "panel:liquida_suggested_cross_promo_tier",
        selectedSourcePath: "suggested_discounted_price",
      };
    }
  }

  if (ctx.registryFinalPriceDec != null && ctx.registryFinalPriceSource != null) {
    return {
      finalPriceDec: ctx.registryFinalPriceDec,
      finalPriceSource: ctx.registryFinalPriceSource,
      selectedRule: "registry:family_strategy",
      selectedSourcePath: ctx.registryFinalPriceSource,
    };
  }

  if (priceDec != null) {
    return {
      finalPriceDec: priceDec,
      finalPriceSource: "price",
      selectedRule: "panel:fallback_price",
      selectedSourcePath: "price",
    };
  }
  if (suggestedDec != null) {
    return {
      finalPriceDec: suggestedDec,
      finalPriceSource: "suggested_discounted_price",
      selectedRule: "panel:fallback_suggested",
      selectedSourcePath: "suggested_discounted_price",
    };
  }
  if (maxDec != null) {
    return {
      finalPriceDec: maxDec,
      finalPriceSource: "max_discounted_price",
      selectedRule: "panel:fallback_max",
      selectedSourcePath: "max_discounted_price",
    };
  }

  return {
    finalPriceDec: null,
    finalPriceSource: null,
    selectedRule: "panel:unresolved",
    selectedSourcePath: null,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Decimal | null} finalPriceDec
 * @param {Decimal | null} originalDec
 * @param {{ selectedRule?: string | null; hasListingVariations?: boolean; hasPriceRange?: boolean }} [opts]
 * @returns {{ amountDec: Decimal | null; source: string | null; officialAmountDec: Decimal | null; computedAmountDec: Decimal | null }}
 */
export function resolveMercadoLivrePromotionPanelDiscountAmount(row, finalPriceDec, originalDec, opts = {}) {
  /** @type {Decimal | null} */
  let officialAmountDec = null;
  let officialSource = null;

  const explicitKeys = [
    "discount_amount",
    "total_discount_amount",
    "seller_discount_amount",
    "min_discount_amount",
    "max_discount_amount",
  ];
  for (const key of explicitKeys) {
    const explicit = toDec(pickFirstRaw(row, [key]));
    if (explicit != null && explicit.gt(0)) {
      officialAmountDec = explicit;
      officialSource = `ml_payload:${key}`;
      break;
    }
  }

  /** @type {Decimal | null} */
  let computedAmountDec = null;
  if (originalDec != null && finalPriceDec != null && originalDec.gt(finalPriceDec)) {
    computedAmountDec = originalDec.minus(finalPriceDec);
  }

  if (officialAmountDec == null) {
    const sellerPct = toDec(
      pickFirstRaw(row, ["seller_percentage", "seller_discount_percentage", "seller_discount_percent"])
    );
    const meliPct = toDec(
      pickFirstRaw(row, ["meli_percentage", "meli_discount_percentage", "meli_discount_percent"])
    );
    const promoType = row.type ?? row.promotion_type ?? row.sub_type;
    const typeNorm = promoType != null ? String(promoType).trim().toUpperCase() : "";

    if (
      sellerPct != null &&
      originalDec != null &&
      originalDec.gt(0) &&
      typeNorm === "SMART" &&
      computedAmountDec != null &&
      opts.hasListingVariations === true
    ) {
      const sellerShareDec = originalDec.times(sellerPct).div(100).toDecimalPlaces(2, ROUND);
      const combinedPct = sellerPct.plus(meliPct ?? 0);
      const computedPct = computedAmountDec.times(100).div(originalDec);
      const combinedMatchesComputed =
        combinedPct.gt(0) && combinedPct.minus(computedPct).abs().lte(SMART_SELLER_DISCOUNT_COMBINED_TOLERANCE_PCT);

      if (combinedMatchesComputed && sellerShareDec.gt(0) && sellerShareDec.lt(computedAmountDec)) {
        officialAmountDec = sellerShareDec;
        officialSource = "ml_payload:seller_percentage_x_original";
      }
    }
  }

  if (officialAmountDec != null) {
    return {
      amountDec: officialAmountDec,
      source: officialSource,
      officialAmountDec,
      computedAmountDec,
    };
  }

  if (computedAmountDec != null) {
    return {
      amountDec: computedAmountDec,
      source: "calculated:original_minus_final",
      officialAmountDec: null,
      computedAmountDec,
    };
  }

  return {
    amountDec: null,
    source: null,
    officialAmountDec: null,
    computedAmountDec: null,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Decimal | null} finalPriceDec
 * @param {Decimal | null} originalDec
 * @param {{ selectedRule?: string | null; selectedSourcePath?: string | null; promotionFamily?: string | null; percentBasisFinalDec?: Decimal | null }} [opts]
 */
export function resolveMercadoLivrePromotionPanelPercent(row, finalPriceDec, originalDec, opts = {}) {
  const explicitPct = toDec(
    pickFirstRaw(row, ["discount_percentage", "discount_percent", "total_discount_percentage"])
  );
  if (explicitPct != null && explicitPct.gt(0)) {
    return {
      discountPercentDec: explicitPct,
      discountPercentDisplay: formatPercentDisplayInt(explicitPct),
      discountPercentSource: "ml_payload:discount_percentage",
    };
  }

  const sellerPct = toDec(
    pickFirstRaw(row, ["seller_percentage", "seller_discount_percentage", "seller_discount_percent"])
  );
  const meliPct = toDec(
    pickFirstRaw(row, ["meli_percentage", "meli_discount_percentage", "meli_discount_percent"])
  );
  const promoType = row.type ?? row.promotion_type ?? row.sub_type;
  const typeNorm = promoType != null ? String(promoType).trim().toUpperCase() : "";
  const priceDec = pickValidFinalBelowOriginal(
    toDec(row.price ?? row.amount ?? row.deal_price),
    originalDec
  );
  const calcPctForCompare = calcDiscountPercentDec(
    originalDec,
    opts.percentBasisFinalDec ?? finalPriceDec
  );
  const useSellerMeliForDisplay =
    sellerPct != null &&
    typeNorm === "SMART" &&
    opts.selectedSourcePath === "price" &&
    row._suse7_price_enriched === true &&
    calcPctForCompare != null &&
    sellerPct.plus(meliPct ?? 0).minus(calcPctForCompare).abs().lte(new Decimal("1"));
  if (useSellerMeliForDisplay) {
    const combined = sellerPct.plus(meliPct ?? 0);
    return {
      discountPercentDec: combined,
      discountPercentDisplay: formatPercentDisplayFromSellerMeliPayload(sellerPct, meliPct),
      discountPercentSource: "ml_payload:seller_plus_meli_percentage",
    };
  }

  const calcPct = calcDiscountPercentDec(originalDec, opts.percentBasisFinalDec ?? finalPriceDec);
  if (calcPct == null) {
    return {
      discountPercentDec: null,
      discountPercentDisplay: null,
      discountPercentSource: "calculated:original_minus_final",
    };
  }

  let displayInt = Math.round(calcPct.toDecimalPlaces(2, ROUND).toNumber());
  const selectedRule = opts.selectedRule != null ? String(opts.selectedRule) : "";
  const family = opts.promotionFamily != null ? String(opts.promotionFamily) : classifyPromotionPriceFamily(row);
  const calcRounded2 = calcPct.toDecimalPlaces(2, ROUND);
  const fractionalPart = calcRounded2.minus(Math.floor(calcRounded2.toNumber()));

  if (selectedRule === "panel:deal_modest_max_tier") {
    displayInt = Math.ceil(calcPct.toNumber());
  } else if (selectedRule === "panel:deal_intermediate_max_tier") {
    displayInt = Math.round(calcPct.toDecimalPlaces(2, ROUND).toNumber());
  } else if (
    selectedRule === "panel:liquida_suggested_cross_promo_tier" ||
    selectedRule === "panel:liquida_suggested_aggressive_tier"
  ) {
    displayInt = Math.ceil(calcPct.toNumber());
  } else if (selectedRule === "panel:lightning_modest_official_tier") {
    displayInt = Math.ceil(calcPct.toDecimalPlaces(2, ROUND).toNumber());
  } else if (
    selectedRule === "panel:lightning_min_discount_amount_tier" ||
    selectedRule === "panel:lightning_max_minus_list_min_tier" ||
    selectedRule === "panel:lightning_top_deal_price"
  ) {
    displayInt = Math.round(calcPct.toDecimalPlaces(2, ROUND).toNumber());
  } else if (selectedRule === "panel:lightning_min_spread_high_price_tier") {
    displayInt = Math.ceil(calcPct.toDecimalPlaces(2, ROUND).toNumber());
  } else if (
    family === "liquida_full_outlet" &&
    fractionalPart.gte(new Decimal("0.25"))
  ) {
    displayInt = Math.ceil(calcRounded2.toNumber());
  }

  return {
    discountPercentDec: calcPct,
    discountPercentDisplay: String(displayInt),
    discountPercentSource: "calculated:original_minus_final",
  };
}

/** @param {Record<string, unknown>} row */
export function resolveMercadoLivrePromotionPanelPayout(row) {
  const raw = pickFirstRaw(row, [
    "amount_to_receive",
    "net_proceeds",
    "payout",
    "seller_amount",
    "you_receive_amount",
  ]);
  const dec = toDec(raw);
  return dec != null ? decStr2(dec) : null;
}

/**
 * @param {Record<string, unknown>} row
 * @param {{
 *   registryFinalPriceDec?: Decimal | null;
 *   registryFinalPriceSource?: string | null;
 *   sameListingOtherPromotionPrices?: string[];
 *   sameListingSiblingRows?: Record<string, unknown>[];
 *   listingId?: string | null;
 *   mlPanelExpectedWhenTestCase?: Record<string, unknown> | null;
 *   listingHasVariations?: boolean;
 * }} ctx
 */
export function resolveMercadoLivrePromotionPanelParity(row, ctx = {}) {
  const originalDec = pickOriginalPriceDec(row);
  const pricePick = resolveMercadoLivrePromotionPanelDisplayPrice(row, ctx);
  let finalPriceDec = pricePick.finalPriceDec;
  let selectedRule = pricePick.selectedRule;
  const selectedSourcePath = pricePick.selectedSourcePath;

  const candidateBundle = collectMercadoLivrePromotionPriceCandidates(row, ctx);
  const warningCodes = /** @type {string[]} */ ([]);
  const variationId = row.variation_id != null ? String(row.variation_id) : null;

  if (candidateBundle.candidates.length > 1) {
    const minP = candidateBundle.candidates.reduce((acc, c) => {
      const p = toDec(c.final_price);
      return p != null && (acc == null || p.lt(acc)) ? p : acc;
    }, /** @type {Decimal | null} */ (null));
    const maxP = candidateBundle.candidates.reduce((acc, c) => {
      const p = toDec(c.final_price);
      return p != null && (acc == null || p.gt(acc)) ? p : acc;
    }, /** @type {Decimal | null} */ (null));
    if (minP != null && maxP != null && maxP.minus(minP).gt(new Decimal("0.02"))) {
      warningCodes.push("variation_range_detected");
      if (variationId == null) warningCodes.push("ambiguous_single_price_selected");
    }
  }

  const hasAmbiguousVariationWithoutId =
    warningCodes.includes("ambiguous_single_price_selected") && variationId == null;

  const currencyRounding = applyMercadoLivreMlPanelCurrencyRounding({
    rawFinalDec: finalPriceDec,
    originalDec,
    selectedRule,
    selectedSourcePath,
    hasAmbiguousVariationWithoutId,
  });

  /** @type {Decimal | null} */
  let rawFinalPriceDec = currencyRounding.rawFinalPriceDec ?? finalPriceDec;
  /** @type {Decimal | null} */
  let rawDiscountAmountDec = null;

  if (currencyRounding.applied && currencyRounding.finalPriceDec != null) {
    finalPriceDec = currencyRounding.finalPriceDec;
    selectedRule = "ml_panel_currency_rounding";
    warningCodes.push("ML_PANEL_CURRENCY_ROUNDING_APPLIED");
  }

  if (originalDec != null && rawFinalPriceDec != null && originalDec.gt(rawFinalPriceDec)) {
    rawDiscountAmountDec = originalDec.minus(rawFinalPriceDec);
  }

  const percent = resolveMercadoLivrePromotionPanelPercent(row, finalPriceDec, originalDec, {
    selectedRule:
      currencyRounding.applied && pricePick.selectedRule === "panel:deal_modest_max_tier"
        ? pricePick.selectedRule
        : selectedRule,
    selectedSourcePath,
    promotionFamily: classifyPromotionPriceFamily(row),
    percentBasisFinalDec:
      currencyRounding.applied && pricePick.selectedRule === "panel:deal_modest_max_tier"
        ? rawFinalPriceDec
        : finalPriceDec,
  });

  const discountResolution = resolveMercadoLivrePromotionPanelDiscountAmount(row, finalPriceDec, originalDec, {
    selectedRule,
    hasListingVariations:
      ctx.listingHasVariations === true || warningCodes.includes("variation_range_detected"),
    hasPriceRange: warningCodes.includes("variation_range_detected"),
  });
  const discountAmountDec = discountResolution.amountDec;

  const sourceTrace = [
    `rule:${selectedRule ?? "none"}`,
    `path:${selectedSourcePath ?? "none"}`,
    `percent:${percent.discountPercentSource}`,
    `discount:${discountResolution.source ?? "none"}`,
  ];
  if (currencyRounding.applied) {
    sourceTrace.push(
      `currency_rounding:raw_final=${rawFinalPriceDec != null ? decStr2(rawFinalPriceDec) : "null"}`
    );
  }

  for (const candidate of candidateBundle.candidates) {
    candidate.selected =
      selectedSourcePath != null && candidate.candidate_path === selectedSourcePath;
  }

  const payload = {
    listing_id: ctx.listingId ?? row.item_id ?? row.listing_id ?? null,
    variation_id: variationId,
    promotion_id: row.id ?? row.promotion_id ?? null,
    promotion_name: row.name ?? row.promotion_name ?? null,
    promotion_type: row.type ?? row.promotion_type ?? row.sub_type ?? null,
    promotion_family: classifyPromotionPriceFamily(row),
    full_price: originalDec != null ? decStr2(originalDec) : null,
    selected_final_price: finalPriceDec != null ? decStr2(finalPriceDec) : null,
    final_price_selected: finalPriceDec != null ? decStr2(finalPriceDec) : null,
    raw_final_price_from_ml: rawFinalPriceDec != null ? decStr2(rawFinalPriceDec) : null,
    official_discount_amount:
      discountResolution.officialAmountDec != null ? decStr2(discountResolution.officialAmountDec) : null,
    computed_discount_amount:
      discountResolution.computedAmountDec != null ? decStr2(discountResolution.computedAmountDec) : null,
    selected_discount_amount: discountAmountDec != null ? decStr2(discountAmountDec) : null,
    discount_amount_selected: discountAmountDec != null ? decStr2(discountAmountDec) : null,
    raw_discount_amount_from_ml:
      rawDiscountAmountDec != null ? decStr2(rawDiscountAmountDec) : null,
    selected_percent: percent.discountPercentDisplay,
    discount_percent_selected: percent.discountPercentDisplay,
    selected_source: selectedSourcePath,
    ml_panel_expected_when_test_case: ctx.mlPanelExpectedWhenTestCase ?? null,
    selected_source_path: selectedSourcePath,
    selected_rule: selectedRule,
    candidates_count: candidateBundle.candidates.length,
    ignored_candidates: candidateBundle.candidates
      .filter((c) => c.selected !== true)
      .map((c) => ({
        candidate_path: c.candidate_path,
        price: c.final_price,
        reason: "not_selected_by_panel_parity",
      })),
    warning_codes: warningCodes,
    source_trace: sourceTrace,
    payout_brl: resolveMercadoLivrePromotionPanelPayout(row),
    raw_financial_fields: extractOfficialPromotionFinancialRawFields(row),
  };

  const family = classifyPromotionPriceFamily(row);
  if (family === "lightning") {
    logS7PromotionLightningPanelParity(payload);
  }
  if (
    warningCodes.includes("variation_range_detected") ||
    (discountResolution.officialAmountDec != null &&
      discountResolution.computedAmountDec != null &&
      !discountResolution.officialAmountDec.eq(discountResolution.computedAmountDec))
  ) {
    logS7PromotionVariationRangeParity(payload);
  }

  return {
    finalPriceDec,
    finalPriceSource: pricePick.finalPriceSource,
    rawFinalPriceDec,
    discountAmountDec,
    rawDiscountAmountDec,
    discountAmountSource: discountResolution.source,
    discountPercentDec: percent.discountPercentDec,
    discountPercentDisplay: percent.discountPercentDisplay,
    discountPercentSource: percent.discountPercentSource,
    payoutBrl: payload.payout_brl,
    selectedRule,
    selectedSourcePath,
    sourceTrace,
    warningCodes,
    promotionPriceCandidates: candidateBundle.candidates,
    hasVariationRange: warningCodes.includes("variation_range_detected"),
    isAmbiguous: warningCodes.includes("ambiguous_single_price_selected"),
    currencyRoundingApplied: currencyRounding.applied === true,
    auditPayload: payload,
  };
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionResolverPanelParity(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_RESOLVER_PANEL_PARITY]", payload);
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionLightningPanelParity(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_LIGHTNING_PANEL_PARITY]", payload);
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionVariationRangeParity(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_VARIATION_RANGE_PARITY]", payload);
}

export const MercadoLivrePromotionPriceResolver = {
  collectPromotionPriceCandidates: collectMercadoLivrePromotionPriceCandidates,
  resolvePromotionDisplayPrice: resolveMercadoLivrePromotionPanelDisplayPrice,
  resolvePromotionDiscount: resolveMercadoLivrePromotionPanelDiscountAmount,
  resolvePromotionPercent: resolveMercadoLivrePromotionPanelPercent,
  resolvePromotionPayout: resolveMercadoLivrePromotionPanelPayout,
  resolvePanelParity: resolveMercadoLivrePromotionPanelParity,
};
