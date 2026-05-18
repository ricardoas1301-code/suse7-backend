import Decimal from "decimal.js";
import { buildSaleDetailMarketplaceRevenue } from "../../domain/sales/saleDetailMarketplaceRevenue.js";
import { toNum } from "./_vendasSalesRows.js";

/** @param {unknown} v */
function toDecimal(v) {
  const n = toNum(v);
  if (n == null) return null;
  return new Decimal(n);
}

/** @param {Decimal | null} d */
function moneyDecimal(d) {
  if (!d) return null;
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * @param {Record<string, unknown> | null | undefined} product
 * @param {number} qty
 */
function internalCostsFromProduct(product, qty) {
  const q = new Decimal(qty > 0 ? qty : 1);
  const cost = toDecimal(product?.cost_price);
  const pack = toDecimal(product?.packaging_cost);
  const op = toDecimal(product?.operational_cost);
  const productCost = cost ? cost.mul(q) : null;
  const packaging = pack ? pack.mul(q) : null;
  const operation = op ? op.mul(q) : null;
  let opPack = null;
  if (operation && packaging) opPack = operation.plus(packaging);
  else if (operation) opPack = operation;
  else if (packaging) opPack = packaging;
  return { productCost, packaging, operation, opPack };
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} product
 * @param {Record<string, unknown> | null | undefined} [order]
 * @param {Record<string, unknown> | null | undefined} [listing]
 */
export function buildSaleDetailFinancialBreakdown(item, product, order = null, listing = null) {
  const qty = toNum(item.quantity) ?? 1;
  const revenue = buildSaleDetailMarketplaceRevenue(item, order, listing);

  const grossDec = toDecimal(revenue.gross_amount);
  const feeDec = toDecimal(revenue.marketplace_fee_amount);
  const shipDec = toDecimal(revenue.shipping_cost_amount);
  const netDec = toDecimal(revenue.net_received_amount);
  const taxDec = toDecimal(item.tax_amount);

  const { productCost, packaging, operation, opPack } = internalCostsFromProduct(product, qty);
  const internalTaxDec = taxDec;

  let profitDec = null;
  if (netDec != null) {
    profitDec = netDec;
    if (productCost) profitDec = profitDec.minus(productCost);
    if (internalTaxDec) profitDec = profitDec.minus(internalTaxDec);
    if (opPack) profitDec = profitDec.minus(opPack);
  }

  let marginStr = null;
  if (profitDec != null && grossDec != null && !grossDec.isZero()) {
    marginStr = profitDec.div(grossDec).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }

  /** @type {"healthy" | "critical" | "attention" | "unknown"} */
  let health = "unknown";
  if (profitDec != null) {
    if (profitDec.isNegative()) health = "critical";
    else if (marginStr != null && new Decimal(marginStr).lt(5)) health = "attention";
    else health = "healthy";
  } else if (netDec != null) {
    health = "attention";
  }

  return {
    ...revenue,
    product_cost_amount: moneyDecimal(productCost),
    product_cost_only_brl: moneyDecimal(productCost),
    internal_tax_amount: moneyDecimal(internalTaxDec),
    internal_taxes: moneyDecimal(internalTaxDec),
    taxes: moneyDecimal(internalTaxDec),
    operation_cost_amount: moneyDecimal(operation),
    packaging_cost_amount: moneyDecimal(packaging),
    operation_packaging_cost: moneyDecimal(opPack),
    other_cost_amount: null,
    other_operational_costs: null,
    profit_amount: moneyDecimal(profitDec),
    profit_brl: moneyDecimal(profitDec),
    margin_percent: marginStr,
    health_status: health,
    health,
  };
}
