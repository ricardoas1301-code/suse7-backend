// ======================================================
// Promoções ML — normalização oficial (GET /seller-promotions/items/:id?app_version=v2)
// Regra de negócio: id + type + ref_id | status started/pending/candidate
// ======================================================

import Decimal from "decimal.js";
import { mercadoLivreToFiniteGrid } from "../../handlers/ml/_helpers/mercadoLivreListingMoneyShared.js";

/** @param {unknown} field @param {unknown} value */
export function logS7MlPromosAudit(field, value) {
  if (process.env.NODE_ENV === "production" && process.env.S7_ML_PROMOS_AUDIT !== "1") return;
  console.info(`[S7_ML_PROMOS_AUDIT] ${field}`, value);
}

/** @param {string} stage @param {Record<string, unknown>} payload */
export function logS7PromotionsPiAudit(stage, payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info(`[S7_PROMOTIONS_PI_AUDIT] ${stage}`, payload);
}

/**
 * Chave composta oficial: id + type + ref_id (fallback seguro quando faltar campo).
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function buildOfficialSellerPromotionIdentityKey(row) {
  const id =
    row.id != null && String(row.id).trim() !== ""
      ? String(row.id).trim()
      : row.promotion_id != null && String(row.promotion_id).trim() !== ""
        ? String(row.promotion_id).trim()
        : "";
  const type =
    row.type != null && String(row.type).trim() !== ""
      ? String(row.type).trim()
      : row.promotion_type != null && String(row.promotion_type).trim() !== ""
        ? String(row.promotion_type).trim()
        : "";
  const refId =
    row.ref_id != null && String(row.ref_id).trim() !== ""
      ? String(row.ref_id).trim()
      : row.offer_id != null && String(row.offer_id).trim() !== ""
        ? String(row.offer_id).trim()
        : "";
  if (id !== "" || type !== "" || refId !== "") {
    return `${id}|${type}|${refId}`;
  }
  const status = row.status != null ? String(row.status).trim() : "";
  const start = row.start_date ?? row.start_time ?? row.starts_at ?? "";
  const finish = row.finish_date ?? row.end_date ?? row.finish_time ?? row.ends_at ?? "";
  const priceRef = row.suggested_discounted_price ?? row.price ?? "";
  return [id || row.promotion_id || "", type, refId || row.offer_id || "", status, start, finish, priceRef]
    .map((v) => (v != null ? String(v).trim() : ""))
    .join("|");
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function toIsoDateStringOrNull(v) {
  if (v == null || String(v).trim() === "") return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Classificação oficial ML → contrato Suse7 (sem inferir ATIVA).
 * @param {unknown} rawStatus
 * @returns {{
 *   normalized_status: string;
 *   ml_effective_state: "active" | "scheduled" | "participate";
 *   promotion_active: boolean;
 *   raw_status: string;
 * }}
 */
export function classifyOfficialMlSellerPromotionStatus(rawStatus) {
  const raw = rawStatus != null ? String(rawStatus).trim().toLowerCase() : "";
  if (raw === "started") {
    return {
      normalized_status: "active",
      ml_effective_state: "active",
      promotion_active: true,
      raw_status: "started",
    };
  }
  if (raw === "pending") {
    return {
      normalized_status: "scheduled",
      ml_effective_state: "scheduled",
      promotion_active: false,
      raw_status: "pending",
    };
  }
  if (raw === "candidate") {
    return {
      normalized_status: "candidate",
      ml_effective_state: "participate",
      promotion_active: false,
      raw_status: "candidate",
    };
  }
  if (raw !== "") {
    logS7MlPromosAudit("status_unknown_mapped_to_available", raw);
  }
  return {
    normalized_status: "candidate",
    ml_effective_state: "participate",
    promotion_active: false,
    raw_status: raw !== "" ? raw : "unknown",
  };
}

/**
 * Preço aplicado + referência (price=0 → suggested/min/max; visível mesmo sem preço final).
 * @param {Record<string, unknown>} row
 * @returns {{ final_price_brl: string | null; reference_price_brl: string | null; price_applied: boolean }}
 */
export function resolveOfficialSellerPromotionPrices(row) {
  const direct = mercadoLivreToFiniteGrid(row.price ?? row.amount ?? row.deal_price);
  const original =
    mercadoLivreToFiniteGrid(row.original_price ?? row.regular_amount ?? row.base_price) ?? null;

  if (direct != null && direct > 0) {
    return {
      final_price_brl: new Decimal(direct).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      reference_price_brl: original != null ? new Decimal(original).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
      price_applied: true,
    };
  }

  for (const field of ["suggested_discounted_price", "min_discounted_price", "max_discounted_price", "top_deal_price"]) {
    const v = mercadoLivreToFiniteGrid(row[field]);
    if (v != null && v > 0) {
      return {
        final_price_brl: new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        reference_price_brl:
          original != null ? new Decimal(original).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
        price_applied: false,
      };
    }
  }

  return {
    final_price_brl: null,
    reference_price_brl:
      original != null ? new Decimal(original).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
    price_applied: false,
  };
}

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

/** @param {Record<string, unknown>} row @returns {unknown} */
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

/** @param {Record<string, unknown>} row @returns {Decimal | null} */
function pickOriginalPriceDec(row) {
  const raw = pickFirstRaw(row, [
    "original_price",
    "regular_amount",
    "base_price",
    "list_price",
    "regular_price",
    "full_price",
  ]);
  return toDec(raw);
}

/**
 * Log unificado de rastreio financeiro por promoção (DEV).
 * @param {string} stage
 * @param {Record<string, unknown>} ctx
 */
export function logS7PiPromoFlowAudit(stage, ctx = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PI_PROMO_FLOW_AUDIT !== "1") return;
  console.info("[S7_PI_PROMO_FLOW_AUDIT]", { stage, ...ctx });
}

/**
 * @param {{
 *   promotion_name?: string | null;
 *   promotion_id?: string | null;
 *   type?: string | null;
 *   ref_id?: string | null;
 *   fin?: ReturnType<typeof resolveOfficialSellerPromotionFinancials> | null;
 *   row?: Record<string, unknown> | null;
 *   marketplace?: Record<string, unknown> | null;
 *   source_field_used?: string | null;
 * }} p
 */
export function buildPiPromoFlowAuditPayload(p) {
  const fin = p.fin ?? null;
  const audit =
    fin?.ml_financial_audit != null && typeof fin.ml_financial_audit === "object"
      ? fin.ml_financial_audit
      : {};
  const m = p.marketplace ?? {};
  const row = p.row ?? {};
  return {
    promotion_name:
      p.promotion_name ??
      row.promotion_name ??
      row.label ??
      row.name ??
      null,
    promotion_id: p.promotion_id ?? audit.promotion_id ?? row.promotion_id ?? row.id ?? null,
    type: p.type ?? audit.type ?? row.promotion_type ?? row.type ?? null,
    ref_id: p.ref_id ?? row.offer_id ?? row.ref_id ?? null,
    original_price: audit.original_price ?? m.original_price_brl ?? null,
    promotion_price: audit.promotion_price ?? m.sale_price_brl ?? null,
    seller_percentage: audit.seller_percentage ?? null,
    meli_percentage: audit.meli_percentage ?? null,
    discount_seller_brl: audit.discount_seller_brl ?? fin?.seller_discount_amount_brl ?? m.seller_discount_amount_brl ?? null,
    discount_seller_pct: audit.ml_discount_pct ?? fin?.seller_discount_percent ?? m.seller_discount_percent ?? null,
    discount_meli_brl: audit.discount_meli_brl ?? fin?.promotion_subsidy_amount_brl ?? m.promotion_subsidy_amount_brl ?? null,
    discount_meli_boost_amount: audit.discount_meli_boost_amount ?? null,
    fee_before_subsidy: m.fee_amount_before_promo_subsidy_brl ?? m.sale_fee_amount_brl ?? m.fee_amount_brl ?? null,
    fee_after_subsidy: m.fee_amount_after_promo_subsidy_brl ?? null,
    shipping_brl: m.shipping_cost_amount_brl ?? null,
    payout: m.marketplace_payout_amount_brl ?? m.net_receivable_brl ?? m.payout_after_promo_subsidy_brl ?? null,
    source_field_used: p.source_field_used ?? audit.discount_source ?? fin?.promotion_source ?? null,
  };
}

/** @param {Record<string, unknown>} row */
export function extractOfficialPromotionFinancialRawFields(row) {
  const r = row != null && typeof row === "object" ? row : {};
  const name = r.name ?? r.promotion_name ?? r.type ?? null;
  return {
    listing_external_id: r.item_id ?? r.external_listing_id ?? null,
    promotion_id: r.id ?? r.promotion_id ?? null,
    promotion_name: name != null ? String(name) : null,
    original_price: pickFirstRaw(r, ["original_price", "regular_amount", "base_price", "list_price"]),
    promotion_price: pickFirstRaw(r, ["price", "amount", "deal_price"]),
    discount_amount: pickFirstRaw(r, ["discount_amount", "total_discount_amount"]),
    discount_percent: pickFirstRaw(r, ["discount_percentage", "discount_percent", "total_discount_percentage"]),
    seller_discount_amount: pickFirstRaw(r, ["seller_discount_amount", "seller_funded_amount"]),
    marketplace_subsidy_amount: pickFirstRaw(r, [
      "marketplace_subsidy_amount",
      "meli_subsidy_amount",
      "meli_funded_amount",
    ]),
    fee_amount: pickFirstRaw(r, ["fee_amount", "sale_fee_amount", "charged_fee", "final_fee_amount"]),
    original_fee_amount: pickFirstRaw(r, ["original_fee_amount", "gross_fee_amount", "fee_amount_before_discount"]),
    final_fee_amount: pickFirstRaw(r, ["final_fee_amount", "charged_fee", "net_fee_amount", "sale_fee_net"]),
    fee_discount_amount: pickFirstRaw(r, [
      "fee_discount_amount",
      "fee_discount",
      "marketplace_fee_discount_amount",
      "charged_fee_discount",
      "meli_fee_discount",
      "commission_discount_amount",
      "discount_meli_boost_amount",
      "meli_boost_amount",
    ]),
    amount_to_receive: pickFirstRaw(r, [
      "amount_to_receive",
      "net_proceeds",
      "payout",
      "seller_amount",
      "you_receive_amount",
    ]),
    seller_percentage: pickFirstRaw(r, ["seller_percentage", "seller_discount_percentage", "seller_discount_percent"]),
    meli_percentage: pickFirstRaw(r, ["meli_percentage", "meli_discount_percentage", "meli_discount_percent"]),
    raw_relevant_keys: Object.keys(r).filter((k) =>
      /price|discount|fee|subsidy|boost|percentage|payout|receive|amount|charged|commission/i.test(k)
    ),
  };
}

/** @param {Record<string, unknown>} row @returns {Decimal | null} */
function resolveOfficialPromotionFeeDiscountDec(row) {
  const explicit = toDec(
    pickFirstRaw(row, [
      "discount_meli_boost_amount",
      "meli_boost_amount",
      "fee_discount_amount",
      "marketplace_fee_discount_amount",
      "charged_fee_discount",
      "fee_discount",
      "meli_fee_discount",
      "commission_discount_amount",
      "fee_discount_amount_brl",
    ])
  );
  if (explicit != null && explicit.gt(0)) return explicit;

  const grossFee = toDec(
    pickFirstRaw(row, ["original_fee_amount", "gross_fee_amount", "fee_amount_before_discount"])
  );
  const netFee = toDec(
    pickFirstRaw(row, ["final_fee_amount", "charged_fee", "net_fee_amount", "sale_fee_net", "sale_fee_amount"])
  );
  if (grossFee != null && netFee != null && grossFee.gte(netFee)) {
    const diff = grossFee.minus(netFee);
    return diff.gt(0) ? diff : null;
  }
  return null;
}

/**
 * Desconto bancado pelo seller — regra Suse7 (independente de subsídio ML / tarifa).
 * desconto = preço original catálogo do anúncio − preço promocional da campanha.
 *
 * @param {{
 *   catalogOriginalPriceBrl?: string | null;
 *   promotionPriceBrl?: string | null;
 *   rawRow?: Record<string, unknown>;
 *   listingExternalId?: string | null;
 *   promotionId?: string | null;
 *   promotionName?: string | null;
 * }} ctx
 */
export function resolveOfficialPromotionSellerDiscount(ctx) {
  const catalogOriginal = toDec(ctx.catalogOriginalPriceBrl);
  const promoPrice = toDec(ctx.promotionPriceBrl);
  const row = ctx.rawRow != null && typeof ctx.rawRow === "object" ? ctx.rawRow : {};

  const rawAmount = pickFirstRaw(row, ["discount_amount", "total_discount_amount", "seller_discount_amount"]);
  const rawPercent = pickFirstRaw(row, ["discount_percentage", "discount_percent", "total_discount_percentage"]);

  const calculatedAmount =
    catalogOriginal != null && promoPrice != null && catalogOriginal.gt(promoPrice)
      ? catalogOriginal.minus(promoPrice)
      : null;
  const calculatedPercent =
    calculatedAmount != null && catalogOriginal != null && catalogOriginal.gt(0)
      ? calculatedAmount.times(100).div(catalogOriginal)
      : null;
  const displayPercent =
    calculatedPercent != null
      ? String(Math.round(calculatedPercent.toDecimalPlaces(4, ROUND).toNumber()))
      : null;

  let chosenAmount = calculatedAmount;
  let chosenPercent = displayPercent;
  let chosenSource = "catalog_original_minus_promotion_price";

  const rawAmountDec = toDec(rawAmount);
  if (
    rawAmountDec != null &&
    calculatedAmount != null &&
    rawAmountDec.minus(calculatedAmount).abs().lte(0.02)
  ) {
    chosenAmount = rawAmountDec;
    chosenSource = "api_discount_amount_consistent";
  } else if (rawAmountDec != null && calculatedAmount == null) {
    chosenAmount = rawAmountDec;
    chosenSource = "api_discount_amount_only";
  }

  const rawPctDec = toDec(rawPercent);
  if (rawPctDec != null && displayPercent != null) {
    const rawRounded = String(Math.round(rawPctDec.toNumber()));
    if (rawRounded === displayPercent || rawPctDec.minus(Number(displayPercent)).abs().lte(0.51)) {
      chosenPercent = rawRounded;
      if (chosenSource === "api_discount_amount_consistent") {
        chosenSource = "api_discount_amount_and_percent_consistent";
      } else if (chosenSource === "catalog_original_minus_promotion_price") {
        chosenSource = "api_discount_percent_consistent_with_gap";
      }
    }
  }

  const consistencyCheck =
    catalogOriginal != null && promoPrice != null ? decStr2(catalogOriginal.minus(promoPrice)) : null;

  const auditPayload = {
    listing_external_id: ctx.listingExternalId ?? null,
    promotion_id: ctx.promotionId ?? row.id ?? row.promotion_id ?? null,
    promotion_name: ctx.promotionName ?? row.name ?? row.promotion_name ?? null,
    original_price_brl:
      catalogOriginal != null ? decStr2(catalogOriginal) : ctx.catalogOriginalPriceBrl ?? null,
    promotion_price_brl: promoPrice != null ? decStr2(promoPrice) : ctx.promotionPriceBrl ?? null,
    raw_discount_amount: rawAmount ?? null,
    raw_discount_percent: rawPercent ?? null,
    calculated_discount_amount: calculatedAmount != null ? decStr2(calculatedAmount) : null,
    calculated_discount_percent: calculatedPercent != null ? decStr2(calculatedPercent) : null,
    display_discount_percent: displayPercent,
    chosen_discount_amount: chosenAmount != null ? decStr2(chosenAmount) : null,
    chosen_discount_percent: chosenPercent,
    chosen_source: chosenSource,
    consistency_check: consistencyCheck,
  };
  logS7PromotionsPiAudit("seller_discount_resolution", auditPayload);

  const chosenPercentStr =
    chosenPercent != null ? `${chosenPercent}.00` : calculatedPercent != null ? decStr2(calculatedPercent) : null;

  return {
    seller_discount_amount_brl: chosenAmount != null ? decStr2(chosenAmount) : null,
    seller_discount_percent: chosenPercentStr,
    seller_discount_percent_display: chosenPercent,
    discount_source: chosenSource,
    audit: auditPayload,
  };
}

/**
 * Desconto seller / subsídio ML a partir do payload oficial GET /seller-promotions/items.
 *
 * Separação obrigatória:
 * - discount_seller_brl: desconto comercial de preço (fecha original − promo).
 * - fee_discount_brl / promotion_subsidy_amount_brl: redução de tarifa ML (NUNCA meli_percentage × preço).
 * - discount_total_brl: original − promotion_price (referência).
 *
 * @param {Record<string, unknown>} row
 * @param {string | null | undefined} promoPriceBrl
 * @param {string | null | undefined} referencePriceBrl
 */
export function resolveOfficialSellerPromotionFinancials(row, promoPriceBrl, referencePriceBrl) {
  const promo =
    promoPriceBrl != null && String(promoPriceBrl).trim() !== ""
      ? toDec(promoPriceBrl)
      : toDec(row.price ?? row.amount ?? row.deal_price);

  const meliPctRaw = pickFirstRaw(row, ["meli_percentage", "meli_discount_percentage", "meli_discount_percent"]);
  const meliPct =
    meliPctRaw != null && String(meliPctRaw).trim() !== "" ? toDec(meliPctRaw) : null;
  const catalogOriginalDec = toDec(referencePriceBrl) ?? pickOriginalPriceDec(row);

  /** Redução de tarifa ML — somente campos oficiais de fee discount (nunca meli_percentage × preço). */
  const feeDiscountDec = resolveOfficialPromotionFeeDiscountDec(row);
  let feeDiscountSource = feeDiscountDec != null ? "official_fee_discount_field" : null;
  if (feeDiscountDec != null && pickFirstRaw(row, ["discount_meli_boost_amount", "meli_boost_amount"]) != null) {
    feeDiscountSource = "discount_meli_boost_amount";
  }

  /** Co-financiamento de preço (audit only — não entra como subsídio de tarifa). */
  const meliPriceCoFundingDec =
    meliPct != null && catalogOriginalDec != null && catalogOriginalDec.gt(0)
      ? catalogOriginalDec.times(meliPct).div(100)
      : null;

  const sellerResolved = resolveOfficialPromotionSellerDiscount({
    catalogOriginalPriceBrl:
      referencePriceBrl != null && String(referencePriceBrl).trim() !== ""
        ? String(referencePriceBrl).trim()
        : catalogOriginalDec != null
          ? decStr2(catalogOriginalDec)
          : null,
    promotionPriceBrl: promo != null ? decStr2(promo) : promoPriceBrl ?? null,
    rawRow: row,
    promotionId: row.id != null ? String(row.id) : row.promotion_id != null ? String(row.promotion_id) : null,
    promotionName:
      row.name != null
        ? String(row.name)
        : row.promotion_name != null
          ? String(row.promotion_name)
          : null,
  });

  const boostedOffer = row.boosted_offer === true;
  const totalBoosted = toDec(row.total_price_for_boosted_offer);
  const feeDiscountBrl = feeDiscountDec != null ? decStr2(feeDiscountDec) : null;
  const sellerPctRaw = pickFirstRaw(row, [
    "seller_percentage",
    "seller_discount_percentage",
    "seller_discount_percent",
  ]);

  return {
    promotion_subsidy_amount_brl: feeDiscountBrl,
    fee_discount_brl: feeDiscountBrl,
    seller_discount_amount_brl: sellerResolved.seller_discount_amount_brl,
    seller_discount_percent: sellerResolved.seller_discount_percent,
    seller_discount_percent_display: sellerResolved.seller_discount_percent_display,
    promotion_source: `ml_seller_promotions_api:${sellerResolved.discount_source}`,
    is_promotion_estimated: sellerResolved.discount_source === "catalog_original_minus_promotion_price",
    ml_financial_audit: {
      promotion_id: row.id ?? row.promotion_id ?? null,
      type: row.type ?? row.promotion_type ?? null,
      original_price: sellerResolved.audit.original_price_brl,
      promotion_price: sellerResolved.audit.promotion_price_brl,
      seller_percentage: sellerPctRaw ?? null,
      meli_percentage: meliPctRaw ?? null,
      discount_seller_brl: sellerResolved.seller_discount_amount_brl,
      discount_meli_brl: feeDiscountBrl,
      discount_meli_price_co_funding_brl:
        meliPriceCoFundingDec != null ? decStr2(meliPriceCoFundingDec) : null,
      discount_total_brl: sellerResolved.audit.consistency_check,
      boosted_offer: boostedOffer,
      discount_meli_boost_amount:
        pickFirstRaw(row, ["discount_meli_boost_amount", "meli_boost_amount"]) ?? null,
      total_price_for_boosted_offer: totalBoosted != null ? decStr2(totalBoosted) : null,
      fee_discount_brl: feeDiscountBrl,
      fee_discount_source: feeDiscountSource,
      meli_subsidy_source: feeDiscountSource,
      discount_source: sellerResolved.discount_source,
      ml_discount_brl: sellerResolved.seller_discount_amount_brl,
      ml_discount_pct: sellerResolved.seller_discount_percent,
      seller_discount_resolution: sellerResolved.audit,
      amount_to_receive: pickFirstRaw(row, ["amount_to_receive", "net_proceeds", "payout"]) ?? null,
    },
  };
}

/**
 * Fecha payout/subídio de tarifa quando temos tarifa bruta do cenário + raw da promoção.
 * @param {{
 *   grossFeeBrl?: string | null;
 *   salePriceBrl?: string | null;
 *   shippingCostBrl?: string | null;
 *   fin?: ReturnType<typeof resolveOfficialSellerPromotionFinancials> | null;
 *   rawRow?: Record<string, unknown> | null;
 * }} ctx
 */
export function resolveOfficialPromotionPresentationFinancials(ctx) {
  const priceDec = toDec(ctx.salePriceBrl);
  const grossFee = toDec(ctx.grossFeeBrl);
  const shipDec = toDec(ctx.shippingCostBrl);
  const fin = ctx.fin ?? null;
  const rawRow = ctx.rawRow != null && typeof ctx.rawRow === "object" ? ctx.rawRow : {};

  let feeDiscount = toDec(fin?.fee_discount_brl ?? fin?.promotion_subsidy_amount_brl);
  let feeDiscountSource = fin?.ml_financial_audit?.fee_discount_source ?? "normalized_financials";

  const officialPayout = toDec(
    pickFirstRaw(rawRow, ["amount_to_receive", "net_proceeds", "payout", "seller_amount", "you_receive_amount"])
  );

  if (feeDiscount == null && grossFee != null && officialPayout != null && priceDec != null && shipDec != null) {
    const impliedNetFee = priceDec.minus(officialPayout).minus(shipDec);
    if (impliedNetFee.gte(0) && impliedNetFee.lte(grossFee.plus(0.02))) {
      feeDiscount = grossFee.minus(impliedNetFee);
      feeDiscountSource = "derived_from_amount_to_receive";
    }
  }

  if (feeDiscount == null && grossFee != null) {
    const derived = resolveOfficialPromotionFeeDiscountDec(rawRow);
    if (derived != null) {
      feeDiscount = derived;
      feeDiscountSource = "raw_row_fee_discount_fields";
    }
  }

  const grossFeeStr = grossFee != null ? decStr2(grossFee) : null;
  const feeDiscountStr = feeDiscount != null ? decStr2(feeDiscount) : null;
  const netFeeDec =
    grossFee != null && feeDiscount != null
      ? Decimal.max(0, grossFee.minus(feeDiscount))
      : grossFee;

  let expectedPayout = officialPayout;
  let calculatedPayout = null;
  if (priceDec != null && grossFee != null && shipDec != null) {
    calculatedPayout = priceDec.minus(grossFee).plus(feeDiscount ?? new Decimal(0)).minus(shipDec);
    if (expectedPayout == null) expectedPayout = calculatedPayout;
  }

  const payoutDiff =
    expectedPayout != null && calculatedPayout != null
      ? expectedPayout.minus(calculatedPayout).abs()
      : null;

  return {
    gross_fee_brl: grossFeeStr,
    fee_discount_brl: feeDiscountStr,
    net_fee_brl: netFeeDec != null ? decStr2(netFeeDec) : null,
    shipping_cost_brl: shipDec != null ? decStr2(shipDec) : ctx.shippingCostBrl ?? null,
    seller_discount_brl: fin?.seller_discount_amount_brl ?? null,
    marketplace_subsidy_brl: feeDiscountStr,
    expected_payout_brl: expectedPayout != null ? decStr2(expectedPayout) : null,
    calculated_payout_brl: calculatedPayout != null ? decStr2(calculatedPayout) : null,
    payout_diff_brl: payoutDiff != null && payoutDiff.gt(0.02) ? decStr2(payoutDiff) : "0.00",
    fee_discount_source: feeDiscountSource,
    sale_price_brl: priceDec != null ? decStr2(priceDec) : ctx.salePriceBrl ?? null,
    original_price_brl: fin?.ml_financial_audit?.original_price ?? null,
    final_price_brl: priceDec != null ? decStr2(priceDec) : ctx.salePriceBrl ?? null,
  };
}

/** @param {Record<string, unknown>} row @param {ReturnType<typeof resolveOfficialSellerPromotionFinancials>} fin @param {Record<string, unknown>} marketplace */
export function logS7PiPromoFinAuditDeep(row, fin, marketplace = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PI_PROMO_FIN_AUDIT !== "1") return;
  const audit =
    fin?.ml_financial_audit != null && typeof fin.ml_financial_audit === "object"
      ? fin.ml_financial_audit
      : {};
  const m = marketplace;
  const feeBefore =
    m.fee_amount_before_promo_subsidy_brl ?? m.sale_fee_amount_brl ?? m.fee_amount_brl ?? null;
  const feeAfter = m.fee_amount_after_promo_subsidy_brl ?? null;
  const payoutBefore = m.payout_before_promo_subsidy_brl ?? null;
  const payoutAfter =
    m.marketplace_payout_amount_brl ?? m.net_receivable_brl ?? m.payout_after_promo_subsidy_brl ?? null;

  console.info("[S7_PI_PROMO_FIN_AUDIT_DEEP]", {
    promotion_id: audit.promotion_id ?? row.promotion_id ?? null,
    type: audit.type ?? row.promotion_type ?? null,
    original_price: audit.original_price ?? null,
    promotion_price: audit.promotion_price ?? null,
    seller_percentage: audit.seller_percentage ?? null,
    meli_percentage: audit.meli_percentage ?? null,
    discount_seller_brl: audit.discount_seller_brl ?? fin?.seller_discount_amount_brl ?? null,
    discount_meli_brl: audit.discount_meli_brl ?? fin?.promotion_subsidy_amount_brl ?? null,
    discount_total_brl: audit.discount_total_brl ?? null,
    boosted_offer: audit.boosted_offer ?? null,
    discount_meli_boost_amount: audit.discount_meli_boost_amount ?? null,
    total_price_for_boosted_offer: audit.total_price_for_boosted_offer ?? null,
    fee_before_subsidy: feeBefore,
    fee_after_subsidy: feeAfter,
    payout_before_subsidy: payoutBefore,
    payout_after_subsidy: payoutAfter,
    meli_subsidy_source: audit.meli_subsidy_source ?? null,
    discount_source: audit.discount_source ?? null,
  });
}

/**
 * @param {Record<string, unknown>} row
 * @param {{ source?: "live" | "persisted" }} [opts]
 */
export function normalizeOfficialSellerPromotionRow(row, opts = {}) {
  const source = opts.source === "persisted" ? "persisted" : "live";
  const promotionId =
    row.id != null && String(row.id).trim() !== ""
      ? String(row.id).trim()
      : row.promotion_id != null && String(row.promotion_id).trim() !== ""
        ? String(row.promotion_id).trim()
        : "";
  const promotionType =
    row.type != null && String(row.type).trim() !== ""
      ? String(row.type).trim()
      : row.promotion_type != null && String(row.promotion_type).trim() !== ""
        ? String(row.promotion_type).trim()
        : null;
  const offerId =
    row.ref_id != null && String(row.ref_id).trim() !== ""
      ? String(row.ref_id).trim()
      : row.offer_id != null && String(row.offer_id).trim() !== ""
        ? String(row.offer_id).trim()
        : null;
  const statusPack = classifyOfficialMlSellerPromotionStatus(row.status);
  const prices = resolveOfficialSellerPromotionPrices(row);
  const nameRaw = row.name ?? row.promotion_name ?? row.type ?? row.promotion_type;
  const promotionName =
    nameRaw != null && String(nameRaw).trim() !== ""
      ? String(nameRaw).trim()
      : promotionId !== ""
        ? `Promoção ${promotionId}`
        : "Promoção";

  const financials = resolveOfficialSellerPromotionFinancials(
    row,
    prices.final_price_brl,
    prices.reference_price_brl
  );

  return {
    promotion_id: promotionId,
    promotion_type: promotionType,
    offer_id: offerId,
    promotion_name: promotionName,
    final_price_brl: prices.final_price_brl,
    reference_price_brl: prices.reference_price_brl,
    price_applied: prices.price_applied,
    status: statusPack.normalized_status,
    raw_status: statusPack.raw_status,
    ml_effective_state: statusPack.ml_effective_state,
    promotion_active: statusPack.promotion_active,
    starts_at: toIsoDateStringOrNull(
      row.start_date ?? row.start_time ?? row.date_from ?? row.starts_at
    ),
    ends_at: toIsoDateStringOrNull(
      row.finish_date ?? row.end_date ?? row.date_to ?? row.finish_time ?? row.ends_at ?? row.stop_time
    ),
    source,
    identity_key: buildOfficialSellerPromotionIdentityKey(row),
    financials,
    ml_api_raw_row: row,
  };
}

/**
 * Normaliza e deduplica linhas brutas do endpoint oficial (1 linha API → no máximo 1 candidato).
 * @param {Record<string, unknown>[]} rawRows
 * @param {{ source?: "live" | "persisted" }} [opts]
 */
export function normalizeOfficialSellerPromotionsFromApi(rawRows, opts = {}) {
  /** @type {Map<string, ReturnType<typeof normalizeOfficialSellerPromotionRow>>} */
  const byIdentity = new Map();
  let droppedAsDuplicate = 0;
  const list = Array.isArray(rawRows) ? rawRows : [];

  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const normalized = normalizeOfficialSellerPromotionRow(/** @type {Record<string, unknown>} */ (row), opts);
    if (normalized.promotion_id === "" && normalized.identity_key.replace(/\|/g, "") === "") continue;
    const prev = byIdentity.get(normalized.identity_key);
    if (prev != null) {
      droppedAsDuplicate += 1;
      if (normalized.source === "live" && prev.source !== "live") {
        byIdentity.set(normalized.identity_key, normalized);
      }
      continue;
    }
    byIdentity.set(normalized.identity_key, normalized);
  }

  const out = Array.from(byIdentity.values());
  const statusCounts = out.reduce(
    (acc, p) => {
      const k = p.raw_status != null ? String(p.raw_status) : "unknown";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    },
    /** @type {Record<string, number>} */ ({})
  );

  return {
    promotions: out,
    normalized_total: out.length,
    dropped_as_duplicate: droppedAsDuplicate,
    status_counts: statusCounts,
    identity_keys: out.map((p) => p.identity_key),
  };
}

/**
 * Elegibilidade UI — somente status oficiais ML (started/pending/candidate) + desconhecido com log.
 * @param {{ raw_status?: string | null; ends_at?: string | null }} p
 */
export function evaluateOfficialPromotionUiEligibility(p) {
  const raw = p.raw_status != null ? String(p.raw_status).trim().toLowerCase() : "";
  if (raw === "finished" || raw === "expired" || raw === "cancelled" || raw === "inactive") {
    return { ok: false, reason: "expired" };
  }
  if (raw === "started" || raw === "pending" || raw === "candidate") {
    if (p.ends_at != null && String(p.ends_at).trim() !== "") {
      const tEnd = Date.parse(String(p.ends_at));
      if (Number.isFinite(tEnd) && tEnd < Date.now()) return { ok: false, reason: "expired" };
    }
    return { ok: true };
  }
  if (raw !== "" && raw !== "unknown") {
    logS7MlPromosAudit("status_unknown_included", raw);
  }
  return { ok: true };
}
