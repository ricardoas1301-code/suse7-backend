// ======================================================
// SSOT — resolvedor de preço promocional por família (Mercado Livre)
// Contrato único para o frontend via pickOfficialPromotionFinalPrice.
// ======================================================

import Decimal from "decimal.js";

const ROUND = Decimal.ROUND_HALF_UP;
const LIQUIDA_MAX_TIER_MODOSTO_DISC_PCT = new Decimal("6");
/** suggested cross-promo ≥ este % → tier agressivo exibido (suggested), não max modesto. */
const LIQUIDA_SUGGESTED_CROSS_PROMO_AGGRESSIVE_DISC_PCT = new Decimal("18");
const TOP_OFERTA_SIBLING_DEAL_MAX_ALIGNMENT_DISC_PCT = new Decimal("30");
const DEAL_MODERATE_TIER_MIN_DISC_PCT = new Decimal("10");
const DEAL_MODERATE_TIER_MAX_DISC_PCT = new Decimal("30");

/** Versão do registry — rastreada em [S7_PI_PROMOTION_SSOT_FRESHNESS_AUDIT]. */
export const PROMOTION_PRICE_RESOLVER_VERSION = "2026-07-05.panel-generalization-mlb4684020397.v1";

/** @typedef {'liquida_full_outlet'|'lightning'|'top_oferta'|'marketplace_deal'|'percentage_discount'|'default'} PromotionPriceFamily */

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
export function decStr2(d) {
  if (d == null) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
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

const ORIGINAL_PRICE_FIELD_KEYS = [
  "original_price",
  "regular_amount",
  "base_price",
  "list_price",
  "regular_price",
  "full_price",
];

/** @param {Record<string, unknown>} row @returns {Decimal | null} */
export function pickOriginalPriceDec(row) {
  return toDec(pickFirstRaw(row, ORIGINAL_PRICE_FIELD_KEYS));
}

/** @param {Decimal | null} dec @param {Decimal | null} originalDec */
export function pickValidFinalBelowOriginal(dec, originalDec) {
  if (dec == null || !dec.gt(0)) return null;
  if (originalDec != null && originalDec.gt(0) && dec.gte(originalDec)) return null;
  return dec;
}

/** @param {Record<string, unknown>} row @returns {boolean} */
export function isLiquidaFullOutletPromotionRow(row) {
  const nameRaw = row.name ?? row.promotion_name ?? "";
  const name = String(nameRaw).trim().toLowerCase();
  return name.includes("liquida full") && name.includes("outlet");
}

/** @param {unknown} typeValue @returns {boolean} */
export function tipoIndicaRelampago(typeValue) {
  const s = typeValue != null ? String(typeValue).trim().toLowerCase() : "";
  if (s === "") return false;
  return s.includes("lightning") || s.includes("relampago") || s.includes("relâmpago") || s.includes("flash");
}

/** @param {unknown} typeValue @returns {boolean} */
export function tipoIndicaCampanhaDeal(typeValue) {
  const t = typeValue != null ? String(typeValue).trim().toUpperCase() : "";
  return (
    t === "DEAL" ||
    t === "MARKETPLACE_CAMPAIGN" ||
    t === "DOD" ||
    t === "PRE_NEGOTIATED" ||
    t === "VOLUME"
  );
}

/** @param {Record<string, unknown>} row @returns {boolean} */
export function isNamedPromotionRow(row) {
  const id = row.id ?? row.promotion_id ?? row.campaign_id ?? row.deal_id;
  if (id != null && String(id).trim() !== "") return true;
  const nameRaw = row.name ?? row.promotion_name ?? "";
  return nameRaw != null && String(nameRaw).trim() !== "";
}

/** @param {Record<string, unknown>} row @returns {boolean} */
export function isTopOfertaSmartPromotionRow(row) {
  const promoType = row.type ?? row.promotion_type ?? row.sub_type;
  const t = promoType != null ? String(promoType).trim().toUpperCase() : "";
  if (t !== "SMART") return false;
  const nameRaw = row.name ?? row.promotion_name ?? "";
  const name = String(nameRaw).trim().toLowerCase();
  return name.includes("top oferta");
}

/** @param {Record<string, unknown>} row @returns {PromotionPriceFamily} */
export function classifyPromotionPriceFamily(row) {
  if (isLiquidaFullOutletPromotionRow(row)) return "liquida_full_outlet";
  const promoType = row.type ?? row.promotion_type ?? row.sub_type;
  if (tipoIndicaRelampago(promoType)) return "lightning";
  if (isTopOfertaSmartPromotionRow(row)) return "top_oferta";
  if (tipoIndicaCampanhaDeal(promoType) && isNamedPromotionRow(row)) return "marketplace_deal";
  const typeNorm = promoType != null ? String(promoType).trim().toUpperCase() : "";
  if (typeNorm === "PRICE_DISCOUNT" || typeNorm === "SELLER_CAMPAIGN") return "percentage_discount";
  return "default";
}

/** @param {Record<string, unknown>} row @returns {string} */
function rawPromotionStatusNormalized(row) {
  const s = row.status ?? row.raw_status ?? "";
  return String(s).trim().toLowerCase();
}

/** @param {string} statusNorm */
function isCandidateLikePromotionStatus(statusNorm) {
  return statusNorm === "" || statusNorm === "candidate" || statusNorm === "unknown";
}

/** @param {string} statusNorm */
function isStartedLikePromotionStatus(statusNorm) {
  return statusNorm === "started" || statusNorm === "active" || statusNorm === "pending";
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

/** @param {Decimal | null} originalDec @param {Decimal | null} priceDec @param {Decimal | null} maxDec */
function candidateTierGapAmbiguous(originalDec, priceDec, maxDec) {
  if (originalDec == null || !originalDec.gt(0)) return false;
  if (priceDec == null || maxDec == null || !maxDec.gt(priceDec)) return false;
  return maxDec.minus(priceDec).div(originalDec).lte(new Decimal("0.05"));
}

/** @param {Record<string, unknown>} row @returns {boolean} */
function isNamedDealRow(row) {
  return isNamedPromotionRow(row) && tipoIndicaCampanhaDeal(row.type ?? row.promotion_type ?? row.sub_type);
}

/**
 * @param {Record<string, unknown>} row
 * @param {Decimal | null} originalDec
 * @param {Decimal | null} maxDec
 * @param {Decimal | null} suggestedDec
 */
function candidateNamedDealPrefereMaxTierExibido(row, originalDec, maxDec, suggestedDec) {
  if (!isNamedDealRow(row)) return false;
  if (originalDec == null || maxDec == null || suggestedDec == null || !suggestedDec.lt(maxDec)) return false;
  const maxDiscPct = originalDec.minus(maxDec).div(originalDec).times(100);
  const suggestedDiscPct = originalDec.minus(suggestedDec).div(originalDec).times(100);
  return maxDiscPct.gte(10) && maxDiscPct.lte(30) && suggestedDiscPct.minus(maxDiscPct).gte(8);
}

/**
 * @param {string[] | undefined} sameListingOtherPromotionPrices
 * @param {Decimal | null} compareDec
 */
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

function candidateLiquidaFullOutletPrefereMaxTierModestoExibido(
  row,
  originalDec,
  priceDec,
  maxDec,
  suggestedDec
) {
  if (!isLiquidaFullOutletPromotionRow(row)) return false;
  if (originalDec == null || !originalDec.gt(0)) return false;
  if (maxDec == null || priceDec == null) return false;
  if (!maxDec.gt(priceDec)) return false;
  if (suggestedDec != null && !priceDec.eq(suggestedDec)) return false;
  const maxDiscPct = originalDec.minus(maxDec).div(originalDec).times(100);
  if (!(maxDiscPct.gt(0) && maxDiscPct.lte(LIQUIDA_MAX_TIER_MODOSTO_DISC_PCT))) return false;
  if (suggestedDec != null) {
    const suggestedDiscPct = originalDec.minus(suggestedDec).div(originalDec).times(100);
    if (suggestedDiscPct.gte(22)) return false;
  }
  return true;
}

function candidateLiquidaFullOutletRejeitaPriceCrossPromo(
  row,
  priceDec,
  maxDec,
  suggestedDec,
  sameListingOtherPromotionPrices,
  originalDec
) {
  if (!isLiquidaFullOutletPromotionRow(row)) return false;
  if (originalDec == null || !originalDec.gt(0)) return false;
  if (maxDec == null || priceDec == null) return false;
  if (!maxDec.gt(priceDec)) return false;
  if (suggestedDec != null && !priceDec.eq(suggestedDec)) return false;
  const maxDiscPct = originalDec.minus(maxDec).div(originalDec).times(100);
  if (maxDiscPct.gt(LIQUIDA_MAX_TIER_MODOSTO_DISC_PCT)) return false;
  if (suggestedDec != null) {
    const suggestedDiscPct = originalDec.minus(suggestedDec).div(originalDec).times(100);
    if (suggestedDiscPct.gte(22)) return false;
  }
  return priceMatchesSameListingOtherPromotion(sameListingOtherPromotionPrices, priceDec);
}

function candidateLiquidaFullOutletPrefereMaxQuandoSuggestedCrossPromoSemPrice(
  row,
  originalDec,
  priceDec,
  maxDec,
  suggestedDec,
  sameListingOtherPromotionPrices
) {
  if (!isLiquidaFullOutletPromotionRow(row)) return false;
  if (priceDec != null) return false;
  if (originalDec == null || maxDec == null || suggestedDec == null) return false;
  if (!maxDec.gt(suggestedDec)) return false;
  const maxDiscPct = originalDec.minus(maxDec).div(originalDec).times(100);
  if (maxDiscPct.gt(LIQUIDA_MAX_TIER_MODOSTO_DISC_PCT)) return false;
  const suggestedDiscPct = originalDec.minus(suggestedDec).div(originalDec).times(100);
  if (suggestedDiscPct.gte(22)) return false;
  if (suggestedDiscPct.gte(LIQUIDA_SUGGESTED_CROSS_PROMO_AGGRESSIVE_DISC_PCT)) return false;
  return priceMatchesSameListingOtherPromotion(sameListingOtherPromotionPrices, suggestedDec);
}

/**
 * @param {Record<string, unknown>[]} siblingRows
 * @param {Decimal | null} originalDec
 * @returns {Decimal | null}
 */
function findSiblingDealModerateMaxTierDec(siblingRows, originalDec) {
  if (originalDec == null || !originalDec.gt(0)) return null;
  if (!Array.isArray(siblingRows)) return null;
  /** @type {Decimal | null} */
  let best = null;
  for (const sibling of siblingRows) {
    if (!sibling || typeof sibling !== "object") continue;
    if (!isNamedDealRow(sibling)) continue;
    const maxDec = pickValidFinalBelowOriginal(toDec(sibling.max_discounted_price), originalDec);
    if (maxDec == null) continue;
    const discPct = originalDec.minus(maxDec).div(originalDec).times(100);
    if (discPct.lt(DEAL_MODERATE_TIER_MIN_DISC_PCT) || discPct.gt(DEAL_MODERATE_TIER_MAX_DISC_PCT)) {
      continue;
    }
    if (best == null || maxDec.gt(best)) best = maxDec;
  }
  return best;
}

const LIGHTNING_BUYER_PRICE_FIELD_KEYS = [
  "top_deal_price",
  "top_deal",
  "deal_price",
  "promotion_price",
  "buyer_price",
  "fixed_price",
  "amount",
  "price",
];

/**
 * @param {Record<string, unknown>} row
 * @param {Decimal | null} originalDec
 * @returns {{ dec: Decimal; source: string } | null}
 */
function pickLightningBuyerFacingPrice(row, originalDec) {
  if (isBoostedOfferTruthy(row)) {
    const boosted = pickValidFinalBelowOriginal(toDec(row.total_price_for_boosted_offer), originalDec);
    if (boosted != null) {
      return { dec: boosted, source: "total_price_for_boosted_offer" };
    }
  }
  const lightningBoosted = pickValidFinalBelowOriginal(toDec(row.total_price_for_boosted_offer), originalDec);
  if (lightningBoosted != null) {
    return { dec: lightningBoosted, source: "total_price_for_boosted_offer" };
  }

  /** @type {{ dec: Decimal; source: string }[]} */
  const candidates = [];
  for (const key of LIGHTNING_BUYER_PRICE_FIELD_KEYS) {
    const raw = pickFirstRaw(row, [key]);
    const dec = pickValidFinalBelowOriginal(toDec(raw), originalDec);
    if (dec != null) candidates.push({ dec, source: key });
  }

  if (candidates.length === 0) return null;

  const minDec = pickValidFinalBelowOriginal(toDec(row.min_discounted_price), originalDec);
  let filtered = candidates;
  if (minDec != null) {
    filtered = candidates.filter((c) => c.dec.gte(minDec));
    if (filtered.length === 0) filtered = candidates;
  }

  filtered.sort((a, b) => a.dec.comparedTo(b.dec));
  const topDeal = filtered.find((c) => c.source === "top_deal_price" || c.source === "top_deal");
  if (topDeal != null) return topDeal;

  const dealPrice = filtered.find((c) => c.source === "deal_price" || c.source === "promotion_price");
  if (dealPrice != null && dealPrice.dec.lt(filtered[filtered.length - 1]?.dec ?? dealPrice.dec)) {
    return dealPrice;
  }

  return filtered[0];
}

/**
 * @param {Record<string, unknown>} row
 * @param {import("./mercadoLivrePromotionPriceResolverRegistry.js").PromotionPriceResolverContext} ctx
 * @returns {{ finalPriceDec: Decimal | null; finalPriceSource: string | null } | null}
 */
function strategyLiquidaFullOutlet(row, ctx) {
  const { originalDec, priceDec, maxDec, suggestedDec, opts } = ctx;
  if (
    candidateLiquidaFullOutletPrefereMaxTierModestoExibido(
      row,
      originalDec,
      priceDec,
      maxDec,
      suggestedDec
    ) ||
    candidateLiquidaFullOutletRejeitaPriceCrossPromo(
      row,
      priceDec,
      maxDec,
      suggestedDec,
      opts.sameListingOtherPromotionPrices,
      originalDec
    ) ||
    candidateLiquidaFullOutletPrefereMaxQuandoSuggestedCrossPromoSemPrice(
      row,
      originalDec,
      priceDec,
      maxDec,
      suggestedDec,
      opts.sameListingOtherPromotionPrices
    )
  ) {
    return { finalPriceDec: maxDec, finalPriceSource: "max_discounted_price" };
  }
  return null;
}

/** @param {Record<string, unknown>} row @param {import("./mercadoLivrePromotionPriceResolverRegistry.js").PromotionPriceResolverContext} ctx */
function strategyLightning(row, ctx) {
  if (!ctx.isCandidate && !isCandidateLikePromotionStatus(ctx.statusNorm)) {
    const priceDec = pickValidFinalBelowOriginal(
      toDec(row.price ?? row.amount ?? row.deal_price),
      ctx.originalDec
    );
    if (priceDec != null) return { finalPriceDec: priceDec, finalPriceSource: "price" };
  }
  const picked = pickLightningBuyerFacingPrice(row, ctx.originalDec);
  if (picked != null) return { finalPriceDec: picked.dec, finalPriceSource: picked.source };
  return null;
}

/** @param {Record<string, unknown>} row @param {import("./mercadoLivrePromotionPriceResolverRegistry.js").PromotionPriceResolverContext} ctx */
function strategyTopOferta(row, ctx) {
  if (!ctx.isCandidate) return null;
  const { originalDec, priceDec } = ctx;
  if (originalDec == null || priceDec == null) return null;
  const priceDiscPct = originalDec.minus(priceDec).div(originalDec).times(100);
  if (priceDiscPct.lt(TOP_OFERTA_SIBLING_DEAL_MAX_ALIGNMENT_DISC_PCT)) return null;

  const siblingMax = findSiblingDealModerateMaxTierDec(
    optsSameListingSiblingRows(ctx.opts),
    originalDec
  );
  if (siblingMax != null && siblingMax.gt(priceDec)) {
    return { finalPriceDec: siblingMax, finalPriceSource: "sibling_deal_max_discounted_price" };
  }
  return null;
}

/** @param {{ sameListingSiblingRows?: Record<string, unknown>[] }} opts */
function optsSameListingSiblingRows(opts) {
  return Array.isArray(opts.sameListingSiblingRows) ? opts.sameListingSiblingRows : [];
}

/** @param {Record<string, unknown>} row @param {import("./mercadoLivrePromotionPriceResolverRegistry.js").PromotionPriceResolverContext} ctx */
function strategyMarketplaceDeal(row, ctx) {
  if (!ctx.isCandidate) return null;
  const { originalDec, priceDec, maxDec, suggestedDec } = ctx;
  const tierAmbiguous = candidateTierGapAmbiguous(originalDec, priceDec, maxDec);

  if (
    suggestedDec != null &&
    maxDec != null &&
    suggestedDec.eq(maxDec) &&
    priceDec != null &&
    priceDec.eq(suggestedDec)
  ) {
    return { finalPriceDec: suggestedDec, finalPriceSource: "suggested_discounted_price" };
  }
  if (suggestedDec != null && maxDec != null && suggestedDec.eq(maxDec) && tierAmbiguous) {
    return { finalPriceDec: suggestedDec, finalPriceSource: "suggested_discounted_price" };
  }
  if (suggestedDec == null && maxDec != null && tierAmbiguous) {
    return { finalPriceDec: maxDec, finalPriceSource: "max_discounted_price" };
  }
  if (priceDec != null) {
    return { finalPriceDec: priceDec, finalPriceSource: "price" };
  }
  if (
    priceDec == null &&
    candidateNamedDealPrefereMaxTierExibido(row, originalDec, maxDec, suggestedDec)
  ) {
    return { finalPriceDec: maxDec, finalPriceSource: "max_discounted_price" };
  }
  if (suggestedDec != null) {
    return { finalPriceDec: suggestedDec, finalPriceSource: "suggested_discounted_price" };
  }
  if (maxDec != null) return { finalPriceDec: maxDec, finalPriceSource: "max_discounted_price" };
  if (ctx.minDec != null) return { finalPriceDec: ctx.minDec, finalPriceSource: "min_discounted_price" };
  return null;
}

/** @param {import("./mercadoLivrePromotionPriceResolverRegistry.js").PromotionPriceResolverContext} ctx */
function strategyDefault(ctx) {
  const { row, originalDec, priceDec, maxDec, suggestedDec, minDec, isCandidate, statusNorm } = ctx;

  if (isCandidate) {
    const tierAmbiguous = candidateTierGapAmbiguous(originalDec, priceDec, maxDec);

    if (
      suggestedDec != null &&
      maxDec != null &&
      suggestedDec.eq(maxDec) &&
      priceDec != null &&
      priceDec.eq(suggestedDec)
    ) {
      return { finalPriceDec: suggestedDec, finalPriceSource: "suggested_discounted_price" };
    }
    if (suggestedDec != null && maxDec != null && suggestedDec.eq(maxDec) && tierAmbiguous) {
      return { finalPriceDec: suggestedDec, finalPriceSource: "suggested_discounted_price" };
    }
    if (suggestedDec == null && maxDec != null && tierAmbiguous) {
      return { finalPriceDec: maxDec, finalPriceSource: "max_discounted_price" };
    }

    if (priceDec != null) return { finalPriceDec: priceDec, finalPriceSource: "price" };
    if (
      priceDec == null &&
      candidateNamedDealPrefereMaxTierExibido(row, originalDec, maxDec, suggestedDec)
    ) {
      return { finalPriceDec: maxDec, finalPriceSource: "max_discounted_price" };
    }
    if (suggestedDec != null) {
      return { finalPriceDec: suggestedDec, finalPriceSource: "suggested_discounted_price" };
    }
    if (maxDec != null) return { finalPriceDec: maxDec, finalPriceSource: "max_discounted_price" };
    if (minDec != null) return { finalPriceDec: minDec, finalPriceSource: "min_discounted_price" };
  } else if (isStartedLikePromotionStatus(statusNorm)) {
    if (priceDec != null) return { finalPriceDec: priceDec, finalPriceSource: "price" };
    if (suggestedDec != null) {
      return { finalPriceDec: suggestedDec, finalPriceSource: "suggested_discounted_price" };
    }
    if (maxDec != null) return { finalPriceDec: maxDec, finalPriceSource: "max_discounted_price" };
    if (minDec != null) return { finalPriceDec: minDec, finalPriceSource: "min_discounted_price" };
  } else {
    if (priceDec != null) return { finalPriceDec: priceDec, finalPriceSource: "price" };
    if (suggestedDec != null) {
      return { finalPriceDec: suggestedDec, finalPriceSource: "suggested_discounted_price" };
    }
    if (maxDec != null) return { finalPriceDec: maxDec, finalPriceSource: "max_discounted_price" };
    if (minDec != null) return { finalPriceDec: minDec, finalPriceSource: "min_discounted_price" };
  }

  const topDec = pickValidFinalBelowOriginal(toDec(row.top_deal_price), originalDec);
  if (topDec != null) return { finalPriceDec: topDec, finalPriceSource: "top_deal_price" };
  return { finalPriceDec: null, finalPriceSource: null };
}

/**
 * @typedef {{
 *   row: Record<string, unknown>;
 *   originalDec: Decimal | null;
 *   priceDec: Decimal | null;
 *   maxDec: Decimal | null;
 *   suggestedDec: Decimal | null;
 *   minDec: Decimal | null;
 *   isCandidate: boolean;
 *   statusNorm: string;
 *   family: PromotionPriceFamily;
 *   opts: {
 *     sameListingOtherPromotionPrices?: string[];
 *     sameListingSiblingRows?: Record<string, unknown>[];
 *     structuralAnonymousPriceDenylist?: Set<string>;
 *   };
 * }} PromotionPriceResolverContext
 */

/**
 * @param {Record<string, unknown>} row
 * @param {{
 *   sameListingOtherPromotionPrices?: string[];
 *   sameListingSiblingRows?: Record<string, unknown>[];
 *   structuralAnonymousPriceDenylist?: Set<string>;
 * }} [opts]
 * @returns {{ finalPriceDec: Decimal | null; finalPriceSource: string | null; family: PromotionPriceFamily; audit: Record<string, unknown> }}
 */
export function resolvePromotionPriceViaRegistry(row, opts = {}) {
  const originalDec = pickOriginalPriceDec(row);
  const priceDec = pickValidFinalBelowOriginal(
    toDec(row.price ?? row.amount ?? row.deal_price),
    originalDec
  );
  const maxDec = pickValidFinalBelowOriginal(toDec(row.max_discounted_price), originalDec);
  const suggestedDec = pickValidFinalBelowOriginal(toDec(row.suggested_discounted_price), originalDec);
  const minDec = pickValidFinalBelowOriginal(toDec(row.min_discounted_price), originalDec);
  const statusNorm = rawPromotionStatusNormalized(row);
  const isCandidate = isCandidateLikePromotionStatus(statusNorm);
  const family = classifyPromotionPriceFamily(row);

  /** @type {PromotionPriceResolverContext} */
  const ctx = {
    row,
    originalDec,
    priceDec,
    maxDec,
    suggestedDec,
    minDec,
    isCandidate,
    statusNorm,
    family,
    opts,
  };

  /** @type {{ finalPriceDec: Decimal | null; finalPriceSource: string | null } | null} */
  let picked = null;

  if (isBoostedOfferTruthy(row)) {
    const boosted = pickValidFinalBelowOriginal(toDec(row.total_price_for_boosted_offer), originalDec);
    if (boosted != null) {
      picked = { finalPriceDec: boosted, finalPriceSource: "total_price_for_boosted_offer" };
    }
  }

  if (picked == null && family === "liquida_full_outlet" && isCandidate) {
    picked = strategyLiquidaFullOutlet(row, ctx);
  }
  if (picked == null && family === "lightning") {
    picked = strategyLightning(row, ctx);
  }
  if (picked == null && family === "top_oferta") {
    picked = strategyTopOferta(row, ctx);
  }
  if (picked == null && family === "marketplace_deal" && isCandidate) {
    picked = strategyMarketplaceDeal(row, ctx);
  }
  if (picked == null) {
    picked = strategyDefault(ctx);
  }

  const audit = buildPromotionPriceResolverAuditPayload(row, ctx, picked, {
    listingId: opts.listingId ?? null,
    variationId: opts.variationId ?? null,
    sameListingOtherPromotionPrices: opts.sameListingOtherPromotionPrices,
    sameListingSiblingRows: opts.sameListingSiblingRows,
  });
  return {
    finalPriceDec: picked.finalPriceDec,
    finalPriceSource: picked.finalPriceSource,
    family,
    audit,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {PromotionPriceResolverContext} ctx
 * @param {{ finalPriceDec: Decimal | null; finalPriceSource: string | null }} picked
 * @param {{ listingId?: string | null; variationId?: string | null; sameListingOtherPromotionPrices?: string[]; sameListingSiblingRows?: Record<string, unknown>[] }} opts
 */
export function buildPromotionPriceResolverAuditPayload(row, ctx, picked, opts = {}) {
  const { originalDec, priceDec, maxDec, suggestedDec, minDec, family } = ctx;
  const pickedDec = picked.finalPriceDec;

  /** @type {{ price_brl: string; source: string; reason?: string }[]} */
  const candidates = [];
  const candidateFields = [
    ["price", priceDec],
    ["suggested_discounted_price", suggestedDec],
    ["max_discounted_price", maxDec],
    ["min_discounted_price", minDec],
    ["top_deal_price", pickValidFinalBelowOriginal(toDec(row.top_deal_price), originalDec)],
    ["deal_price", pickValidFinalBelowOriginal(toDec(row.deal_price), originalDec)],
    [
      "total_price_for_boosted_offer",
      pickValidFinalBelowOriginal(toDec(row.total_price_for_boosted_offer), originalDec),
    ],
  ];
  for (const [source, dec] of candidateFields) {
    if (dec != null) {
      candidates.push({ price_brl: decStr2(dec), source });
    }
  }

  const siblingMax = findSiblingDealModerateMaxTierDec(
    optsSameListingSiblingRows(opts),
    originalDec
  );
  if (siblingMax != null) {
    candidates.push({
      price_brl: decStr2(siblingMax),
      source: "sibling_deal_max_discounted_price",
    });
  }

  /** @type {{ price_brl: string; source: string; reason: string }[]} */
  const rejectedCandidates = [];
  for (const candidate of candidates) {
    if (pickedDec != null && candidate.price_brl === decStr2(pickedDec)) continue;
    rejectedCandidates.push({
      ...candidate,
      reason: "not_selected_by_family_strategy",
    });
  }

  const sameListingOtherPromotionPrices = Array.isArray(opts.sameListingOtherPromotionPrices)
    ? opts.sameListingOtherPromotionPrices
    : [];

  let samePriceAsOtherPromotion = false;
  let suggestedFromOtherPromotion = false;
  if (pickedDec != null) {
    samePriceAsOtherPromotion = priceMatchesSameListingOtherPromotion(
      sameListingOtherPromotionPrices,
      pickedDec
    );
  }
  if (suggestedDec != null) {
    suggestedFromOtherPromotion = priceMatchesSameListingOtherPromotion(
      sameListingOtherPromotionPrices,
      suggestedDec
    );
  }

  const maxModestCandidate =
    family === "liquida_full_outlet" &&
    maxDec != null &&
    originalDec != null &&
    originalDec.minus(maxDec).div(originalDec).times(100).lte(LIQUIDA_MAX_TIER_MODOSTO_DISC_PCT);

  const enrichmentOverrodeListingRow = row._suse7_price_enriched === true;

  const ambiguousCandidate =
    candidateTierGapAmbiguous(originalDec, priceDec, maxDec) ||
    (suggestedDec != null && maxDec != null && suggestedDec.eq(maxDec) && priceDec != null && !priceDec.eq(suggestedDec));

  let selectedDiscountAmount = null;
  let selectedDiscountPercent = null;
  if (originalDec != null && pickedDec != null && originalDec.gt(pickedDec)) {
    selectedDiscountAmount = decStr2(originalDec.minus(pickedDec));
    selectedDiscountPercent = decStr2(originalDec.minus(pickedDec).times(100).div(originalDec));
  }

  return {
    listing_id: opts.listingId ?? row.item_id ?? row.listing_id ?? null,
    promotion_id: row.id ?? row.promotion_id ?? null,
    promotion_name: row.name ?? row.promotion_name ?? null,
    promotion_family: family,
    original_price: originalDec != null ? decStr2(originalDec) : null,
    base_price: originalDec != null ? decStr2(originalDec) : null,
    selected_final_price: pickedDec != null ? decStr2(pickedDec) : null,
    selected_discount_amount: selectedDiscountAmount,
    selected_discount_percent: selectedDiscountPercent,
    selected_source: picked.finalPriceSource,
    selected_field: picked.finalPriceSource,
    candidates,
    rejected_candidates: rejectedCandidates,
    contamination_flags: {
      same_price_as_other_promotion: samePriceAsOtherPromotion,
      suggested_from_other_promotion: suggestedFromOtherPromotion,
      max_modest_candidate: maxModestCandidate,
      enrichment_overrode_listing_row: enrichmentOverrodeListingRow,
      ambiguous_candidate: ambiguousCandidate,
    },
  };
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionPriceResolverAudit(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_PRICE_RESOLVER_AUDIT]", payload);
}

/** Re-export para testes de Liquida (compat Etapa 1D). */
export {
  candidateLiquidaFullOutletPrefereMaxTierModestoExibido,
  candidateLiquidaFullOutletRejeitaPriceCrossPromo,
  candidateLiquidaFullOutletPrefereMaxQuandoSuggestedCrossPromoSemPrice,
};
