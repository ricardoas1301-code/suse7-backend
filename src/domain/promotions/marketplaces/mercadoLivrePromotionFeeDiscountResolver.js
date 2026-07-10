// ======================================================
// Promoções ML — redução de tarifa/comissão (≠ subsídio de preço).
// Decimal.js — reconciliação controlada com amount_to_receive oficial.
// ======================================================

import Decimal from "decimal.js";

const ROUND = Decimal.ROUND_HALF_UP;
const TOLERANCIA_BRL = new Decimal("0.02");

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

/**
 * @param {Record<string, unknown>} src
 * @param {string[]} keys
 * @returns {Decimal | null}
 */
function pickAmountDec(src, keys) {
  for (const key of keys) {
    const d = toDec(src[key]);
    if (d != null && d.gt(0)) return d;
  }
  return null;
}

/** @param {Record<string, unknown>} row @returns {Decimal | null} */
export function pickOfficialFeeDiscountDecFromRaw(row) {
  const explicit = pickAmountDec(row, [
    "fee_discount_amount",
    "discount_fee_amount",
    "sale_fee_discount",
    "fee_discount",
    "marketplace_fee_discount_amount",
    "charged_fee_discount",
    "meli_fee_discount",
    "commission_discount_amount",
    "fee_discount_amount_brl",
    "campaign_fee_discount",
    "discount_meli_boost_amount",
    "meli_boost_amount",
  ]);
  if (explicit != null) return explicit;

  const grossFee = pickAmountDec(row, [
    "original_fee_amount",
    "gross_fee_amount",
    "fee_amount_before_discount",
  ]);
  const netFee = pickAmountDec(row, [
    "final_fee_amount",
    "charged_fee",
    "net_fee_amount",
    "sale_fee_net",
  ]);
  if (grossFee != null && netFee != null && grossFee.gte(netFee)) {
    const diff = grossFee.minus(netFee);
    return diff.gt(0) ? diff : null;
  }
  return null;
}

/**
 * fee_discount = amount_to_receive - buyer_final + gross_sale_fee + shipping_cost
 *
 * @param {{
 *   marketplace?: string;
 *   rawPromotion?: Record<string, unknown> | null;
 *   buyer_final_price_brl?: unknown;
 *   gross_sale_fee_brl?: unknown;
 *   shipping_cost_brl?: unknown;
 *   official_amount_to_receive_brl?: unknown;
 *   listing_id?: string | null;
 *   promotion_id?: string | null;
 *   promotion_name?: string | null;
 *   listing_type?: string | null;
 * }} params
 */
export function resolveMercadoLivrePromotionFeeDiscount(params = {}) {
  const raw =
    params.rawPromotion != null && typeof params.rawPromotion === "object"
      ? /** @type {Record<string, unknown>} */ (params.rawPromotion)
      : /** @type {Record<string, unknown>} */ ({});

  const buyerDec =
    toDec(params.buyer_final_price_brl) ??
    pickAmountDec(raw, ["price", "amount", "deal_price", "buyer_final_price_brl", "final_price_brl"]);
  const grossFeeDec =
    toDec(params.gross_sale_fee_brl) ??
    pickAmountDec(raw, ["original_fee_amount", "gross_fee_amount", "fee_amount", "sale_fee_amount"]);
  const shipDec =
    toDec(params.shipping_cost_brl) ??
    pickAmountDec(raw, ["shipping_cost", "shipping_cost_amount", "shipping_amount"]);
  const officialReceiveDec =
    toDec(params.official_amount_to_receive_brl) ??
    pickAmountDec(raw, [
      "amount_to_receive",
      "amount_to_receive_with_discount",
      "net_proceeds",
      "payout",
      "seller_amount",
      "you_receive_amount",
    ]);

  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const source_trace = [];

  let feeDiscountDec = pickOfficialFeeDiscountDecFromRaw(raw);
  let source = feeDiscountDec != null ? "official_payload_fee_discount_field" : "none";
  let confidence = feeDiscountDec != null ? "high" : "medium";

  if (feeDiscountDec != null) {
    source_trace.push("priority_1:explicit_fee_discount_field");
  }

  if (
    (feeDiscountDec == null || !feeDiscountDec.gt(0)) &&
    officialReceiveDec != null &&
    buyerDec != null &&
    grossFeeDec != null &&
    shipDec != null
  ) {
    const inferred = officialReceiveDec.minus(buyerDec).plus(grossFeeDec).plus(shipDec);
    if (inferred.gt(0)) {
      feeDiscountDec = inferred.toDecimalPlaces(2, ROUND);
      source = "amount_to_receive_reconciliation";
      source_trace.push("priority_2:amount_to_receive_reconciliation");
      confidence = "high";
    }
  }

  if (feeDiscountDec == null || !feeDiscountDec.gt(0)) {
    feeDiscountDec = new Decimal(0);
    source = "none";
    confidence = "high";
  } else {
    feeDiscountDec = feeDiscountDec.toDecimalPlaces(2, ROUND);
  }

  let calculatedReceiveDec = null;
  if (buyerDec != null && grossFeeDec != null && shipDec != null) {
    calculatedReceiveDec = buyerDec.minus(grossFeeDec).plus(feeDiscountDec).minus(shipDec).toDecimalPlaces(2, ROUND);
  }

  if (
    officialReceiveDec != null &&
    calculatedReceiveDec != null &&
    officialReceiveDec.minus(calculatedReceiveDec).abs().gt(TOLERANCIA_BRL)
  ) {
    warnings.push("payout_reconciliation_exceeds_tolerance");
    source_trace.push("warning:official_amount_to_receive_priority");
  }

  const payoutDec = officialReceiveDec ?? calculatedReceiveDec;

  const result = {
    marketplace: "mercado_livre",
    buyer_final_price_brl: buyerDec != null ? decStr2(buyerDec) : null,
    gross_sale_fee_brl: grossFeeDec != null ? decStr2(grossFeeDec) : null,
    shipping_cost_brl: shipDec != null ? decStr2(shipDec) : null,
    official_amount_to_receive_brl: officialReceiveDec != null ? decStr2(officialReceiveDec) : null,
    marketplace_fee_discount_brl: decStr2(feeDiscountDec),
    calculated_amount_to_receive_brl: calculatedReceiveDec != null ? decStr2(calculatedReceiveDec) : null,
    has_marketplace_fee_discount: feeDiscountDec.gt(0),
    fee_discount_source: source,
    fee_discount_source_trace: source_trace,
    confidence,
    warnings,
  };

  logPromotionFeeDiscountResolver({
    listing_id: params.listing_id ?? raw.item_id ?? raw.listing_id ?? null,
    promotion_id: params.promotion_id ?? raw.id ?? raw.promotion_id ?? null,
    promotion_name: params.promotion_name ?? raw.name ?? raw.promotion_name ?? null,
    listing_type: params.listing_type ?? null,
    fee_discount: result,
  });

  return result;
}

/**
 * @param {{
 *   listing_id?: unknown;
 *   promotion_id?: unknown;
 *   promotion_name?: unknown;
 *   listing_type?: unknown;
 *   fee_discount: Record<string, unknown>;
 * }} payload
 */
export function logPromotionFeeDiscountResolver(payload) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  const f = payload.fee_discount ?? {};
  console.info("[S7_PROMOTION_FEE_DISCOUNT_RESOLVER]", {
    listing_id: payload.listing_id ?? null,
    promotion_id: payload.promotion_id ?? null,
    promotion_name: payload.promotion_name ?? null,
    listing_type: payload.listing_type ?? null,
    buyer_final_price_brl: f.buyer_final_price_brl ?? null,
    gross_sale_fee_brl: f.gross_sale_fee_brl ?? null,
    shipping_cost_brl: f.shipping_cost_brl ?? null,
    official_amount_to_receive_brl: f.official_amount_to_receive_brl ?? null,
    marketplace_fee_discount_brl: f.marketplace_fee_discount_brl ?? null,
    calculated_amount_to_receive_brl: f.calculated_amount_to_receive_brl ?? null,
    source: f.fee_discount_source ?? null,
    confidence: f.confidence ?? null,
    warnings: f.warnings ?? [],
  });
}

/**
 * Contrato normalizado PI — separa redução de tarifa vs subsídio de preço.
 *
 * @param {{
 *   feeDiscount: ReturnType<typeof resolveMercadoLivrePromotionFeeDiscount>;
 *   priceFunding: Record<string, unknown> | null;
 * }} ctx
 */
export function buildPromotionFinancialAdjustments(ctx) {
  const fee = ctx.feeDiscount ?? {};
  const funding = ctx.priceFunding ?? {};
  const feeBrl = toDec(fee.marketplace_fee_discount_brl) ?? new Decimal(0);
  const priceSubBrl = toDec(funding.marketplace_subsidy_brl) ?? new Decimal(0);
  const hasFee = feeBrl.gt(0);
  const hasPriceSub = priceSubBrl.gt(0) && funding.has_marketplace_subsidy === true;

  return {
    marketplace_price_subsidy_brl: hasPriceSub ? decStr2(priceSubBrl) : "0.00",
    marketplace_fee_discount_brl: decStr2(feeBrl),
    marketplace_fee_discount_label: "Reduzimos sua tarifa",
    has_marketplace_fee_discount: hasFee,
    has_marketplace_price_subsidy: hasPriceSub,
    fee_discount_source: fee.fee_discount_source ?? "none",
    price_subsidy_source: hasPriceSub ? funding.subsidy_source ?? null : null,
    official_amount_to_receive_brl: fee.official_amount_to_receive_brl ?? null,
    calculated_amount_to_receive_brl: fee.calculated_amount_to_receive_brl ?? null,
    warnings: [...(fee.warnings ?? []), ...(funding.warnings ?? [])],
  };
}
