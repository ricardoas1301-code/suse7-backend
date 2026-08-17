// ======================================================
// Promoções ML — funding (desconto seller vs subsídio de preço ML).
// Decimal.js — pronto para extensão multi-marketplace via resolvePromotionFunding.
// ======================================================

import Decimal from "decimal.js";

import {
  buildPromotionFinancialAdjustments,
  resolveMercadoLivrePromotionFeeDiscount,
} from "./mercadoLivrePromotionFeeDiscountResolver.js";

const ROUND = Decimal.ROUND_HALF_UP;
const TOLERANCIA_FECHAMENTO_BRL = new Decimal("0.02");

/** @param {unknown} v @returns {Decimal | null} */
export function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null | undefined} d @returns {string | null} */
export function decStr2(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/** @param {Decimal | null | undefined} d @returns {string | null} */
function decStrPercentDisplay(d) {
  if (d == null || !d.isFinite()) return null;
  const arred = d.toDecimalPlaces(2, ROUND);
  if (arred.mod(1).eq(0)) return String(arred.toFixed(0));
  return arred.toFixed(2).replace(".", ",");
}

/**
 * @param {Record<string, unknown>} src
 * @param {string[]} keys
 * @returns {Decimal | null}
 */
function pickAmountDec(src, keys) {
  for (const key of keys) {
    const d = toDec(src[key]);
    if (d != null && d.gte(0)) return d;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} src
 * @param {string[]} keys
 * @returns {Decimal | null}
 */
function pickPercentDec(src, keys) {
  for (const key of keys) {
    const d = toDec(src[key]);
    if (d != null && d.gte(0)) return d;
  }
  return null;
}

/**
 * @param {Decimal} a
 * @param {Decimal} b
 * @returns {boolean}
 */
function approxEq(a, b) {
  return a.minus(b).abs().lte(TOLERANCIA_FECHAMENTO_BRL);
}

/**
 * Percentuais somam ~100 → rateio do desconto total.
 *
 * @param {Decimal} sellerPct
 * @param {Decimal} meliPct
 * @returns {boolean}
 */
function percentuaisParecemRateioFunding(sellerPct, meliPct) {
  const sum = sellerPct.plus(meliPct);
  return sum.gte(95) && sum.lte(105);
}

/**
 * Percentuais somam ~desconto total em pontos sobre original.
 *
 * @param {Decimal} sellerPct
 * @param {Decimal} meliPct
 * @param {Decimal} totalDiscountPct
 * @returns {boolean}
 */
function percentuaisParecemPontosDesconto(sellerPct, meliPct, totalDiscountPct) {
  const sum = sellerPct.plus(meliPct);
  if (totalDiscountPct.lte(0)) return false;
  return sum.minus(totalDiscountPct).abs().lte(new Decimal("0.5"));
}

const CHAVES_SELLER_AMOUNT = [
  "seller_amount",
  "seller_discount_amount",
  "seller_funded_amount",
  "seller_discount_amount_brl",
  "discount_seller_brl",
];

const CHAVES_MELI_PRICE_AMOUNT = [
  "meli_amount",
  "marketplace_amount",
  "marketplace_subsidy_amount",
  "meli_subsidy_amount",
  "meli_funded_amount",
  "discount_meli_price_brl",
];

/** Campos de redução de tarifa — nunca usar como subsídio de preço. */
const CHAVES_FEE_DISCOUNT_NUNCA_PRECO = [
  "discount_meli_boost_amount",
  "meli_boost_amount",
  "fee_discount_amount",
  "marketplace_fee_discount_amount",
  "fee_discount",
  "sale_fee_discount",
];

const CHAVES_SELLER_PCT = [
  "seller_percentage",
  "seller_discount_percentage",
  "seller_discount_percent",
];

const CHAVES_MELI_PCT = ["meli_percentage", "meli_discount_percentage", "meli_discount_percent"];

const CHAVES_ORIGINAL = [
  "original_price",
  "original_price_brl",
  "regular_amount",
  "base_price",
  "list_price",
];

const CHAVES_BUYER_FINAL = [
  "price",
  "buyer_final_price",
  "buyer_final_price_brl",
  "real_promotion_final_price_brl",
  "final_price_brl",
  "amount",
  "deal_price",
  "suggested_discounted_price",
  "max_discounted_price",
];

/**
 * @param {{
 *   marketplace?: string;
 *   rawPromotion?: Record<string, unknown> | null;
 *   originalPrice?: unknown;
 *   buyerFinalPrice?: unknown;
 *   promotionPriceCandidates?: unknown[];
 *   listing_id?: string | null;
 *   promotion_id?: string | null;
 *   promotion_name?: string | null;
 *   promotion_type?: string | null;
 * }} params
 */
export function resolveMercadoLivrePromotionFunding(params = {}) {
  const raw =
    params.rawPromotion != null && typeof params.rawPromotion === "object"
      ? /** @type {Record<string, unknown>} */ (params.rawPromotion)
      : /** @type {Record<string, unknown>} */ ({});

  const originalDec =
    toDec(params.originalPrice) ??
    pickAmountDec(raw, CHAVES_ORIGINAL);

  let buyerDec =
    toDec(params.buyerFinalPrice) ??
    pickAmountDec(raw, CHAVES_BUYER_FINAL);

  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const funding_source_trace = [];

  if (originalDec == null || buyerDec == null) {
    return buildFundingResult({
      originalDec,
      buyerDec,
      sellerDiscountDec: null,
      meliSubsidyDec: null,
      totalDiscountDec: null,
      subsidy_source: "none",
      confidence: "low",
      warnings: ["missing_original_or_buyer_final_price", ...warnings],
      funding_source_trace,
      params,
    });
  }

  if (buyerDec.gt(originalDec)) {
    warnings.push("buyer_final_above_original");
  }

  const totalDiscountDec = Decimal.max(0, originalDec.minus(buyerDec));
  const totalDiscountPctDec =
    originalDec.gt(0) ? totalDiscountDec.times(100).div(originalDec) : new Decimal(0);

  const sellerAmountDirect = pickAmountDec(raw, CHAVES_SELLER_AMOUNT);
  let meliAmountDirect = pickAmountDec(raw, CHAVES_MELI_PRICE_AMOUNT);
  const feeDiscountFromRaw = pickAmountDec(raw, CHAVES_FEE_DISCOUNT_NUNCA_PRECO);
  if (
    meliAmountDirect != null &&
    feeDiscountFromRaw != null &&
    meliAmountDirect.minus(feeDiscountFromRaw).abs().lte(TOLERANCIA_FECHAMENTO_BRL)
  ) {
    meliAmountDirect = null;
  }

  let sellerDiscountDec = null;
  let meliSubsidyDec = null;
  let subsidy_source = "none";
  let confidence = "medium";

  if (sellerAmountDirect != null && meliAmountDirect != null && meliAmountDirect.gt(0)) {
    sellerDiscountDec = sellerAmountDirect;
    meliSubsidyDec = meliAmountDirect;
    subsidy_source = "direct_amounts";
    funding_source_trace.push("priority_1:seller_amount+meli_amount");
    confidence = "high";
  } else if (sellerAmountDirect != null && meliAmountDirect == null && sellerAmountDirect.gt(0)) {
    sellerDiscountDec = sellerAmountDirect;
    meliSubsidyDec = Decimal.max(0, totalDiscountDec.minus(sellerDiscountDec));
    subsidy_source = meliSubsidyDec.gt(0) ? "direct_seller_amount_residual" : "direct_seller_amount_only";
    funding_source_trace.push("priority_1:seller_amount_only");
    confidence = meliSubsidyDec.gt(0) ? "medium" : "high";
  } else {
    const sellerPct = pickPercentDec(raw, CHAVES_SELLER_PCT);

    if (sellerPct != null && sellerPct.gt(0) && totalDiscountDec.gt(0)) {
      const fromSellerPoints = originalDec.times(sellerPct).div(100);
      if (fromSellerPoints.lte(totalDiscountDec.plus(TOLERANCIA_FECHAMENTO_BRL))) {
        sellerDiscountDec = fromSellerPoints;
        meliSubsidyDec = new Decimal(0);
        subsidy_source = "seller_percent_only_no_meli_price_co_funding";
        funding_source_trace.push("priority_2:seller_percentage_only_no_meli_price_subsidy");
        warnings.push("meli_percentage_ignored_not_price_co_funding");
      }
    }
  }

  if (sellerDiscountDec == null) {
    sellerDiscountDec = totalDiscountDec;
    meliSubsidyDec = new Decimal(0);
    subsidy_source = "no_subsidy_detected_full_seller_discount";
    funding_source_trace.push("priority_4:full_discount_to_seller");
    confidence = totalDiscountDec.gt(0) ? "medium" : "high";
  }

  if (meliSubsidyDec == null) meliSubsidyDec = new Decimal(0);

  sellerDiscountDec = sellerDiscountDec.toDecimalPlaces(2, ROUND);
  meliSubsidyDec = meliSubsidyDec.toDecimalPlaces(2, ROUND);

  const sumParts = sellerDiscountDec.plus(meliSubsidyDec);
  if (totalDiscountDec.gt(0) && !approxEq(sumParts, totalDiscountDec)) {
    warnings.push("funding_parts_do_not_close_total_discount");
    if (meliSubsidyDec.gt(0)) {
      meliSubsidyDec = Decimal.max(0, totalDiscountDec.minus(sellerDiscountDec)).toDecimalPlaces(2, ROUND);
      funding_source_trace.push("rebalance:meli_from_total_minus_seller");
    }
  }

  return buildFundingResult({
    originalDec,
    buyerDec,
    sellerDiscountDec,
    meliSubsidyDec,
    totalDiscountDec,
    subsidy_source,
    confidence,
    warnings,
    funding_source_trace,
    params,
  });
}

/**
 * @param {{
 *   originalDec: Decimal | null;
 *   buyerDec: Decimal | null;
 *   sellerDiscountDec: Decimal | null;
 *   meliSubsidyDec: Decimal | null;
 *   totalDiscountDec: Decimal | null;
 *   subsidy_source: string;
 *   confidence: string;
 *   warnings: string[];
 *   funding_source_trace: string[];
 *   params: Record<string, unknown>;
 * }} ctx
 */
function buildFundingResult(ctx) {
  const {
    originalDec,
    buyerDec,
    sellerDiscountDec,
    meliSubsidyDec,
    totalDiscountDec,
    subsidy_source,
    confidence,
    warnings,
    funding_source_trace,
    params,
  } = ctx;

  const hasSubsidy = meliSubsidyDec != null && meliSubsidyDec.gt(0);
  const sellerEff =
    buyerDec != null && meliSubsidyDec != null
      ? buyerDec.plus(meliSubsidyDec)
      : originalDec != null && sellerDiscountDec != null
        ? originalDec.minus(sellerDiscountDec)
        : buyerDec;

  const sellerEffDec =
    sellerEff != null && sellerEff.isFinite() ? sellerEff.toDecimalPlaces(2, ROUND) : null;

  const sellerPctDec =
    originalDec != null && originalDec.gt(0) && sellerDiscountDec != null
      ? sellerDiscountDec.times(100).div(originalDec)
      : null;
  const meliPctDec =
    originalDec != null && originalDec.gt(0) && meliSubsidyDec != null
      ? meliSubsidyDec.times(100).div(originalDec)
      : null;
  const totalPctDec =
    originalDec != null && originalDec.gt(0) && totalDiscountDec != null
      ? totalDiscountDec.times(100).div(originalDec)
      : null;

  const raw =
    params.rawPromotion != null && typeof params.rawPromotion === "object"
      ? /** @type {Record<string, unknown>} */ (params.rawPromotion)
      : /** @type {Record<string, unknown>} */ ({});

  const result = {
    marketplace: "mercado_livre",
    original_price_brl: originalDec != null ? decStr2(originalDec) : null,
    buyer_final_price_brl: buyerDec != null ? decStr2(buyerDec) : null,

    total_discount_brl: totalDiscountDec != null ? decStr2(totalDiscountDec) : null,
    total_discount_percent: totalPctDec != null ? decStrPercentDisplay(totalPctDec) : null,

    seller_discount_brl: sellerDiscountDec != null ? decStr2(sellerDiscountDec) : null,
    seller_discount_percent: sellerPctDec != null ? decStrPercentDisplay(sellerPctDec) : null,

    marketplace_subsidy_brl: meliSubsidyDec != null ? decStr2(meliSubsidyDec) : "0.00",
    marketplace_subsidy_percent: meliPctDec != null ? decStrPercentDisplay(meliPctDec) : null,

    seller_effective_price_brl: sellerEffDec != null ? decStr2(sellerEffDec) : null,

    has_marketplace_subsidy: hasSubsidy,
    subsidy_source,
    funding_source_trace,
    confidence,
    warnings,

    seller_percentage_raw: pickFirstRawValue(raw, CHAVES_SELLER_PCT),
    meli_percentage_raw: pickFirstRawValue(raw, CHAVES_MELI_PCT),
  };

  logPromotionFundingResolver({
    listing_id: params.listing_id ?? raw.item_id ?? raw.listing_id ?? null,
    promotion_id: params.promotion_id ?? raw.id ?? raw.promotion_id ?? null,
    promotion_name: params.promotion_name ?? raw.name ?? raw.promotion_name ?? null,
    promotion_type: params.promotion_type ?? raw.type ?? raw.promotion_type ?? null,
    funding: result,
  });

  return result;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} keys
 */
function pickFirstRawValue(row, keys) {
  for (const key of keys) {
    const v = row[key];
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
}

/**
 * @param {{
 *   listing_id?: unknown;
 *   promotion_id?: unknown;
 *   promotion_name?: unknown;
 *   promotion_type?: unknown;
 *   funding: Record<string, unknown>;
 * }} payload
 */
export function logPromotionFundingResolver(payload) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  const f = payload.funding ?? {};
  console.info("[S7_PROMOTION_FUNDING_RESOLVER]", {
    listing_id: payload.listing_id ?? null,
    promotion_id: payload.promotion_id ?? null,
    promotion_name: payload.promotion_name ?? null,
    promotion_type: payload.promotion_type ?? null,
    original_price_brl: f.original_price_brl ?? null,
    buyer_final_price_brl: f.buyer_final_price_brl ?? null,
    total_discount_brl: f.total_discount_brl ?? null,
    seller_discount_brl: f.seller_discount_brl ?? null,
    marketplace_subsidy_brl: f.marketplace_subsidy_brl ?? null,
    seller_effective_price_brl: f.seller_effective_price_brl ?? null,
    seller_percentage: f.seller_percentage_raw ?? null,
    meli_percentage: f.meli_percentage_raw ?? null,
    has_marketplace_subsidy: f.has_marketplace_subsidy === true,
    subsidy_source: f.subsidy_source ?? null,
    funding_source_trace: f.funding_source_trace ?? [],
    confidence: f.confidence ?? null,
    warnings: f.warnings ?? [],
  });
}

/**
 * Entry multi-marketplace (ML hoje).
 *
 * @param {Parameters<typeof resolveMercadoLivrePromotionFunding>[0]} params
 */
export function resolvePromotionFunding(params = {}) {
  const marketplace =
    params.marketplace != null ? String(params.marketplace).trim().toLowerCase() : "mercado_livre";
  if (marketplace === "mercado_livre" || marketplace === "ml") {
    return resolveMercadoLivrePromotionFunding(params);
  }
  return resolveMercadoLivrePromotionFunding(params);
}

/**
 * Anexa funding normalizado a contratos de promoção PI.
 *
 * @param {Record<string, unknown>} contract
 * @param {Record<string, unknown>} rawRow
 * @param {{ listing_id?: string | null; promotion_id?: string | null; promotion_name?: string | null; promotion_type?: string | null }} [meta]
 */
export function enrichPromotionContractWithFunding(contract, rawRow, meta = {}) {
  if (contract == null || typeof contract !== "object") return contract;
  const raw =
    rawRow != null && typeof rawRow === "object"
      ? /** @type {Record<string, unknown>} */ (rawRow)
      : /** @type {Record<string, unknown>} */ ({});

  const buyerFinal =
    contract.real_promotion_final_price_brl ??
    contract.buyer_final_price_brl ??
    contract.final_price_brl;

  const feeDiscount = resolveMercadoLivrePromotionFeeDiscount({
    marketplace: "mercado_livre",
    rawPromotion: raw,
    buyer_final_price_brl: buyerFinal,
    gross_sale_fee_brl: contract.marketplace_fee_gross_brl ?? null,
    shipping_cost_brl: contract.freight_cost_brl ?? null,
    official_amount_to_receive_brl:
      contract.seller_receives_brl ?? raw.amount_to_receive ?? raw.amount_to_receive_with_discount ?? null,
    listing_id: meta.listing_id ?? contract.listing_id ?? null,
    promotion_id: meta.promotion_id ?? contract.promotion_id ?? null,
    promotion_name: meta.promotion_name ?? contract.promotion_name ?? null,
    listing_type: meta.listing_type ?? null,
  });

  const funding = resolveMercadoLivrePromotionFunding({
    marketplace: "mercado_livre",
    rawPromotion: raw,
    originalPrice: contract.original_price_brl ?? contract.original_price,
    buyerFinalPrice: buyerFinal,
    listing_id: meta.listing_id ?? contract.listing_id ?? null,
    promotion_id: meta.promotion_id ?? contract.promotion_id ?? null,
    promotion_name: meta.promotion_name ?? contract.promotion_name ?? null,
    promotion_type: meta.promotion_type ?? contract.promotion_type ?? null,
  });

  const promotion_financial_adjustments = buildPromotionFinancialAdjustments({
    feeDiscount,
    priceFunding: funding,
  });

  return {
    ...contract,
    promotion_funding: funding,
    promotion_financial_adjustments,
    promotion_fee_discount: feeDiscount,
    buyer_final_price_brl: funding.buyer_final_price_brl ?? contract.buyer_final_price_brl ?? null,
    seller_discount_brl: funding.seller_discount_brl ?? null,
    marketplace_price_subsidy_brl: promotion_financial_adjustments.marketplace_price_subsidy_brl,
    marketplace_fee_discount_brl: promotion_financial_adjustments.marketplace_fee_discount_brl,
    seller_effective_price_brl: funding.seller_effective_price_brl ?? null,
    has_marketplace_subsidy: promotion_financial_adjustments.has_marketplace_price_subsidy === true,
    has_marketplace_fee_discount: promotion_financial_adjustments.has_marketplace_fee_discount === true,
  };
}
