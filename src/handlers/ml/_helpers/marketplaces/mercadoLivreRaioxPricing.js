// ======================================================
// Raio-x — custos internos + resultado (Mercado Livre).
// Ponto de extensão multi-marketplace: estratégias paralelas por canal.
// Regra do projeto: números monetários com Decimal.js; sem lógica no frontend.
// ======================================================

import Decimal from "decimal.js";
import { classifyOfferMarginStatus } from "../../../../domain/offerMarginStatus.js";
import { computeProductReadiness } from "../../../../domain/productReadiness.js";
import { ATTENTION_REASON_SKU_PENDING_ML } from "../mlItemSkuExtract.js";

/**
 * @param {unknown} v
 * @returns {Decimal | null}
 */
function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v));
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
  if (d == null) return null;
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * Rótulo do % de imposto já formatado para o modal (pt-BR) — sem formatação monetária no front.
 * @param {Decimal | null} taxPct
 * @returns {string | null}
 */
function taxPercentDisplayLabel(taxPct) {
  if (taxPct == null || !taxPct.isFinite()) return null;
  const s = taxPct.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  return `${s.replace(".", ",")}%`;
}

/**
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} productCosts — custos + opcionalmente nome/SKU já mesclados
 */
function mergeListingProductForHealth(listing, productCosts) {
  const pc = productCosts && typeof productCosts === "object" ? { ...productCosts } : {};
  return {
    product_name: listing.product_name,
    sku: listing.product_sku,
    cost_price: pc.cost_price,
    operational_cost: pc.operational_cost,
    packaging_cost: pc.packaging_cost,
  };
}

/**
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} productCosts
 */
export function deriveProductHealthSnapshot(listing, productCosts) {
  const att = listing.attention_reason != null ? String(listing.attention_reason) : null;
  const skuPending = att === ATTENTION_REASON_SKU_PENDING_ML;
  const pid = listing.product_id != null && String(listing.product_id).trim() !== "";

  if (skuPending || !pid) {
    return {
      has_product_link: false,
      has_complete_costs: false,
      product_health_status: "MISSING_PRODUCT",
      is_product_ready: false,
      missing_fields: [],
      product_completeness_score: 0,
    };
  }

  const merged = mergeListingProductForHealth(listing, productCosts);
  const readiness = computeProductReadiness(merged);

  if (!readiness.is_product_ready) {
    return {
      has_product_link: true,
      has_complete_costs: false,
      product_health_status: "INCOMPLETE_PRODUCT",
      is_product_ready: readiness.is_product_ready,
      missing_fields: readiness.missing_fields,
      product_completeness_score: readiness.product_completeness_score,
    };
  }

  return {
    has_product_link: true,
    has_complete_costs: true,
    product_health_status: "OK",
    is_product_ready: true,
    missing_fields: [],
    product_completeness_score: readiness.product_completeness_score,
  };
}

/**
 * @param {{
 *   listing: Record<string, unknown>;
 *   health: Record<string, unknown> | null | undefined;
 *   netProceeds: Record<string, unknown> | null | undefined;
 *   productCosts: Record<string, unknown> | null | undefined;
 *   sellerTaxPct: string | number | null | undefined;
 *   effectiveSalePriceBrl?: string | null;
 *   marketplacePayoutOverrideBrl?: string | null;
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildMercadoLivrePricingContext(input) {
  const { listing, health, netProceeds, productCosts, sellerTaxPct, effectiveSalePriceBrl, marketplacePayoutOverrideBrl } =
    input;
  const np = netProceeds && typeof netProceeds === "object" ? netProceeds : {};

  const healthSnap = deriveProductHealthSnapshot(listing, productCosts);
  const status = healthSnap.product_health_status;

  /** Base fiscal / receita: preço efetivo da grid (promo quando ativa); payout ML permanece separado. */
  const salePrice =
    toDec(effectiveSalePriceBrl) ??
    toDec(health?.marketplace_sale_price_amount) ??
    toDec(np.sale_price) ??
    toDec(listing?.price) ??
    toDec(health?.promotional_price_brl) ??
    toDec(health?.promotion_price);

  /**
   * Repasse “Você recebe”: override explícito (cenários ML: alinha venda − tarifa − frete às linhas do modal).
   * Senão: health persistido → netProceeds (simulação / grid).
   */
  const payout =
    marketplacePayoutOverrideBrl != null && String(marketplacePayoutOverrideBrl).trim() !== ""
      ? toDec(marketplacePayoutOverrideBrl)
      : toDec(health?.marketplace_payout_amount) ??
        toDec(health?.marketplace_payout_amount_brl) ??
        toDec(np.marketplace_payout_amount_brl) ??
        toDec(np.marketplace_payout_amount) ??
        toDec(np.net_proceeds_amount);

  const feePct = toDec(health?.sale_fee_percent);
  const taxPct = toDec(sellerTaxPct);

  if (status === "MISSING_PRODUCT") {
    return {
      product_health: healthSnap,
      internal_costs: null,
      result: null,
      ui: {
        block2_mode: "no_product",
        block3_mode: "blocked",
        block2_message: null,
        block3_message: "Complete os dados do produto para visualizar o resultado.",
      },
    };
  }

  if (status === "INCOMPLETE_PRODUCT") {
    return {
      product_health: healthSnap,
      internal_costs: {
        product_cost_brl: null,
        tax_amount_brl: null,
        operational_packaging_total_brl: null,
        tax_percent_applied: taxPct != null ? decToStr2(taxPct) : null,
        tax_percent_label: taxPercentDisplayLabel(taxPct),
      },
      result: null,
      ui: {
        block2_mode: "incomplete",
        block3_mode: "blocked",
        block2_message: "Informe nome, SKU e custo do produto para visualizar o lucro real.",
        block3_message: "Informe nome, SKU e custo do produto para visualizar o resultado.",
      },
    };
  }

  const pc = productCosts && typeof productCosts === "object" ? productCosts : {};
  const productCost = toDec(pc.cost_price) ?? new Decimal(0);
  const opCost = toDec(pc.operational_cost) ?? new Decimal(0);
  const packCost = toDec(pc.packaging_cost) ?? new Decimal(0);
  const opPackTotal = opCost.plus(packCost);

  const taxDecimal =
    taxPct != null && salePrice != null ? salePrice.mul(taxPct).div(100) : new Decimal(0);
  const taxAmountStr =
    taxPct != null && salePrice != null ? decToStr2(taxDecimal) : null;

  const productCostStr = decToStr2(productCost);
  const opPackStr = decToStr2(opPackTotal);

  const totalCosts = productCost.plus(taxDecimal).plus(opPackTotal);

  const insufficientPrice = !payout || !salePrice || salePrice.lte(0);

  if (insufficientPrice) {
    return {
      product_health: healthSnap,
      internal_costs: {
        product_cost_brl: productCostStr,
        tax_amount_brl: taxAmountStr,
        operational_packaging_total_brl: opPackStr,
        tax_percent_applied: taxPct != null ? decToStr2(taxPct) : null,
        tax_percent_label: taxPercentDisplayLabel(taxPct),
      },
      result: null,
      ui: {
        block2_mode: "ok",
        block3_mode: "blocked",
        block2_message: null,
        block3_message: "Dados de preço insuficientes para resultado.",
      },
    };
  }

  const profit = payout.minus(totalCosts);
  const profitStr = decToStr2(profit);

  let marginPctStr = null;
  if (salePrice.gt(0)) {
    marginPctStr = profit
      .div(salePrice)
      .mul(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toFixed(2);
  }

  let breakEvenStr = null;
  const feeD = feePct != null ? feePct.div(100) : new Decimal(0);
  const taxD = taxPct != null ? taxPct.div(100) : new Decimal(0);
  const denom = new Decimal(1).minus(feeD).minus(taxD);
  if (denom.gt(0) && totalCosts.gt(0)) {
    breakEvenStr = decToStr2(totalCosts.div(denom));
  }

  const marginPctD = marginPctStr != null ? toDec(marginPctStr) : null;
  const statusUi = classifyOfferMarginStatus(marginPctD, profit);

  return {
    product_health: healthSnap,
    internal_costs: {
      product_cost_brl: productCostStr,
      tax_amount_brl: taxAmountStr,
      operational_packaging_total_brl: opPackStr,
      tax_percent_applied: taxPct != null ? decToStr2(taxPct) : null,
      tax_percent_label: taxPercentDisplayLabel(taxPct),
    },
    result: {
      profit_brl: profitStr,
      margin_pct: marginPctStr,
      break_even_price_brl: breakEvenStr,
      ...statusUi,
      offer_status: statusUi.offer_status_label,
    },
    ui: {
      block2_mode: "ok",
      block3_mode: "ok",
      block2_message: null,
      block3_message: null,
    },
  };
}
