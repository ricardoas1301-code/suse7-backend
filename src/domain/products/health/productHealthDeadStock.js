// ======================================================================
// Estoque parado — Central de Saúde dos Produtos (regras + auditoria DEV).
// Estoque confiável = quantidade populada/sincronizada (stock_quantity conhecido).
// Custo confiável = cadastro oficial SUS7 (custo + operacional + embalagem).
// ======================================================================

import Decimal from "decimal.js";
import { PRODUCT_HEALTH_DEAD_STOCK_DAYS } from "./productHealthConstants.js";
import {
  formatDecimalFixed,
  formatPercentFromRatio,
  isStockQuantityKnown,
  readKnownStockQuantity,
  toDecimalOrNull,
} from "./productHealthNumericHelpers.js";
import { montarKpiGiroProdutos, produtoTeveVendaNaJanela } from "./productHealthTurnover.js";

const AUDIT_LOG_PREFIX = "[S7_PRODUCT_HEALTH_DEAD_STOCK_AUDIT]";
const STOCK_AUDIT_LOG_PREFIX = "[S7_PRODUCT_HEALTH_STOCK_AUDIT]";
const AUDIT_SAMPLE_LIMIT = 5;

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parseMarketplaceTimestampMs(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const ms = Date.parse(String(raw).trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {Date} todayUtc
 */
function startOfUtcDay(todayUtc) {
  return Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate());
}

/**
 * Dias de calendário completos entre um instante UTC e hoje (inclusivo no dia atual).
 *
 * @param {number | null | undefined} timestampMs
 * @param {Date} [todayUtc]
 */
export function calcularDiasCalendarioUtc(timestampMs, todayUtc = new Date()) {
  if (timestampMs == null || !Number.isFinite(timestampMs)) return null;
  const todayStart = startOfUtcDay(todayUtc);
  const eventStart = startOfUtcDay(new Date(timestampMs));
  const diffMs = todayStart - eventStart;
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * @param {{
 *   productCreatedAtMs?: number | null;
 *   listingCreatedAtMinMs?: number | null;
 *   todayUtc?: Date;
 * }} params
 */
export function resolverIdadeProdutoDias(params = {}) {
  const todayUtc = params.todayUtc ?? new Date();
  /** @type {number[]} */
  const candidates = [];
  if (params.productCreatedAtMs != null && Number.isFinite(params.productCreatedAtMs)) {
    candidates.push(params.productCreatedAtMs);
  }
  if (params.listingCreatedAtMinMs != null && Number.isFinite(params.listingCreatedAtMinMs)) {
    candidates.push(params.listingCreatedAtMinMs);
  }
  if (!candidates.length) return null;
  const oldestMs = Math.min(...candidates);
  return calcularDiasCalendarioUtc(oldestMs, todayUtc);
}

/**
 * @param {{
 *   stockKnown: boolean;
 *   stockQty: number | null;
 *   isActiveProduct: boolean;
 *   qtyDeadWindow: number;
 *   lastSaleAtMs?: number | null;
 *   productAgeDays?: number | null;
 *   thresholdDays?: number;
 *   todayUtc?: Date;
 * }} params
 */
export function avaliarProdutoEstoqueParado(params) {
  return Number(params.qtyDeadWindow ?? 0) <= 0;
}

/**
 * Avalia elegibilidade temporal (sem venda na janela + critério de idade/última venda).
 *
 * @param {{
 *   qtyDeadWindow: number;
 *   lastSaleAtMs?: number | null;
 *   productAgeDays?: number | null;
 *   thresholdDays?: number;
 *   todayUtc?: Date;
 * }} params
 */
export function avaliarElegibilidadeTemporalEstoqueParado(params) {
  const thresholdDays = params.thresholdDays ?? PRODUCT_HEALTH_DEAD_STOCK_DAYS;
  const todayUtc = params.todayUtc ?? new Date();

  if (Number(params.qtyDeadWindow ?? 0) > 0) return false;

  if (params.lastSaleAtMs != null && Number.isFinite(params.lastSaleAtMs)) {
    const daysSinceLastSale = calcularDiasCalendarioUtc(params.lastSaleAtMs, todayUtc);
    return daysSinceLastSale != null && daysSinceLastSale >= thresholdDays;
  }

  const productAgeDays = params.productAgeDays ?? null;
  return productAgeDays != null && productAgeDays >= thresholdDays;
}

/**
 * Breakdown conceitual — explica diferença entre "ativos sem venda" (30d) e Estoque parado.
 *
 * @param {Array<Record<string, unknown>>} snapshots
 * @param {number} [thresholdDays]
 */
export function montarBreakdownConceitualEstoqueParado(
  snapshots,
  thresholdDays = PRODUCT_HEALTH_DEAD_STOCK_DAYS,
) {
  const turnover = montarKpiGiroProdutos(snapshots, thresholdDays);
  let stoppedWithStockData = 0;
  let stoppedWithoutStockData = 0;
  let stoppedWithCostData = 0;
  let stoppedMissingCostOnly = 0;
  let stoppedStockValueEligible = 0;

  for (const snapshot of snapshots) {
    if (produtoTeveVendaNaJanela(snapshot)) continue;

    const stockKnown = snapshot.stock_known === true || isStockQuantityKnown(snapshot.stock_quantity);
    const stock = stockKnown ? readKnownStockQuantity(snapshot.stock_quantity) ?? 0 : 0;
    const unitCost =
      snapshot.unit_cost_brl instanceof Decimal
        ? snapshot.unit_cost_brl
        : toDecimalOrNull(snapshot.unit_cost_brl);

    if (!stockKnown || stock <= 0) {
      stoppedWithoutStockData += 1;
      continue;
    }

    stoppedWithStockData += 1;

    if (unitCost != null && unitCost.gt(0)) {
      stoppedWithCostData += 1;
      stoppedStockValueEligible += 1;
    } else {
      stoppedMissingCostOnly += 1;
    }
  }

  return {
    mix_conversion_window_days: 30,
    product_turnover_window_days: thresholdDays,
    dead_stock_window_days: thresholdDays,
    note:
      "Sem venda recente e Estoque parado usam janela de 15d sobre o total de produtos da Central, alinhados ao KPI Giro dos Produtos.",
    total_products: turnover.total_products,
    products_with_sales_in_window: turnover.products_with_sales_in_window,
    products_without_sales_in_window: turnover.total_products - turnover.products_with_sales_in_window,
    stopped_with_stock_data: stoppedWithStockData,
    stopped_without_stock_data: stoppedWithoutStockData,
    stopped_with_cost_data: stoppedWithCostData,
    stopped_missing_cost_only: stoppedMissingCostOnly,
    stopped_stock_value_eligible: stoppedStockValueEligible,
  };
}

/**
 * @param {Array<Record<string, unknown>>} snapshots
 * @param {number} [thresholdDays]
 */
export function montarAgregadoEstoqueParado(snapshots, thresholdDays = PRODUCT_HEALTH_DEAD_STOCK_DAYS) {
  const turnover = montarKpiGiroProdutos(snapshots, thresholdDays);
  const totalProducts = turnover.total_products;
  const productsCount = Math.max(0, totalProducts - turnover.products_with_sales_in_window);
  const productsPercent = formatPercentFromRatio(
    new Decimal(productsCount),
    new Decimal(totalProducts > 0 ? totalProducts : 0),
  );

  let stockValue = new Decimal(0);
  let missingCostProductsCount = 0;
  let missingStockProductsCount = 0;
  let productsWithStockData = 0;
  let productsWithoutStockData = 0;
  let productsWithCostData = 0;
  let productsWithoutCostData = 0;

  for (const snapshot of snapshots) {
    if (produtoTeveVendaNaJanela(snapshot)) continue;

    const stockKnown = snapshot.stock_known === true || isStockQuantityKnown(snapshot.stock_quantity);
    const stock = stockKnown ? readKnownStockQuantity(snapshot.stock_quantity) ?? 0 : 0;
    const unitCost =
      snapshot.unit_cost_brl instanceof Decimal
        ? snapshot.unit_cost_brl
        : toDecimalOrNull(snapshot.unit_cost_brl);

    if (!stockKnown || stock <= 0) {
      productsWithoutStockData += 1;
      missingStockProductsCount += 1;
      continue;
    }

    productsWithStockData += 1;

    if (unitCost == null || !unitCost.gt(0)) {
      productsWithoutCostData += 1;
      missingCostProductsCount += 1;
      continue;
    }

    productsWithCostData += 1;
    stockValue = stockValue.plus(unitCost.mul(stock));
  }

  const hasPartialStockData = missingStockProductsCount > 0;
  const hasMissingCost = missingCostProductsCount > 0;
  const hasPartialValue = hasPartialStockData || hasMissingCost;

  /** @type {{ status: string; reason: string | null; message: string | null }} */
  let dataQuality = { status: "ok", reason: null, message: null };

  if (hasPartialStockData && hasMissingCost) {
    dataQuality = {
      status: "warning",
      reason: "partial_stock_and_cost",
      message:
        "Valor estimado com base nos produtos com estoque/custo cadastrado. Alguns produtos ainda não possuem estoque ou custo cadastrado.",
    };
  } else if (hasPartialStockData) {
    dataQuality = {
      status: "warning",
      reason: "partial_stock",
      message: "Valor estimado com base nos produtos com estoque/custo cadastrado.",
    };
  } else if (hasMissingCost) {
    dataQuality = {
      status: "warning",
      reason: "missing_costs",
      message:
        "Valor estimado com base nos produtos com estoque/custo cadastrado. Alguns produtos ainda não possuem estoque ou custo cadastrado.",
    };
  }

  return {
    products_count: productsCount,
    products_total: totalProducts,
    products_percent: productsPercent,
    stock_value_brl: formatDecimalFixed(stockValue),
    days_threshold: thresholdDays,
    window_days: thresholdDays,
    subtitle: `${productsCount} de ${totalProducts} produtos parados há +${thresholdDays} dias`,
    tooltip:
      "Produtos sem vendas nos últimos 15 dias. Valor estimado com base no custo/estoque cadastrado.",
    missing_cost_products_count: missingCostProductsCount,
    missing_stock_products_count: missingStockProductsCount,
    unknown_stock_products_count: missingStockProductsCount,
    products_with_stock_data: productsWithStockData,
    products_without_stock_data: productsWithoutStockData,
    products_with_cost_data: productsWithCostData,
    products_without_cost_data: productsWithoutCostData,
    products_with_sales_in_window: turnover.products_with_sales_in_window,
    value_calculation_source: "products.stock_quantity*unit_cost",
    sales_source: turnover.sales_source,
    conceptual_breakdown: montarBreakdownConceitualEstoqueParado(snapshots, thresholdDays),
    data_quality: dataQuality,
  };
}

/**
 * @param {{
 *   sellerId: string;
 *   marketplaceAccountId?: string | null;
 *   thresholdDays?: number;
 *   deadStock: ReturnType<typeof montarAgregadoEstoqueParado>;
 *   snapshots: Array<Record<string, unknown>>;
 * }} params
 */
export function logAuditoriaEstoqueParadoDev(params) {
  if (process.env.NODE_ENV === "production") return;

  const thresholdDays = params.thresholdDays ?? PRODUCT_HEALTH_DEAD_STOCK_DAYS;
  /** @type {Array<Record<string, unknown>>} */
  const sampleItems = [];

  for (const snapshot of params.snapshots) {
    if (produtoTeveVendaNaJanela(snapshot)) continue;
    if (sampleItems.length >= AUDIT_SAMPLE_LIMIT) break;

    const stockKnown = snapshot.stock_known === true || isStockQuantityKnown(snapshot.stock_quantity);
    const stock = stockKnown ? readKnownStockQuantity(snapshot.stock_quantity) ?? 0 : 0;
    const unitCost =
      snapshot.unit_cost_brl instanceof Decimal
        ? snapshot.unit_cost_brl
        : toDecimalOrNull(snapshot.unit_cost_brl);
    const stockValue =
      stockKnown && stock > 0 && unitCost != null && unitCost.gt(0)
        ? formatDecimalFixed(unitCost.mul(stock))
        : null;

    sampleItems.push({
      product_id: snapshot.product_id ?? null,
      sku: snapshot.sku ?? null,
      title: snapshot.product_name ?? null,
      current_stock_quantity: stockKnown ? stock : null,
      unit_cost_brl: unitCost != null ? formatDecimalFixed(unitCost) : null,
      stock_value_brl: stockValue,
      last_sale_at: snapshot.last_sale_at ?? null,
      days_since_last_sale: snapshot.days_since_last_sale ?? null,
      sales_last_15d: Number(snapshot.qty_dead_window ?? 0) || 0,
      product_age_days: snapshot.product_age_days ?? null,
      stock_known: stockKnown,
      cost_source: "products.cost_price+operational_cost+packaging_cost",
    });
  }

  console.info(AUDIT_LOG_PREFIX, {
    seller_id: params.sellerId,
    marketplace_account_id: params.marketplaceAccountId ?? null,
    threshold_days: thresholdDays,
    products_count: params.deadStock.products_count,
    stock_value_brl: params.deadStock.stock_value_brl,
    missing_cost_products_count: params.deadStock.missing_cost_products_count,
    unknown_stock_products_count: params.deadStock.unknown_stock_products_count,
    conceptual_breakdown: params.deadStock.conceptual_breakdown,
    data_quality: params.deadStock.data_quality,
    sample_items: sampleItems,
  });
}

/**
 * @param {{
 *   sellerId: string;
 *   marketplaceAccountId?: string | null;
 *   thresholdDays?: number;
 *   deadStock: ReturnType<typeof montarAgregadoEstoqueParado>;
 *   snapshots: Array<Record<string, unknown>>;
 *   dateWindowStart?: string | null;
 *   dateWindowEnd?: string | null;
 * }} params
 */
export function logAuditoriaCentralSaudeEstoque(params) {
  if (process.env.NODE_ENV === "production") return;

  const thresholdDays = params.thresholdDays ?? PRODUCT_HEALTH_DEAD_STOCK_DAYS;
  const turnover = montarKpiGiroProdutos(params.snapshots, thresholdDays);
  const deadStock = params.deadStock;

  console.info(STOCK_AUDIT_LOG_PREFIX, {
    seller_id: params.sellerId,
    account_scope: params.marketplaceAccountId ?? "all_accounts",
    total_products: turnover.total_products,
    products_with_sales_last_15d: turnover.products_with_sales_in_window,
    products_without_sales_last_15d: deadStock.products_count,
    without_sales_percent: deadStock.products_percent,
    stopped_products_count: deadStock.products_count,
    stopped_products_total: deadStock.products_total,
    stopped_products_percent: deadStock.products_percent,
    stopped_stock_value_brl: deadStock.stock_value_brl,
    products_with_stock_data: deadStock.products_with_stock_data,
    products_without_stock_data: deadStock.products_without_stock_data,
    products_with_cost_data: deadStock.products_with_cost_data,
    products_without_cost_data: deadStock.products_without_cost_data,
    date_window_start: params.dateWindowStart ?? null,
    date_window_end: params.dateWindowEnd ?? null,
    sales_date_source: "sales_orders.date_created_marketplace",
    grouping_key: "product_id",
    value_calculation_source: deadStock.value_calculation_source,
    turnover_cross_check: {
      with_sales: turnover.products_with_sales_in_window,
      without_sales: deadStock.products_count,
      total: turnover.total_products,
      closes:
        turnover.products_with_sales_in_window + deadStock.products_count === turnover.total_products,
    },
  });
}
