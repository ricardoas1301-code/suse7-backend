// ======================================================
// Precificação Inteligente — aplica reserva estratégica e custos operacionais
// sobre o cenário oficial (computeOneScenario). Extras incidem sobre o preço de venda.
// Sem float; Decimal.js com arredondamento financeiro (2 casas, HALF_UP).
//
/**
 * ENGINE FINANCEIRA HOMOLOGADA
 *
 * Alterações exigem:
 * - Nova trilha
 * - Nova homologação
 * - Comparação com simulador oficial ML
 *
 * Não alterar sem aprovação explícita.
 * Doc: docs/precificacao/PI_ENGINE_HOMOLOGADA.md
 */
// ======================================================

import Decimal from "decimal.js";

import { classifyOfferMarginStatus } from "../offerMarginStatus.js";

const ROUND = Decimal.ROUND_HALF_UP;

/**
 * @typedef {{
 *   plannedPromoEnabled?: boolean;
 *   plannedPromoPercent?: string | number | null;
 *   affiliatesEnabled?: boolean;
 *   affiliatePercent?: string | number | null;
 *   mlAdsEnabled?: boolean;
 *   mlAdsPercent?: string | number | null;
 *   operationalCostEnabled?: boolean;
 *   operationalCostPercent?: string | number | null;
 * }} ExtrasPrecificacaoInteligenteInput
 */

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

/**
 * @param {Decimal | null} d
 * @returns {string | null}
 */
function decToStr2(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function bool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * @param {Record<string, unknown>} body
 * @returns {ExtrasPrecificacaoInteligenteInput}
 */
export function parseExtrasPrecificacaoInteligenteFromBody(body) {
  const b = body != null && typeof body === "object" ? body : {};
  const nested =
    b.financialExtras != null && typeof b.financialExtras === "object"
      ? /** @type {Record<string, unknown>} */ (b.financialExtras)
      : b.pricingExtras != null && typeof b.pricingExtras === "object"
        ? /** @type {Record<string, unknown>} */ (b.pricingExtras)
        : b;

  const pick = (/** @type {string[]} */ keys) => {
    for (const k of keys) {
      if (nested[k] != null && String(nested[k]).trim() !== "") return nested[k];
    }
    return null;
  };

  return {
    plannedPromoEnabled: bool(nested.plannedPromoEnabled ?? nested.planned_promo_enabled),
    plannedPromoPercent: pick([
      "plannedPromoPercent",
      "planned_promo_percent",
      "plannedPromoPct",
      "planned_promo_pct",
      "promotion_reserve_percent",
      "promotion_percent",
    ]),
    affiliatesEnabled: bool(nested.affiliatesEnabled ?? nested.affiliates_enabled),
    affiliatePercent: pick([
      "affiliatePercent",
      "affiliate_percent",
      "affiliatesPct",
      "affiliates_pct",
      "affiliate_percent",
    ]),
    mlAdsEnabled: bool(nested.mlAdsEnabled ?? nested.ml_ads_enabled),
    mlAdsPercent: pick(["mlAdsPercent", "ml_ads_percent", "mlAdsPct", "ml_ads_pct", "ads_percent"]),
    operationalCostEnabled: bool(
      nested.operationalCostEnabled ??
        nested.operational_cost_enabled ??
        nested.reserveEnabled ??
        nested.reserve_enabled,
    ),
    operationalCostPercent: pick([
      "operationalCostPercent",
      "operational_cost_percent",
      "operationalCostPct",
      "operational_cost_pct",
      "reservePct",
      "reserve_pct",
    ]),
  };
}

/**
 * @param {ExtrasPrecificacaoInteligenteInput} extras
 * @returns {boolean}
 */
export function temExtrasPrecificacaoInteligenteAtivos(extras) {
  if (extras == null || typeof extras !== "object") return false;
  if (extras.plannedPromoEnabled && toDec(extras.plannedPromoPercent)?.gt(0)) return true;
  if (extras.affiliatesEnabled && toDec(extras.affiliatePercent)?.gt(0)) return true;
  if (extras.mlAdsEnabled && toDec(extras.mlAdsPercent)?.gt(0)) return true;
  if (extras.operationalCostEnabled && toDec(extras.operationalCostPercent)?.gt(0)) return true;
  return false;
}

/**
 * Calcula valor BRL de um extra (% sobre preço de venda).
 * @param {Decimal | null} salePrice
 * @param {boolean} enabled
 * @param {unknown} percentRaw
 */
function calcularExtraBrl(salePrice, enabled, percentRaw) {
  if (!enabled || salePrice == null || !salePrice.gt(0)) {
    return { percent: null, brl: new Decimal(0) };
  }
  const pct = toDec(percentRaw);
  if (pct == null || pct.lte(0)) {
    return { percent: null, brl: new Decimal(0) };
  }
  const brl = salePrice.mul(pct).div(100).toDecimalPlaces(2, ROUND);
  return { percent: pct, brl };
}

/**
 * Aplica extras PI ao cenário oficial e recalcula lucro, margem e status da oferta.
 * @param {Record<string, unknown>} scenario
 * @param {ExtrasPrecificacaoInteligenteInput | null | undefined} extrasInput
 * @returns {Record<string, unknown>}
 */
export function aplicarExtrasPrecificacaoInteligente(scenario, extrasInput) {
  if (scenario == null || typeof scenario !== "object") return scenario;

  const extras = extrasInput ?? {};
  const temAtivos = temExtrasPrecificacaoInteligenteAtivos(extras);

  const m =
    scenario.marketplace != null && typeof scenario.marketplace === "object"
      ? /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (scenario.marketplace) })
      : {};
  const ic =
    scenario.internal_costs != null && typeof scenario.internal_costs === "object"
      ? /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (scenario.internal_costs) })
      : {};
  const res =
    scenario.result != null && typeof scenario.result === "object"
      ? /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (scenario.result) })
      : {};

  const salePrice = toDec(m.sale_price_brl ?? scenario.sale_price_brl);
  const payout = toDec(
    m.marketplace_payout_amount_brl ?? m.net_receivable_brl ?? scenario.net_receivable_brl,
  );
  const productCost = toDec(ic.product_cost_brl) ?? new Decimal(0);
  const tax = toDec(ic.tax_amount_brl) ?? new Decimal(0);
  const packagingOp = toDec(ic.operational_packaging_total_brl) ?? new Decimal(0);

  const promo = calcularExtraBrl(salePrice, !!extras.plannedPromoEnabled, extras.plannedPromoPercent);
  const affiliate = calcularExtraBrl(salePrice, !!extras.affiliatesEnabled, extras.affiliatePercent);
  const ads = calcularExtraBrl(salePrice, !!extras.mlAdsEnabled, extras.mlAdsPercent);
  const operational = calcularExtraBrl(
    salePrice,
    !!extras.operationalCostEnabled,
    extras.operationalCostPercent,
  );

  const extrasTotal = promo.brl.plus(affiliate.brl).plus(ads.brl).plus(operational.brl);

  /** @type {Record<string, unknown>} */
  const pricingExtras = {
    promotion_reserve_percent: promo.percent != null ? decToStr2(promo.percent) : null,
    promotion_reserve_brl: decToStr2(promo.brl),
    affiliate_percent: affiliate.percent != null ? decToStr2(affiliate.percent) : null,
    affiliate_brl: decToStr2(affiliate.brl),
    ads_percent: ads.percent != null ? decToStr2(ads.percent) : null,
    ads_brl: decToStr2(ads.brl),
    operational_cost_percent: operational.percent != null ? decToStr2(operational.percent) : null,
    operational_cost_brl: decToStr2(operational.brl),
    extras_total_brl: decToStr2(extrasTotal),
  };

  if (!temAtivos || salePrice == null || payout == null || !salePrice.gt(0)) {
    console.info("[pricing-extras] skipped", {
      tem_ativos: temAtivos,
      sale_price_brl: decToStr2(salePrice),
      payout_brl: decToStr2(payout),
    });
    return {
      ...scenario,
      pricing_intelligence_extras: pricingExtras,
    };
  }

  const profit = payout
    .minus(productCost)
    .minus(tax)
    .minus(packagingOp)
    .minus(promo.brl)
    .minus(affiliate.brl)
    .minus(ads.brl)
    .minus(operational.brl);

  const profitStr = decToStr2(profit);
  let marginPctStr = null;
  if (salePrice.gt(0)) {
    marginPctStr = profit.div(salePrice).mul(100).toDecimalPlaces(2, ROUND).toFixed(2);
  }

  const marginPctD = marginPctStr != null ? toDec(marginPctStr) : null;
  const statusUi = classifyOfferMarginStatus(marginPctD, profit);

  console.info("[pricing-extras] applied", {
    sale_price_brl: decToStr2(salePrice),
    payout_brl: decToStr2(payout),
    product_cost_brl: decToStr2(productCost),
    tax_brl: decToStr2(tax),
    packaging_operation_cost_brl: decToStr2(packagingOp),
    promotion_reserve_brl: pricingExtras.promotion_reserve_brl,
    affiliate_brl: pricingExtras.affiliate_brl,
    ads_brl: pricingExtras.ads_brl,
    operational_cost_brl: pricingExtras.operational_cost_brl,
    extras_total_brl: pricingExtras.extras_total_brl,
    profit_brl: profitStr,
    margin_percent: marginPctStr,
    offer_status_key: statusUi.offer_status_key,
  });

  return {
    ...scenario,
    marketplace: m,
    internal_costs: ic,
    pricing_intelligence_extras: pricingExtras,
    result: {
      ...res,
      profit_brl: profitStr,
      margin_pct: marginPctStr,
      ...statusUi,
      offer_status: statusUi.offer_status_label,
      health_status: statusUi.offer_status_label,
    },
  };
}
