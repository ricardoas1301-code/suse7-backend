// ======================================================
// DOMAIN — custo de envio oficial Mercado Livre (Suse7)
// ======================================================
// Valor oficial (Raio-X ML): prioridade sale−fee−net (GAP) quando válido; depois listing_prices
// (sale_fee_details / linha); item.shipping; health. shipping_options/free é só simulação auxiliar.
// Sem faixas de preço, sem “taxa fixa” separada: o painel ML usa sempre o rótulo
// “Custo de envio do Mercado Livre” — espelhamos isso no contrato persistido/API.
// ======================================================

import Decimal from "decimal.js";
import { normalizeMoneyToDecimal } from "./pricingGuards.js";
import {
  logPricingEvent,
  PRICING_EVENT_CODE,
  PRICING_LOG_LEVEL,
} from "./pricingInconsistencyLog.js";

const ROUND = Decimal.ROUND_HALF_UP;
const EPS_GAP = new Decimal("0.04");
const MIN_SUSPICIOUS_SHIPPING_BRL = new Decimal("2.00");

/** IDs de anúncio para trace explícito de candidatos de frete (grep no log). `ML_SHIPPING_COST_TRACE=1` loga todos. */
const SHIPPING_COST_TRACE_LISTING_IDS = /** @type {const} */ (["MLB4229175299", "MLB6087428866"]);

/**
 * @param {string | null | undefined} id
 * @returns {string | null}
 */
function normalizeMercadoLivreListingIdForTrace(id) {
  if (id == null || String(id).trim() === "") return null;
  const s = String(id).trim().toUpperCase().replace(/\s/g, "");
  if (/^MLB\d+$/.test(s)) return s;
  const digits = s.replace(/^MLB/i, "");
  return /^\d+$/.test(digits) ? `MLB${digits}` : s;
}

/**
 * @param {string | null} listing_id
 * @returns {boolean}
 */
function shouldEmitShippingCostCandidatesTrace(listing_id) {
  if (process.env.ML_SHIPPING_COST_TRACE === "1") return true;
  const n = normalizeMercadoLivreListingIdForTrace(listing_id);
  return n != null && SHIPPING_COST_TRACE_LISTING_IDS.includes(n);
}

/** Rótulo fixo alinhado ao painel do vendedor ML (Raio-X). */
export const ML_SHIPPING_COST_OFFICIAL_LABEL = "Custo de envio do Mercado Livre";

/**
 * @typedef {"free_for_buyer" | "buyer_pays"} MercadoLivreShippingBuyerContext
 */

/**
 * @typedef {Object} MercadoLivreShippingCostOfficialResult
 * @property {string} label
 * @property {MercadoLivreShippingBuyerContext} context
 * @property {string | null} amount_brl — oficial (2 casas) ou null
 * @property {string | null} auxiliary_amount_brl — simulação shipping_options/free (não canônica)
 * @property {"ml_shipping_options_free_simulation" | null} auxiliary_source
 * @property {"ml_listing_prices_logistics" | "ml_payload" | "health_column" | "net_receivable_gap" | "ml_shipping_options_free_simulation" | "unresolved"} source
 * @property {string} decision_source
 * @property {string[]} inconsistency_codes
 */

/**
 * A partir de `item.shipping.free_shipping` (boolean ML).
 *
 * @param {unknown} freeShippingRaw
 * @returns {MercadoLivreShippingBuyerContext}
 */
export function resolveMercadoLivreShippingBuyerContext(freeShippingRaw) {
  if (freeShippingRaw === true) return "free_for_buyer";
  return "buyer_pays";
}

/**
 * @param {unknown} v
 * @returns {Decimal | null}
 */
function positiveMoneyDec(v) {
  const d = normalizeMoneyToDecimal(v);
  if (d == null || !d.isFinite() || d.lte(0)) return null;
  return d;
}

/**
 * ML costuma devolver `shipping.cost = 1.00` como placeholder não financeiro.
 * Para cálculo oficial, esse valor não é confiável.
 * @param {Decimal | null} amount
 */
function isValidShippingCost(amount) {
  if (amount == null || !amount.isFinite()) return false;
  if (amount.lte(1)) return false;
  return true;
}

/**
 * Resolver central: valor oficial + simulação auxiliar + telemetria.
 *
 * **Oficial (Raio-X / seller):**
 * 1) `fromOfficialMl` / `fromSaleFeeDetails` — linha GET `/sites/.../listing_prices` (`sale_fee_details` + scan)
 * 2) GAP — `sale − fee − net_receivable` quando válido e listing_prices não entregou frete
 * 3) `fromMlItem` — GET /items (`shipping.cost` confiável, não placeholder)
 * 4) `fromHealth` — coluna persistida anterior
 * 5) `fromShippingOptionsFree` — fallback estimado quando faltam fontes principais
 *
 * @param {{
 *   listing_id?: string | null;
 *   logContext?: string;
 *   shipping_logistic_type?: string | null;
 *   listing_status?: string | null;
 *   available_quantity?: number | null;
 *   fromShippingOptionsFree?: number | null;
 *   fromOfficialMl?: number | null;
 *   fromSaleFeeDetails?: number | null;
 *   fromMlItem?: number | null;
 *   fromHealth?: number | null;
 *   gap?: { sale: Decimal; fee: Decimal; net: Decimal } | null;
 *   free_shipping?: boolean | null;
 * }} input
 * @returns {MercadoLivreShippingCostOfficialResult}
 */
export function resolveMercadoLivreShippingCostOfficial(input) {
  const listing_id = input.listing_id != null ? String(input.listing_id) : null;
  const logContext = input.logContext ?? "resolve_mercado_livre_shipping_cost_official";

  /** @type {string[]} */
  const inconsistency_codes = [];

  const ctxBuyer =
    input.free_shipping === true
      ? /** @type {const} */ ("free_for_buyer")
      : input.free_shipping === false
        ? /** @type {const} */ ("buyer_pays")
        : /** @type {const} */ ("buyer_pays");

  if (input.free_shipping == null) {
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_CONTEXT_INFERRED_DEFAULT);
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.SHIPPING_CONTEXT_INFERRED_DEFAULT, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      message: "free_shipping ausente no payload — contexto tratado como buyer_pays",
    });
  } else {
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_CONTEXT_RESOLVED, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      free_shipping: input.free_shipping,
      resolved: ctxBuyer,
    });
  }

  /** @type {Decimal | null} */
  let amountDec = null;
  /** @type {"ml_listing_prices_logistics" | "ml_payload" | "health_column" | "net_receivable_gap" | "ml_shipping_options_free_simulation" | "unresolved"} */
  let source = "unresolved";
  /** @type {string} */
  let decision_source = "unresolved";
  let suspiciousLowRejected = false;

  const shipOptionsDec = positiveMoneyDec(input.fromShippingOptionsFree);
  const officialMlDec = positiveMoneyDec(input.fromOfficialMl);
  const detailsDec = positiveMoneyDec(input.fromSaleFeeDetails);
  const mlDecRaw = positiveMoneyDec(input.fromMlItem);
  const mlDec = isValidShippingCost(mlDecRaw) ? mlDecRaw : null;
  const healthDec = positiveMoneyDec(input.fromHealth);

  /** @returns {Decimal | null} */
  const impliedFromGap = () => {
    if (input.gap == null) return null;
    const { sale, fee, net } = input.gap;
    if (!sale.isFinite() || !fee.isFinite() || !net.isFinite() || net.lt(0) || net.gt(sale)) return null;
    const implied = sale.minus(fee).minus(net);
    if (!implied.gt(EPS_GAP)) return null;
    return implied.toDecimalPlaces(2, ROUND);
  };

  const gapDec = impliedFromGap();
  const logisticTypeRaw =
    input.shipping_logistic_type != null && String(input.shipping_logistic_type).trim() !== ""
      ? String(input.shipping_logistic_type).trim().toLowerCase()
      : null;
  const listingStatusRaw =
    input.listing_status != null && String(input.listing_status).trim() !== ""
      ? String(input.listing_status).trim().toLowerCase()
      : null;
  const availableQty =
    input.available_quantity != null && Number.isFinite(Number(input.available_quantity))
      ? Number(input.available_quantity)
      : null;
  /**
   * Rejeita frete muito baixo (ex.: 1.35) quando há evidência financeira forte de valor maior.
   * @param {Decimal | null} candidate
   * @param {string} candidateSource
   * @returns {boolean}
   */
  const shouldSkipSuspiciousLowCandidate = (candidate, candidateSource) => {
    if (candidate == null || !candidate.isFinite() || candidate.lte(0)) return false;
    if (candidate.gt(MIN_SUSPICIOUS_SHIPPING_BRL)) return false;
    const hasAuxAnchor =
      shipOptionsDec != null &&
      shipOptionsDec.isFinite() &&
      shipOptionsDec.gte(5) &&
      shipOptionsDec.gte(candidate.times(2));
    const hasGapAnchor =
      gapDec != null &&
      gapDec.isFinite() &&
      gapDec.gte(5) &&
      gapDec.gte(candidate.times(2));
    const fullLikeContext =
      logisticTypeRaw != null &&
      /(full|xd_drop_off|fulfillment|cross_docking|self_service_in|meli_full)/i.test(logisticTypeRaw);
    const freeForBuyerContext = input.free_shipping === true;
    const activeStockContext =
      listingStatusRaw === "active" && availableQty != null && Number.isFinite(availableQty) && availableQty > 0;
    const contextualImplausible = freeForBuyerContext || fullLikeContext || activeStockContext;
    if (!hasAuxAnchor && !hasGapAnchor && !contextualImplausible) return false;
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_INCONSISTENT_SKIPPED);
    suspiciousLowRejected = true;
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.SHIPPING_COST_INCONSISTENT_SKIPPED, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      source: candidateSource,
      candidate_amount_brl: candidate.toDecimalPlaces(2, ROUND).toFixed(2),
      auxiliary_amount_brl: shipOptionsDec?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      gap_amount_brl: gapDec?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      shipping_logistic_type: logisticTypeRaw,
      listing_status: listingStatusRaw,
      available_quantity: availableQty,
      has_aux_anchor: hasAuxAnchor,
      has_gap_anchor: hasGapAnchor,
      contextual_implausible: contextualImplausible,
      reason: "suspicious_low_shipping_candidate",
    });
    return true;
  };

  if (
    amountDec == null &&
    officialMlDec != null &&
    !shouldSkipSuspiciousLowCandidate(officialMlDec, "ml_listing_prices_logistics")
  ) {
    amountDec = officialMlDec;
    source = "ml_listing_prices_logistics";
    decision_source = "official_ml_shipping_field";
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_OFFICIAL_CANDIDATE_FOUND);
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_OFFICIAL_SELECTED);
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_OFFICIAL_CANDIDATE_FOUND, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      source_endpoint: "listing_prices",
      candidate_field: "listing_prices_row.sale_fee_details.logistics|row_deep_scan",
      candidate_value: amountDec.toDecimalPlaces(2, ROUND).toFixed(2),
      shipping_cost_context: ctxBuyer,
    });
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_OFFICIAL_SELECTED, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      selected_value: amountDec.toDecimalPlaces(2, ROUND).toFixed(2),
      shipping_cost_source: source,
      shipping_cost_context: ctxBuyer,
      sale_price_effective: input.gap?.sale?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      sale_fee_amount: input.gap?.fee?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      fixed_fee_amount: "0.00",
      net_receivable: input.gap?.net?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      shipping_options_free_alternate_brl:
        shipOptionsDec != null ? shipOptionsDec.toDecimalPlaces(2, ROUND).toFixed(2) : null,
    });
    if (gapDec != null && !gapDec.eq(officialMlDec.toDecimalPlaces(2, ROUND))) {
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_GAP_PRIORITY_OVER_LISTING_PRICES, {
        marketplace: "mercado_livre",
        listing_id,
        context: logContext,
        message:
          "Frete canônico por listing_prices (logística); GAP sale−fee−net diferente (referência)",
        listing_prices_shipping_brl: officialMlDec.toDecimalPlaces(2, ROUND).toFixed(2),
        gap_shipping_brl: gapDec.toFixed(2),
      });
    }
    if (shipOptionsDec != null && !officialMlDec.eq(shipOptionsDec)) {
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_VALUE_MISMATCH_WITH_OFFICIAL, {
        marketplace: "mercado_livre",
        listing_id,
        context: logContext,
        message:
          "frete oficial listing_prices (sale_fee_details / linha) como canônico; shipping_options/free diferente (auxiliar)",
        listing_prices_shipping_brl: officialMlDec.toDecimalPlaces(2, ROUND).toFixed(2),
        shipping_options_free_brl: shipOptionsDec.toDecimalPlaces(2, ROUND).toFixed(2),
      });
    }
    if (mlDecRaw != null && !officialMlDec.eq(mlDecRaw)) {
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_OFFICIAL_OVERRULED_ML_ITEM, {
        marketplace: "mercado_livre",
        listing_id,
        context: logContext,
        source_endpoint: "listing_prices",
        candidate_field: "item.shipping.cost",
        candidate_value: mlDecRaw.toDecimalPlaces(2, ROUND).toFixed(2),
        selected_value: officialMlDec.toDecimalPlaces(2, ROUND).toFixed(2),
      });
    }
  } else if (
    amountDec == null &&
    detailsDec != null &&
    !shouldSkipSuspiciousLowCandidate(detailsDec, "sale_fee_details_logistics")
  ) {
    amountDec = detailsDec;
    source = "ml_listing_prices_logistics";
    decision_source = "sale_fee_details_logistics_listing_prices_row";
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_FROM_SALE_FEE_DETAILS);
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_FROM_ML);
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_RESOLVED_FROM_ENRICH);
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_FROM_SALE_FEE_DETAILS, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      amount_brl: amountDec.toDecimalPlaces(2, ROUND).toFixed(2),
      path: "fromSaleFeeDetails",
    });
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_RESOLVED_FROM_ENRICH, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      source: "sale_fee_details",
      shipping_cost_amount: amountDec.toDecimalPlaces(2, ROUND).toFixed(2),
      shipping_cost_context: ctxBuyer,
      sale_price_effective: input.gap?.sale?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      sale_fee_amount: input.gap?.fee?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      fixed_fee_amount: "0.00",
      net_receivable: input.gap?.net?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
    });
    if (gapDec != null && !gapDec.eq(detailsDec.toDecimalPlaces(2, ROUND))) {
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_GAP_PRIORITY_OVER_LISTING_PRICES, {
        marketplace: "mercado_livre",
        listing_id,
        context: logContext,
        message:
          "Frete canônico por sale_fee_details (logística); GAP sale−fee−net diferente (referência)",
        sale_fee_details_logistics_brl: detailsDec.toDecimalPlaces(2, ROUND).toFixed(2),
        gap_shipping_brl: gapDec.toFixed(2),
      });
    }
    if (shipOptionsDec != null && !detailsDec.eq(shipOptionsDec)) {
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_VALUE_MISMATCH_WITH_OFFICIAL, {
        marketplace: "mercado_livre",
        listing_id,
        context: logContext,
        message:
          "sale_fee_details (logística) como canônico; shipping_options/free diferente (auxiliar)",
        listing_prices_shipping_brl: detailsDec.toDecimalPlaces(2, ROUND).toFixed(2),
        shipping_options_free_brl: shipOptionsDec.toDecimalPlaces(2, ROUND).toFixed(2),
      });
    }
  }

  if (
    amountDec == null &&
    gapDec != null &&
    !shouldSkipSuspiciousLowCandidate(gapDec, "net_receivable_gap")
  ) {
    amountDec = gapDec;
    source = "net_receivable_gap";
    decision_source = "derived_from_net_receivable_gap";
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_GAP_FROM_NET_RECEIVABLE);
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_FALLBACK_APPLIED);
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_INFERRED_FROM_FINANCIAL_GAP);
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_GAP_FALLBACK_SELECTED);
    const g = input.gap;
    if (g) {
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_GAP_FROM_NET_RECEIVABLE, {
        marketplace: "mercado_livre",
        listing_id,
        context: logContext,
        amount_brl: amountDec.toFixed(2),
        sale_brl: g.sale.toDecimalPlaces(2, ROUND).toFixed(2),
        fee_brl: g.fee.toDecimalPlaces(2, ROUND).toFixed(2),
        net_brl: g.net.toDecimalPlaces(2, ROUND).toFixed(2),
      });
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_INFERRED_FROM_FINANCIAL_GAP, {
        marketplace: "mercado_livre",
        listing_id,
        context: logContext,
        source: "net_receivable_gap",
        shipping_cost_amount: amountDec.toFixed(2),
        shipping_cost_context: ctxBuyer,
        sale_price_effective: g.sale.toDecimalPlaces(2, ROUND).toFixed(2),
        sale_fee_amount: g.fee.toDecimalPlaces(2, ROUND).toFixed(2),
        fixed_fee_amount: "0.00",
        net_receivable: g.net.toDecimalPlaces(2, ROUND).toFixed(2),
      });
    }
    if (shipOptionsDec != null && !gapDec.eq(shipOptionsDec.toDecimalPlaces(2, ROUND))) {
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_VALUE_MISMATCH_WITH_OFFICIAL, {
        marketplace: "mercado_livre",
        listing_id,
        context: logContext,
        message: "Frete canônico por GAP; shipping_options/free permanece só em auxiliary_amount_brl",
        gap_shipping_brl: gapDec.toFixed(2),
        shipping_options_free_brl: shipOptionsDec.toDecimalPlaces(2, ROUND).toFixed(2),
      });
    }
    if (mlDecRaw != null && !gapDec.eq(mlDecRaw.toDecimalPlaces(2, ROUND))) {
      logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_OFFICIAL_OVERRULED_ML_ITEM, {
        marketplace: "mercado_livre",
        listing_id,
        context: logContext,
        source_endpoint: "gap_vs_item",
        candidate_field: "item.shipping.cost",
        candidate_value: mlDecRaw.toDecimalPlaces(2, ROUND).toFixed(2),
        selected_value: gapDec.toDecimalPlaces(2, ROUND).toFixed(2),
      });
    }
  }

  if (amountDec == null && mlDec != null && !shouldSkipSuspiciousLowCandidate(mlDec, "ml_payload")) {
    amountDec = mlDec;
    source = "ml_payload";
    decision_source = "ml_item_shipping_amount";
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_FROM_ML);
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_RESOLVED_FROM_PAYLOAD);
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_FROM_ML, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      amount_brl: amountDec.toDecimalPlaces(2, ROUND).toFixed(2),
      path: "fromMlItem",
    });
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_RESOLVED_FROM_PAYLOAD, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      source: "ml_item_shipping_amount",
      shipping_cost_amount: amountDec.toDecimalPlaces(2, ROUND).toFixed(2),
      shipping_cost_context: ctxBuyer,
      sale_price_effective: input.gap?.sale?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      sale_fee_amount: input.gap?.fee?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      fixed_fee_amount: "0.00",
      net_receivable: input.gap?.net?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
    });
  }
  if (amountDec == null && mlDecRaw != null && !isValidShippingCost(mlDecRaw)) {
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_INVALID_ML_ITEM_SKIPPED);
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.SHIPPING_COST_INVALID_ML_ITEM_SKIPPED, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      source_endpoint: "items",
      candidate_field: "item.shipping.cost",
      candidate_value: mlDecRaw.toDecimalPlaces(2, ROUND).toFixed(2),
      reason: "placeholder_or_non_financial_cost",
    });
  }

  if (amountDec == null && healthDec != null && !shouldSkipSuspiciousLowCandidate(healthDec, "health_column")) {
    amountDec = healthDec;
    source = "health_column";
    decision_source = "persisted_health_shipping_cost";
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_FROM_ML);
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_RESOLVED_FROM_PAYLOAD);
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_FROM_ML, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      amount_brl: amountDec.toDecimalPlaces(2, ROUND).toFixed(2),
      path: "fromHealth",
    });
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_RESOLVED_FROM_PAYLOAD, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      source: "persisted_health_shipping_cost",
      shipping_cost_amount: amountDec.toDecimalPlaces(2, ROUND).toFixed(2),
      shipping_cost_context: ctxBuyer,
      sale_price_effective: input.gap?.sale?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      sale_fee_amount: input.gap?.fee?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      fixed_fee_amount: "0.00",
      net_receivable: input.gap?.net?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
    });
  }

  if (amountDec == null && shipOptionsDec != null) {
    amountDec = shipOptionsDec;
    source = "ml_shipping_options_free_simulation";
    decision_source = "auxiliary_shipping_options_free_fallback";
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_FALLBACK_APPLIED);
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_FALLBACK_APPLIED, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      source: "ml_shipping_options_free_simulation",
      shipping_cost_amount: amountDec.toDecimalPlaces(2, ROUND).toFixed(2),
      shipping_cost_context: ctxBuyer,
      sale_price_effective: input.gap?.sale?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      sale_fee_amount: input.gap?.fee?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      fixed_fee_amount: "0.00",
      net_receivable: input.gap?.net?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      message: "Frete principal estimado a partir de shipping_options/free (auxiliar).",
    });
  }

  if (shipOptionsDec != null) {
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_AUXILIARY_SIMULATION_STORED);
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_AUXILIARY_SIMULATION_STORED, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      auxiliary_amount_brl: shipOptionsDec.toDecimalPlaces(2, ROUND).toFixed(2),
      note:
        source === "ml_shipping_options_free_simulation"
          ? "shipping_options/free promovido para frete principal estimado"
          : "shipping_options/free mantido em shipping_cost_auxiliary_* para auditoria",
    });
  }

  if (amountDec == null) {
    if (suspiciousLowRejected) {
      decision_source = "suspicious_low_shipping_rejected";
    }
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_MISSING);
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_UNRESOLVED);
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.SHIPPING_COST_MISSING, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      message: "Nenhum custo de envio ao vendedor encontrado (payload, health nem gap)",
    });
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.SHIPPING_COST_UNRESOLVED, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      source: "unresolved",
      shipping_cost_amount: null,
      shipping_cost_context: ctxBuyer,
      sale_price_effective: input.gap?.sale?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      sale_fee_amount: input.gap?.fee?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      fixed_fee_amount: "0.00",
      net_receivable: input.gap?.net?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
    });
  } else if (amountDec.lt(0)) {
    inconsistency_codes.push(PRICING_EVENT_CODE.INVALID_SHIPPING_COST_VALUE);
    inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_INCONSISTENT_SKIPPED);
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.INVALID_SHIPPING_COST_VALUE, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      amount: amountDec.toString(),
      message: "Valor negativo descartado",
    });
    logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.SHIPPING_COST_INCONSISTENT_SKIPPED, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      source: decision_source,
      shipping_cost_amount: amountDec.toString(),
      shipping_cost_context: ctxBuyer,
      sale_price_effective: input.gap?.sale?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      sale_fee_amount: input.gap?.fee?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
      fixed_fee_amount: "0.00",
      net_receivable: input.gap?.net?.toDecimalPlaces(2, ROUND).toFixed(2) ?? null,
    });
    amountDec = null;
    source = "unresolved";
    decision_source = "invalid_negative_discarded";
  }

  if (input.free_shipping != null && amountDec != null && amountDec.gt(0)) {
    const srcCtx = input.free_shipping === true ? "free_for_buyer" : "buyer_pays";
    if (ctxBuyer !== srcCtx) {
      inconsistency_codes.push(PRICING_EVENT_CODE.SHIPPING_COST_CONTEXT_MISMATCH_DETECTED);
      logPricingEvent(PRICING_LOG_LEVEL.WARN, PRICING_EVENT_CODE.SHIPPING_COST_CONTEXT_MISMATCH_DETECTED, {
        marketplace: "mercado_livre",
        listing_id,
        context: logContext,
        shipping_cost_context: ctxBuyer,
        expected_context: srcCtx,
        shipping_cost_source: source,
      });
    }
  }

  if (shouldEmitShippingCostCandidatesTrace(listing_id)) {
    const fmtDec = (d) =>
      d != null && d.isFinite() ? d.toDecimalPlaces(2, ROUND).toFixed(2) : null;
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.SHIPPING_COST_RESOLUTION_CANDIDATES_TRACE, {
      marketplace: "mercado_livre",
      listing_id,
      context: logContext,
      listing_prices_official_input_raw: input.fromOfficialMl ?? null,
      sale_fee_details_logistics_input_raw: input.fromSaleFeeDetails ?? null,
      shipping_options_free_input_raw: input.fromShippingOptionsFree ?? null,
      candidate_listing_prices_normalized_brl: fmtDec(officialMlDec),
      candidate_sale_fee_details_normalized_brl: fmtDec(detailsDec),
      candidate_shipping_options_normalized_brl: fmtDec(shipOptionsDec),
      resolved_amount_brl:
        amountDec != null && amountDec.isFinite() ? amountDec.toDecimalPlaces(2, ROUND).toFixed(2) : null,
      shipping_cost_source: source,
      decision_source,
      resolution_summary:
        source === "ml_listing_prices_logistics" && decision_source === "official_ml_shipping_field"
          ? "Canônico: listing_prices — extractMercadoLivreOfficialShippingFromListingPricesRow (sale_fee_details / scan)."
          : source === "ml_listing_prices_logistics" && decision_source === "sale_fee_details_logistics_listing_prices_row"
            ? "Canônico: sale_fee_details.logistics (fromSaleFeeDetails); fromOfficialMl ausente ou ≤0."
            : source === "net_receivable_gap"
              ? "Canônico: GAP sale−fee−net (listing_prices não extraiu logística)."
              : `Resolvido via ${decision_source} (shipping_cost_source=${source}). shipping_options/free = apenas auxiliary.`,
    });
  }

  const amount_brl = amountDec != null && amountDec.isFinite() ? amountDec.toDecimalPlaces(2, ROUND).toFixed(2) : null;
  const auxiliary_amount_brl =
    shipOptionsDec != null && shipOptionsDec.isFinite()
      ? shipOptionsDec.toDecimalPlaces(2, ROUND).toFixed(2)
      : null;
  const auxiliary_source = auxiliary_amount_brl != null ? /** @type {const} */ ("ml_shipping_options_free_simulation") : null;

  /** @type {MercadoLivreShippingCostOfficialResult["source"]} */
  const sourceOut = amount_brl != null ? source : "unresolved";

  return {
    label: ML_SHIPPING_COST_OFFICIAL_LABEL,
    context: ctxBuyer,
    amount_brl,
    auxiliary_amount_brl,
    auxiliary_source,
    source: sourceOut,
    decision_source,
    inconsistency_codes,
  };
}

/**
 * Bloco persistido em `marketplace_listing_health.raw_json.suse7_shipping_cost`.
 *
 * @param {MercadoLivreShippingCostOfficialResult} r
 * @returns {Record<string, unknown>}
 */
export function mercadoLivreShippingCostOfficialToPersistBlob(r) {
  return {
    label: r.label,
    context: r.context,
    amount_brl: r.amount_brl,
    source: r.source,
    auxiliary_amount_brl: r.auxiliary_amount_brl,
    auxiliary_source: r.auxiliary_source,
    decision_source: r.decision_source,
    inconsistency_codes: r.inconsistency_codes,
  };
}

/**
 * Campos planos para `net_proceeds` (API grid).
 *
 * @param {MercadoLivreShippingCostOfficialResult} r
 * @returns {Record<string, unknown>}
 */
export function mercadoLivreShippingOfficialToNetProceedsFields(r) {
  return {
    suse7_shipping_cost: mercadoLivreShippingCostOfficialToPersistBlob(r),
    shipping_cost_label: r.label,
    shipping_cost_context: r.context,
    shipping_cost_currency: "BRL",
    shipping_cost_source: r.source,
    shipping_cost_amount_brl: r.amount_brl,
    shipping_cost_auxiliary_brl: r.auxiliary_amount_brl,
    shipping_cost_auxiliary_source: r.auxiliary_source,
    ml_shipping_cost_label: r.label,
    ml_shipping_cost_context: r.context,
    ml_shipping_cost_amount_brl: r.amount_brl,
    ml_shipping_cost_source: r.source,
    shipping_cost_amount: r.amount_brl,
    shipping_cost_marketplace: r.amount_brl ?? "0.00",
    fixed_fee_amount: "0.00",
  };
}
