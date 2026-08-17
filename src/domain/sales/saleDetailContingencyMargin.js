// ======================================================
// Margem de contingência — Raio-x da venda (ML Ads + Reserva).
// Promoção e afiliados ficam fora: preço já vem líquido / custo marketplace futuro.
// ======================================================

import Decimal from "decimal.js";
import { classifySaleRayxResultHealth } from "./saleDetailResultHealth.js";
import { buildCommercialAdjustmentLines } from "./saleListingHealthCommercial.js";
import {
  computeSaleDetailRealResult,
  saleDetailMoneyDecimal as moneyDecimal,
  saleDetailMoneyToDecimal as toDecimal,
} from "./saleDetailInternalCosts.js";

/** Chaves incluídas na margem de contingência do Raio-x. */
export const RAYX_CONTINGENCY_FLAG_KEYS = /** @type {const} */ (["ml_ads", "safety_reserve"]);

/**
 * @param {import("./saleListingHealthCommercial.js").PricingSimulationConfig} flags
 * @param {Record<string, unknown>} pricingVariables
 * @param {unknown} grossMoney
 */
export function buildRayxContingencyAdjustmentLines(flags, pricingVariables, grossMoney) {
  /** @type {import("./saleListingHealthCommercial.js").PricingSimulationConfig} */
  const subset = {};
  for (const key of RAYX_CONTINGENCY_FLAG_KEYS) {
    if (flags[key]) subset[key] = flags[key];
  }
  return buildCommercialAdjustmentLines(subset, pricingVariables, grossMoney).filter(
    (line) => line.key != null && RAYX_CONTINGENCY_FLAG_KEYS.includes(line.key),
  );
}

/**
 * @param {unknown} lines
 */
function sumContingencyLinesDec(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let total = new Decimal(0);
  let any = false;
  for (const row of lines) {
    if (!row || typeof row !== "object") continue;
    const amt = toDecimal(/** @type {Record<string, unknown>} */ (row).amount_brl);
    if (amt != null && amt.gt(0)) {
      total = total.plus(amt);
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * Recalcula lucro/margem/saúde após aplicar margem de contingência (somente Raio-x).
 *
 * @param {Record<string, unknown>} financial
 */
export function finalizeSaleDetailFinancialWithContingency(financial) {
  const fin = financial && typeof financial === "object" ? financial : {};
  const lines = Array.isArray(fin.commercial_adjustment_lines) ? fin.commercial_adjustment_lines : [];

  const contingencyDec = sumContingencyLinesDec(lines);
  const netDec = toDecimal(fin.net_received_amount ?? fin.net_received);
  const grossDec = toDecimal(fin.gross_amount ?? fin.sale_price);

  if (!fin.internal_costs || typeof fin.internal_costs !== "object") {
    return {
      ...fin,
      contingency_margin: {
        lines,
        total_brl: moneyDecimal(contingencyDec),
        ml_ads_brl: null,
        reserve_brl: null,
        source: "pricing_financial_settings",
        confidence: lines.length > 0 ? "persisted" : "missing",
      },
    };
  }

  const internalCosts = /** @type {ReturnType<import("./saleDetailInternalCosts.js").buildSaleDetailInternalCostsContract>} */ (
    fin.internal_costs
  );

  const { profitDec, is_definitive, confidence: resultConfidence } = computeSaleDetailRealResult({
    netReceivedDec: netDec,
    internalCosts,
    contingencyDec,
  });

  let marginStr = fin.margin_percent != null ? String(fin.margin_percent) : null;
  if (profitDec != null && grossDec != null && !grossDec.isZero()) {
    marginStr = profitDec.div(grossDec).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }

  const healthUi =
    profitDec != null || marginStr != null
      ? classifySaleRayxResultHealth(profitDec, marginStr)
      : {
          health_label: fin.health_label ?? null,
          health_status: fin.health_status ?? "unknown",
          health: fin.health ?? "unknown",
          offer_status_semantic: fin.offer_status_semantic ?? null,
        };

  let health = healthUi.health_status;
  if (!is_definitive && health === "healthy") {
    health = profitDec != null ? "attention" : "unknown";
  }

  const mlAdsLine = lines.find((l) => l && typeof l === "object" && l.key === "ml_ads");
  const reserveLine = lines.find((l) => l && typeof l === "object" && l.key === "safety_reserve");

  return {
    ...fin,
    commercial_adjustment_lines: lines,
    contingency_margin: {
      lines,
      total_brl: moneyDecimal(contingencyDec),
      ml_ads_brl: mlAdsLine?.amount_brl ?? null,
      reserve_brl: reserveLine?.amount_brl ?? null,
      source: "pricing_financial_settings",
      confidence: lines.length > 0 ? "persisted" : "missing",
    },
    profit_amount: moneyDecimal(profitDec),
    profit_brl: moneyDecimal(profitDec),
    margin_percent: marginStr,
    health_status: health,
    health: health,
    health_label: healthUi.health_label,
    offer_status_semantic: healthUi.offer_status_semantic,
    result: {
      ...(fin.result && typeof fin.result === "object" ? fin.result : {}),
      profit_brl: moneyDecimal(profitDec),
      margin_percent: marginStr,
      health_status: health,
      health_label: healthUi.health_label,
      offer_status_semantic: healthUi.offer_status_semantic,
      is_definitive,
      confidence: resultConfidence,
      formula:
        "net_received - contingency_ml_ads - contingency_reserve - product_cost - internal_tax - operation_packaging",
      margin_formula: "profit_brl / gross_sale_amount * 100",
      contingency_total_brl: moneyDecimal(contingencyDec),
    },
  };
}
