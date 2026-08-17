import Decimal from "decimal.js";
import { buildSaleDetailMarketplaceRevenue } from "../../domain/sales/saleDetailMarketplaceRevenue.js";
import {
  buildSaleDetailInternalCostsContract,
  computeSaleDetailRealResult,
  saleDetailMoneyToDecimal as toDecimal,
  saleDetailMoneyDecimal as moneyDecimal,
  saleDetailToQty as toQty,
} from "../../domain/sales/saleDetailInternalCosts.js";
import { classifySaleRayxResultHealth } from "../../domain/sales/saleDetailResultHealth.js";

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} product
 * @param {Record<string, unknown> | null | undefined} [order]
 * @param {Record<string, unknown> | null | undefined} [listing]
 * @param {{
 *   tax_percent?: string | null;
 *   tax_percent_source?: string | null;
 *   seller_company_id?: string | null;
 *   marketplace_account_id?: string | null;
 * }} [taxCtx]
 */
export function buildSaleDetailFinancialBreakdown(item, product, order = null, listing = null, taxCtx = {}) {
  const qty = toQty(item.quantity);
  const revenue = buildSaleDetailMarketplaceRevenue(item, order, listing);

  const grossDec = toDecimal(revenue.gross_amount);
  const netDec = toDecimal(revenue.net_received_amount);

  const productId =
    item.product_id != null
      ? String(item.product_id).trim()
      : product?.id != null
        ? String(product.id).trim()
        : "";

  const internalCosts = buildSaleDetailInternalCostsContract({
    item,
    product,
    productId: productId || null,
    qty,
    grossDec,
    taxPercent: taxCtx.tax_percent ?? null,
    taxPercentSource: taxCtx.tax_percent_source ?? null,
    seller_company_id: taxCtx.seller_company_id ?? null,
    marketplace_account_id: taxCtx.marketplace_account_id ?? null,
  });

  const { profitDec, is_definitive, confidence: resultConfidence } = computeSaleDetailRealResult({
    netReceivedDec: netDec,
    internalCosts,
  });

  let marginStr = null;
  if (profitDec != null && grossDec != null && !grossDec.isZero()) {
    marginStr = profitDec.div(grossDec).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }

  const healthUi =
    profitDec != null || marginStr != null
      ? classifySaleRayxResultHealth(profitDec, marginStr)
      : {
          health_label: null,
          health_status: "unknown",
          health: "unknown",
          offer_status_key: null,
          offer_status_label: null,
          offer_status_semantic: null,
          offer_status_title: null,
          offer_status_subtitle: null,
          offer_status_message: null,
        };

  /** @type {"healthy" | "critical" | "attention" | "unknown"} */
  let health = healthUi.health_status;
  if (!is_definitive && health === "healthy") {
    health = profitDec != null ? "attention" : "unknown";
  }

  return {
    ...revenue,
    internal_costs: internalCosts,
    product_cost_amount: internalCosts.product_cost_brl,
    product_cost_only_brl: internalCosts.product_cost_brl,
    internal_tax_amount: internalCosts.internal_tax_brl,
    internal_taxes: internalCosts.internal_tax_brl,
    taxes: internalCosts.internal_tax_brl,
    operation_cost_amount: internalCosts.operation_cost_brl,
    packaging_cost_amount: internalCosts.packaging_cost_brl,
    operation_packaging_cost: internalCosts.operation_packaging_cost_brl,
    other_cost_amount: null,
    other_operational_costs: null,
    profit_amount: moneyDecimal(profitDec),
    profit_brl: moneyDecimal(profitDec),
    margin_percent: marginStr,
    health_status: health,
    health,
    health_label: healthUi.health_label,
    offer_status_key: healthUi.offer_status_key,
    offer_status_label: healthUi.offer_status_label,
    offer_status_semantic: healthUi.offer_status_semantic,
    result: {
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
    },
    snapshot_version:
      item.raw_json &&
      typeof item.raw_json === "object" &&
      /** @type {Record<string, unknown>} */ (item.raw_json)._s7_financial?.snapshot_version
        ? String(/** @type {Record<string, unknown>} */ (item.raw_json)._s7_financial.snapshot_version)
        : null,
  };
}
