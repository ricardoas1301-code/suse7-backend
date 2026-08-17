// ======================================================
// PI — Promoções: paridade financeira dos cards Clássico/Premium ao selecionar promoção.
// Contrato único recalculado por listing + promoção + tipo + extras PI.
// Decimal.js — sem float.
// ======================================================

import Decimal from "decimal.js";

import {
  aplicarExtrasPrecificacaoInteligente,
  parseExtrasPrecificacaoInteligenteFromBody,
} from "./aplicarExtrasPrecificacaoInteligente.js";
import { classifyOfferMarginStatus } from "../offerMarginStatus.js";

const ROUND = Decimal.ROUND_HALF_UP;

/**
 * @param {unknown} v
 * @returns {Decimal | null}
 */
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
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/**
 * @param {Record<string, unknown>} scenario
 * @returns {Record<string, unknown>}
 */
function snapshotScenarioFinanceiro(scenario) {
  const m =
    scenario.marketplace != null && typeof scenario.marketplace === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.marketplace)
      : {};
  const ic =
    scenario.internal_costs != null && typeof scenario.internal_costs === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.internal_costs)
      : {};
  const res =
    scenario.result != null && typeof scenario.result === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.result)
      : {};
  const pi =
    scenario.pricing_intelligence_extras != null &&
    typeof scenario.pricing_intelligence_extras === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.pricing_intelligence_extras)
      : {};

  return {
    sale_price_brl: m.sale_price_brl ?? scenario.sale_price_brl ?? null,
    marketplace_fee: m.sale_fee_amount_brl ?? m.fee_amount_brl ?? null,
    shipping_cost: m.shipping_cost_amount_brl ?? null,
    amount_to_receive: m.marketplace_payout_amount_brl ?? m.net_receivable_brl ?? null,
    product_cost: ic.product_cost_brl ?? null,
    tax_amount: ic.tax_amount_brl ?? null,
    packaging_cost: ic.operational_packaging_total_brl ?? null,
    ml_ads_cost: pi.ads_brl ?? null,
    operational_costs: pi.operational_cost_brl ?? null,
    profit_brl: res.profit_brl ?? null,
    margin_pct: res.margin_pct ?? null,
  };
}

/**
 * Lucro = você_recebe − ML Ads − custos operacionais − produto − impostos − operação/embalagem
 *
 * @param {{
 *   payout: Decimal;
 *   productCost: Decimal;
 *   tax: Decimal;
 *   packaging: Decimal;
 *   mlAds: Decimal;
 *   operational: Decimal;
 *   promoReserve?: Decimal;
 *   affiliate?: Decimal;
 * }} p
 */
export function calcularLucroPromocaoComCustosExibidos(p) {
  return p.payout
    .minus(p.productCost)
    .minus(p.tax)
    .minus(p.packaging)
    .minus(p.mlAds)
    .minus(p.operational)
    .minus(p.promoReserve ?? new Decimal(0))
    .minus(p.affiliate ?? new Decimal(0));
}

/**
 * Recalcula contrato financeiro completo sobre cenário simulado oficial + extras PI.
 * Garante que lucro/margem incluem todos os custos exibidos em Custos Operacionais.
 *
 * @param {Record<string, unknown>} scenario — cenário oficial (computeOneScenario / simulate)
 * @param {import("./aplicarExtrasPrecificacaoInteligente.js").ExtrasPrecificacaoInteligenteInput | null | undefined} extrasInput
 * @param {{
 *   listing_id?: string | null;
 *   promotion_id?: string | null;
 *   promotion_name?: string | null;
 *   promotion_type?: string | null;
 *   listing_type_id?: string | null;
 *   selected_final_price?: string | null;
 *   selected_discount_amount?: string | null;
 *   amount_to_receive_source?: string | null;
 *   selected_rule?: string | null;
 *   source_trace?: unknown;
 * }} [ctx]
 * @returns {Record<string, unknown>}
 */
export function recalcularContratoFinanceiroPromocaoSelecionada(scenario, extrasInput, ctx = {}) {
  if (scenario == null || typeof scenario !== "object") return scenario;

  const before = snapshotScenarioFinanceiro(scenario);
  const profitBefore = toDec(before.profit_brl);

  const aplicado = aplicarExtrasPrecificacaoInteligente(
    /** @type {Record<string, unknown>} */ ({ ...scenario }),
    extrasInput,
  );

  const after = snapshotScenarioFinanceiro(aplicado);
  const profitAfter = toDec(after.profit_brl);
  const salePrice = toDec(after.sale_price_brl);
  const marginAfter = toDec(after.margin_pct);

  const m =
    aplicado.marketplace != null && typeof aplicado.marketplace === "object"
      ? /** @type {Record<string, unknown>} */ (aplicado.marketplace)
      : {};
  const pi =
    aplicado.pricing_intelligence_extras != null &&
    typeof aplicado.pricing_intelligence_extras === "object"
      ? /** @type {Record<string, unknown>} */ (aplicado.pricing_intelligence_extras)
      : {};

  /** @type {Record<string, unknown>} */
  const financialContract = {
    listing_id: ctx.listing_id ?? null,
    promotion_id: ctx.promotion_id ?? aplicado.promotion_id ?? null,
    promotion_name: ctx.promotion_name ?? aplicado.promotion_name ?? aplicado.label ?? null,
    promotion_type: ctx.promotion_type ?? aplicado.promotion_type ?? null,
    listing_type_id: ctx.listing_type_id ?? null,
    selected_final_price: ctx.selected_final_price ?? after.sale_price_brl ?? null,
    selected_discount_amount: ctx.selected_discount_amount ?? m.seller_discount_amount_brl ?? null,
    marketplace_fee: after.marketplace_fee ?? null,
    shipping_cost: after.shipping_cost ?? null,
    amount_to_receive_source: ctx.amount_to_receive_source ?? "simulated_listing_type_engine",
    amount_to_receive: after.amount_to_receive ?? null,
    ml_ads_cost: after.ml_ads_cost ?? null,
    operational_costs: after.operational_costs ?? null,
    product_cost: after.product_cost ?? null,
    tax_amount: after.tax_amount ?? null,
    packaging_cost: after.packaging_cost ?? null,
    profit_before_fix: decStr2(profitBefore),
    profit_after_fix: decStr2(profitAfter),
    margin_after_fix: decStr2(marginAfter),
    selected_rule: ctx.selected_rule ?? null,
    source_trace: ctx.source_trace ?? null,
    extras_total_brl: pi.extras_total_brl ?? null,
  };

  emitPromotionCalcCardSelectionParityLog(financialContract);

  const funding =
    aplicado.promotion_financial_adjustments != null &&
    typeof aplicado.promotion_financial_adjustments === "object"
      ? /** @type {Record<string, unknown>} */ (aplicado.promotion_financial_adjustments)
      : aplicado.promotion_funding != null && typeof aplicado.promotion_funding === "object"
        ? /** @type {Record<string, unknown>} */ (aplicado.promotion_funding)
        : aplicado.promotion_card_contract != null &&
            typeof aplicado.promotion_card_contract === "object" &&
            /** @type {Record<string, unknown>} */ (aplicado.promotion_card_contract).promotion_financial_adjustments != null
          ? /** @type {Record<string, unknown>} */ (
              /** @type {Record<string, unknown>} */ (aplicado.promotion_card_contract).promotion_financial_adjustments
            )
          : aplicado.promotion_card_contract != null &&
              typeof aplicado.promotion_card_contract === "object" &&
              /** @type {Record<string, unknown>} */ (aplicado.promotion_card_contract).promotion_funding != null
            ? /** @type {Record<string, unknown>} */ (
                /** @type {Record<string, unknown>} */ (aplicado.promotion_card_contract).promotion_funding
              )
            : null;

  if (
    funding?.has_marketplace_price_subsidy === true &&
    profitAfter != null
  ) {
    const priceFunding =
      aplicado.promotion_funding != null && typeof aplicado.promotion_funding === "object"
        ? /** @type {Record<string, unknown>} */ (aplicado.promotion_funding)
        : aplicado.promotion_card_contract != null &&
            typeof aplicado.promotion_card_contract === "object" &&
            /** @type {Record<string, unknown>} */ (aplicado.promotion_card_contract).promotion_funding != null
          ? /** @type {Record<string, unknown>} */ (
              /** @type {Record<string, unknown>} */ (aplicado.promotion_card_contract).promotion_funding
            )
          : null;
    const effRaw = priceFunding?.seller_effective_price_brl;
    const eff = toDec(effRaw);
    if (eff != null && eff.gt(0)) {
      const marginEffective = profitAfter.times(100).div(eff);
      const baseResult =
        aplicado.result != null && typeof aplicado.result === "object"
          ? /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (aplicado.result) })
          : /** @type {Record<string, unknown>} */ ({});
      return {
        ...aplicado,
        result: {
          ...baseResult,
          margin_pct: decStr2(marginEffective),
          margin_pct_buyer_base: baseResult.margin_pct ?? null,
          margin_pct_seller_effective: decStr2(marginEffective),
          offer_status_margin_basis: "seller_effective_price_brl",
        },
        promotion_calc_card_selection_contract: financialContract,
      };
    }
  }

  return {
    ...aplicado,
    promotion_calc_card_selection_contract: financialContract,
  };
}

/**
 * @param {Record<string, unknown>} payload
 */
export function emitPromotionCalcCardSelectionParityLog(payload) {
  console.info("[S7_PROMOTION_CALC_CARD_SELECTION_PARITY]", payload);
}

/**
 * @param {Record<string, unknown>} body
 * @returns {{
 *   promotion_id?: string | null;
 *   promotion_name?: string | null;
 *   promotion_type?: string | null;
 *   selected_final_price?: string | null;
 *   selected_discount_amount?: string | null;
 *   selected_rule?: string | null;
 *   source_trace?: unknown;
 *   amount_to_receive_source?: string | null;
 * }}
 */
export function parsePromotionSelectionContextFromBody(body) {
  const b = body != null && typeof body === "object" ? body : {};
  const nested =
    b.promotionSelection != null && typeof b.promotionSelection === "object"
      ? /** @type {Record<string, unknown>} */ (b.promotionSelection)
      : b.promotionContext != null && typeof b.promotionContext === "object"
        ? /** @type {Record<string, unknown>} */ (b.promotionContext)
        : b;

  const pick = (/** @type {string[]} */ keys) => {
    for (const k of keys) {
      if (nested[k] != null && String(nested[k]).trim() !== "") return String(nested[k]).trim();
    }
    return null;
  };

  return {
    promotion_id: pick(["promotion_id", "promotionId", "selected_promotion_id"]),
    promotion_name: pick(["promotion_name", "promotionName"]),
    promotion_type: pick(["promotion_type", "promotionType"]),
    selected_final_price: pick(["selected_final_price", "selectedFinalPrice", "final_price_brl"]),
    selected_discount_amount: pick(["selected_discount_amount", "selectedDiscountAmount"]),
    selected_rule: pick(["selected_rule", "selectedRule"]),
    source_trace: nested.source_trace ?? nested.sourceTrace ?? null,
    amount_to_receive_source: pick(["amount_to_receive_source", "amountToReceiveSource"]),
  };
}

export { parseExtrasPrecificacaoInteligenteFromBody, classifyOfferMarginStatus, decStr2, toDec };
