// ======================================================================
// Montagem batch — Central de Saúde dos Produtos (Dashboard).
// SSOT: products + vendas + anúncios vinculados + Decimal.
// ======================================================================

import Decimal from "decimal.js";
import { externalListingIdKeyVariants } from "../../handlers/ml/_helpers/listingGridJoinKeys.js";
import { resolveExecutiveSummaryPeriod, orderMatchesExecutivePeriod } from "../sales/saleExecutivePeriod.js";
import { isExecutiveSummaryEligibleOrderRow } from "../sales/saleExecutiveOrderValidity.js";
import { computeExecutiveLineRealProfit } from "../sales/saleExecutiveLineRealResult.js";
import {
  saleDetailMoneyToDecimal,
  saleDetailToQty,
} from "../sales/saleDetailInternalCosts.js";
import { fetchExecutiveSummaryOrdersById } from "../sales/saleExecutiveSourceItems.js";
import {
  PRODUCT_HEALTH_ABC_SCOPE,
  PRODUCT_HEALTH_DEAD_STOCK_DAYS,
  PRODUCT_HEALTH_OPERATIONAL_PERIOD_PRESET,
} from "../products/health/productHealthConstants.js";
import {
  classificarCurvaAbcPorFaturamento,
  logProductHealthDashboard,
  montarDistribuicaoCoberturaEstoque,
  montarDistribuicaoCurvaAbcMix,
  montarDistribuicaoLucratividadeMix,
  montarSummaryCardsCentralSaudeProdutos,
} from "../products/health/productHealthBucketEngine.js";
import {
  formatPercentFromRatio,
  isStockQuantityKnown,
  normalizarStatusAnuncioAtivo,
  readKnownStockQuantity,
  resolverCustoUnitarioOficialProduto,
  toDecimalOrNull,
  toDecimalOrZero,
} from "../products/health/productHealthNumericHelpers.js";
import { PRODUCT_HEALTH_MARKETPLACE_PROVIDER } from "../products/health/productHealthMarketplaceProvider.js";
import {
  avaliarProdutoEstoqueParado,
  calcularDiasCalendarioUtc,
  logAuditoriaEstoqueParadoDev,
  logAuditoriaCentralSaudeEstoque,
  parseMarketplaceTimestampMs,
  resolverIdadeProdutoDias,
} from "../products/health/productHealthDeadStock.js";

const LISTING_IN_CHUNK_SIZE = 120;
const ORDER_ID_CHUNK_SIZE = 300;
const PRODUCTS_SELECT =
  "id, product_name, sku, status, stock_quantity, cost_price, operational_cost, packaging_cost, created_at";

/** @param {string[]} values @param {number} size */
function chunkValues(values, size) {
  /** @type {string[][]} */
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function fetchAllProducts(supabase, userId) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("products")
      .select(PRODUCTS_SELECT)
      .eq("user_id", userId)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function fetchProductListingScope(supabase, userId) {
  /** @type {Map<string, string>} */
  const listingToProductId = new Map();
  /** @type {Record<string, { activeCount: number; priceSum: Decimal; priceCount: number; listingCreatedAtMinMs: number | null }>} */
  const listingMetaByProductId = {};

  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("marketplace_listings")
      .select("product_id, external_listing_id, status, price, base_price, created_at")
      .eq("user_id", userId)
      .not("product_id", "is", null)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;

    const page = Array.isArray(data) ? data : [];
    for (const row of page) {
      const pid = row?.product_id != null ? String(row.product_id).trim() : "";
      const listingId = row?.external_listing_id != null ? String(row.external_listing_id).trim() : "";
      if (!pid) continue;

      if (!listingMetaByProductId[pid]) {
        listingMetaByProductId[pid] = {
          activeCount: 0,
          priceSum: new Decimal(0),
          priceCount: 0,
          listingCreatedAtMinMs: null,
        };
      }

      const listingCreatedAtMs = parseMarketplaceTimestampMs(row?.created_at);
      if (listingCreatedAtMs != null) {
        const currentMin = listingMetaByProductId[pid].listingCreatedAtMinMs;
        listingMetaByProductId[pid].listingCreatedAtMinMs =
          currentMin == null ? listingCreatedAtMs : Math.min(currentMin, listingCreatedAtMs);
      }

      if (normalizarStatusAnuncioAtivo(row.status)) {
        listingMetaByProductId[pid].activeCount += 1;
        const price = toDecimalOrNull(row.price) ?? toDecimalOrNull(row.base_price);
        if (price != null && price.gt(0)) {
          listingMetaByProductId[pid].priceSum = listingMetaByProductId[pid].priceSum.plus(price);
          listingMetaByProductId[pid].priceCount += 1;
        }
      }

      if (listingId) {
        for (const candidate of externalListingIdKeyVariants(listingId)) {
          listingToProductId.set(candidate, pid);
        }
      }
    }

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return {
    listingToProductId,
    listingMetaByProductId,
    listingIdsForSalesQuery: [...listingToProductId.keys()],
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} listingIds
 */
async function fetchSalesItemsByListings(supabase, userId, listingIds) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  if (!listingIds.length) return rows;

  for (const listingChunk of chunkValues(listingIds, LISTING_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("sales_order_items")
      .select("id,sales_order_id,external_listing_id,quantity,gross_amount,net_amount,raw_json,created_at")
      .eq("user_id", userId)
      .in("external_listing_id", listingChunk);
    if (error) throw error;
    if (Array.isArray(data) && data.length > 0) rows.push(...data);
  }
  return rows;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>[]} salesItems
 */
async function fetchOrdersBySalesItems(supabase, userId, salesItems) {
  const orderIds = [
    ...new Set(
      salesItems
        .map((item) => (item?.sales_order_id != null ? String(item.sales_order_id).trim() : ""))
        .filter(Boolean),
    ),
  ];
  /** @type {Map<string, Record<string, unknown>>} */
  const ordersById = new Map();
  for (const chunk of chunkValues(orderIds, ORDER_ID_CHUNK_SIZE)) {
    const page = await fetchExecutiveSummaryOrdersById(supabase, userId, chunk);
    for (const [id, order] of page) ordersById.set(id, order);
  }
  return ordersById;
}

/**
 * @param {Record<string, unknown>[]} salesItems
 * @param {Map<string, Record<string, unknown>>} ordersById
 * @param {Map<string, string>} listingToProductId
 * @param {import("../sales/saleExecutivePeriod.js").ExecutivePeriod} operationalPeriod
 * @param {import("../sales/saleExecutivePeriod.js").ExecutivePeriod} deadStockPeriod
 * @param {import("../sales/saleExecutivePeriod.js").ExecutivePeriod} lifetimePeriod
 */
function aggregateSalesByProduct(
  salesItems,
  ordersById,
  listingToProductId,
  operationalPeriod,
  deadStockPeriod,
  lifetimePeriod,
) {
  /** @type {Record<string, {
   *   qtyPeriod: number;
   *   grossPeriod: Decimal;
   *   profitPeriod: Decimal;
   *   qtyDeadWindow: number;
   *   grossLifetime: Decimal;
   *   profitLifetime: Decimal;
   *   qtyLifetime: number;
   *   lastSaleAtMs: number | null;
   * }>} */
  const byProduct = {};

  for (const item of salesItems) {
    const orderId = item?.sales_order_id != null ? String(item.sales_order_id) : "";
    const order = orderId ? ordersById.get(orderId) ?? null : null;
    if (order && !isExecutiveSummaryEligibleOrderRow(order)) continue;

    let pid = null;
    for (const candidate of externalListingIdKeyVariants(item?.external_listing_id)) {
      const hit = listingToProductId.get(candidate);
      if (hit) {
        pid = hit;
        break;
      }
    }
    if (!pid) continue;

    if (!byProduct[pid]) {
      byProduct[pid] = {
        qtyPeriod: 0,
        grossPeriod: new Decimal(0),
        profitPeriod: new Decimal(0),
        qtyDeadWindow: 0,
        grossLifetime: new Decimal(0),
        profitLifetime: new Decimal(0),
        qtyLifetime: 0,
        lastSaleAtMs: null,
      };
    }

    const saleAtMs = parseMarketplaceTimestampMs(order?.date_created_marketplace);
    if (saleAtMs != null) {
      const prevLastSale = byProduct[pid].lastSaleAtMs;
      byProduct[pid].lastSaleAtMs = prevLastSale == null ? saleAtMs : Math.max(prevLastSale, saleAtMs);
    }

    const qty = saleDetailToQty(item.quantity);
    const grossDec = saleDetailMoneyToDecimal(item.gross_amount);
    const netDec = saleDetailMoneyToDecimal(item.net_amount) ?? grossDec;
    if (grossDec == null && netDec == null) continue;
    const grossLine = grossDec ?? new Decimal(0);
    const netLine = netDec ?? grossLine;
    const { profitDec } = computeExecutiveLineRealProfit({
      item,
      qty,
      grossDec: grossLine,
      netDec: netLine,
    });

    if (orderMatchesExecutivePeriod(order, deadStockPeriod, item)) {
      byProduct[pid].qtyDeadWindow += qty;
    }

    if (orderMatchesExecutivePeriod(order, lifetimePeriod, item)) {
      byProduct[pid].grossLifetime = byProduct[pid].grossLifetime.plus(grossLine);
      byProduct[pid].qtyLifetime += qty;
      if (profitDec != null) {
        byProduct[pid].profitLifetime = byProduct[pid].profitLifetime.plus(profitDec);
      }
    }

    if (!orderMatchesExecutivePeriod(order, operationalPeriod, item)) continue;

    byProduct[pid].qtyPeriod += qty;
    byProduct[pid].grossPeriod = byProduct[pid].grossPeriod.plus(grossLine);
    if (profitDec != null) {
      byProduct[pid].profitPeriod = byProduct[pid].profitPeriod.plus(profitDec);
    }
  }

  return byProduct;
}

/** @param {Record<string, unknown>} [metadata] */
export function buildEmptyProductsHealthSummaryPayload(metadata = {}) {
  return {
    ok: true,
    source: "dashboard-products-health-summary-ssot",
    metadata,
    total_products: 0,
    period: {
      type: PRODUCT_HEALTH_ABC_SCOPE,
      label: "Histórico completo",
      source: "since_first_sync",
      start_date: null,
      end_date: null,
    },
    abc_mix: {
      title: "Curva ABC",
      scope: PRODUCT_HEALTH_ABC_SCOPE,
      total: 0,
      buckets_sum: 0,
      unclassified_count: 0,
      buckets: [],
      chart: {
        center_label: "ABC",
        center_subtitle: "Faturamento histórico",
        segments: [],
        no_sales_count: 0,
        revenue_segments_sum_percent: "0.00",
      },
    },
    stock_coverage: {
      title: "Cobertura de Estoque",
      total: 0,
      sales_window_days: 30,
      buckets_sum: 0,
      unclassified_count: 0,
      buckets: [],
      chart: { segments: [], mix_segments_sum_percent: "0.00" },
      data_quality: {
        status: "ok",
        reason: null,
        unknown_stock_count: 0,
        message: null,
      },
    },
    profitability_mix: {
      title: "Lucratividade dos Produtos",
      scope: PRODUCT_HEALTH_ABC_SCOPE,
      total: 0,
      buckets_sum: 0,
      unclassified_count: 0,
      buckets: [],
      financial_data_pending: {
        products_count: 0,
        products_share_percent: "0.00",
        message: null,
      },
      chart: {
        segments: [],
        no_sales_count: 0,
        financial_data_pending_count: 0,
        products_segments_sum_percent: "0.00",
        mix_segments_sum_percent: "0.00",
      },
      data_quality: { status: "ok", reason: null, message: null },
    },
    summary_cards: {
      dead_stock_count: 0,
      dead_stock_capital_brl: "0.00",
      dead_stock_days_threshold: PRODUCT_HEALTH_DEAD_STOCK_DAYS,
      dead_stock: {
        products_count: 0,
        products_total: 0,
        products_percent: "0.00",
        stock_value_brl: "0.00",
        days_threshold: PRODUCT_HEALTH_DEAD_STOCK_DAYS,
        window_days: PRODUCT_HEALTH_DEAD_STOCK_DAYS,
        subtitle: `0 de 0 produtos parados há +${PRODUCT_HEALTH_DEAD_STOCK_DAYS} dias`,
        tooltip:
          "Produtos sem vendas nos últimos 15 dias. Valor estimado com base no custo/estoque cadastrado.",
        missing_cost_products_count: 0,
        missing_stock_products_count: 0,
        unknown_stock_products_count: 0,
        products_with_stock_data: 0,
        products_without_stock_data: 0,
        products_with_cost_data: 0,
        products_without_cost_data: 0,
        products_with_sales_in_window: 0,
        value_calculation_source: "products.stock_quantity*unit_cost",
        sales_source: "sales_order_items+sales_orders.date_created_marketplace",
        data_quality: { status: "ok", reason: null, message: null },
      },
      stockout_risk_count: 0,
      average_markup: "0.00",
      low_markup_count: 0,
      product_turnover: {
        title: "Giro dos Produtos",
        products_with_sales_in_window: 0,
        total_products: 0,
        percent: "0.00",
        window_days: PRODUCT_HEALTH_DEAD_STOCK_DAYS,
        subtitle: `0 de 0 produtos venderam nos últimos ${PRODUCT_HEALTH_DEAD_STOCK_DAYS} dias`,
        sales_source: "sales_order_items+sales_orders.date_created_marketplace",
      },
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ periodPreset?: string; dateFrom?: string | null; dateTo?: string | null; search?: string | null; searchQuery?: string | null }} [options]
 */
export async function buildProductsHealthSummary(supabase, userId, _options = {}) {
  const lifetimeResolved = resolveExecutiveSummaryPeriod({ period_preset: "lifetime" });
  if (!lifetimeResolved.ok) {
    throw new Error(lifetimeResolved.error ?? "Período lifetime indisponível para Central de Saúde dos Produtos.");
  }

  const operationalResolved = resolveExecutiveSummaryPeriod({
    period_preset: PRODUCT_HEALTH_OPERATIONAL_PERIOD_PRESET,
  });
  if (!operationalResolved.ok) {
    throw new Error(operationalResolved.error ?? "Período operacional indisponível.");
  }

  const lifetimePeriod = lifetimeResolved.period;
  const operationalPeriod = operationalResolved.period;
  const deadStockPeriodResolved = resolveExecutiveSummaryPeriod({
    period_preset: `${PRODUCT_HEALTH_DEAD_STOCK_DAYS}d`,
  });
  if (!deadStockPeriodResolved.ok) {
    throw new Error(deadStockPeriodResolved.error ?? "Período de estoque parado indisponível.");
  }
  const deadStockPeriod = deadStockPeriodResolved.period;
  const todayUtc = new Date();

  const products = await fetchAllProducts(supabase, userId);
  const scope = await fetchProductListingScope(supabase, userId);
  const salesItems = await fetchSalesItemsByListings(supabase, userId, scope.listingIdsForSalesQuery);
  const ordersById = await fetchOrdersBySalesItems(supabase, userId, salesItems);
  const salesByProduct = aggregateSalesByProduct(
    salesItems,
    ordersById,
    scope.listingToProductId,
    operationalPeriod,
    deadStockPeriod,
    lifetimePeriod,
  );

  /** @type {Array<Record<string, unknown>>} */
  const snapshots = [];

  for (const product of products) {
    const pid = product?.id != null ? String(product.id) : "";
    if (!pid) continue;

    const sales = salesByProduct[pid] ?? {
      qtyPeriod: 0,
      grossPeriod: new Decimal(0),
      profitPeriod: new Decimal(0),
      qtyDeadWindow: 0,
      grossLifetime: new Decimal(0),
      profitLifetime: new Decimal(0),
      qtyLifetime: 0,
      lastSaleAtMs: null,
    };

    const unitCost = resolverCustoUnitarioOficialProduto(product);
    const listingMeta = scope.listingMetaByProductId[pid] ?? {
      activeCount: 0,
      priceSum: new Decimal(0),
      priceCount: 0,
      listingCreatedAtMinMs: null,
    };

    const averagePrice =
      listingMeta.priceCount > 0
        ? listingMeta.priceSum.div(listingMeta.priceCount)
        : null;

    const markupRatio =
      unitCost != null && averagePrice != null && unitCost.gt(0)
        ? averagePrice.div(unitCost)
        : null;

    const marginPercentLifetime =
      sales.grossLifetime.gt(0) && sales.profitLifetime != null
        ? formatPercentFromRatio(sales.profitLifetime, sales.grossLifetime)
        : null;

    const marginPercent =
      sales.grossPeriod.gt(0) && sales.profitPeriod != null
        ? formatPercentFromRatio(sales.profitPeriod, sales.grossPeriod)
        : null;

    const stockKnown = isStockQuantityKnown(product.stock_quantity);
    const stockQty = stockKnown ? readKnownStockQuantity(product.stock_quantity) : null;
    const productCreatedAtMs = parseMarketplaceTimestampMs(product.created_at);
    const productAgeDays = resolverIdadeProdutoDias({
      productCreatedAtMs,
      listingCreatedAtMinMs: listingMeta.listingCreatedAtMinMs,
      todayUtc,
    });
    const lastSaleAtMs = sales.lastSaleAtMs;
    const daysSinceLastSale =
      lastSaleAtMs != null ? calcularDiasCalendarioUtc(lastSaleAtMs, todayUtc) : null;
    const isDeadStock = avaliarProdutoEstoqueParado({
      stockKnown,
      stockQty,
      isActiveProduct: listingMeta.activeCount > 0,
      qtyDeadWindow: sales.qtyDeadWindow,
      lastSaleAtMs,
      productAgeDays,
      thresholdDays: PRODUCT_HEALTH_DEAD_STOCK_DAYS,
      todayUtc,
    });

    snapshots.push({
      product_id: pid,
      product_name: product.product_name ?? null,
      sku: product.sku ?? null,
      stock_quantity: stockQty,
      stock_known: stockKnown,
      gross_revenue_lifetime_brl: sales.grossLifetime,
      gross_revenue_brl: sales.grossPeriod,
      quantity_sold_lifetime: sales.qtyLifetime,
      quantity_sold_period: sales.qtyPeriod,
      recent_sales_30d: sales.qtyPeriod,
      contribution_profit_lifetime_brl: sales.profitLifetime,
      contribution_profit_brl: sales.profitPeriod,
      contribution_margin_percent_lifetime: marginPercentLifetime,
      contribution_margin_percent: marginPercent,
      has_financial_data_lifetime:
        marginPercentLifetime != null && sales.qtyLifetime > 0 && sales.grossLifetime.gt(0),
      has_financial_data: marginPercent != null && sales.qtyPeriod > 0,
      unit_cost_brl: unitCost,
      average_sale_price_brl: averagePrice,
      markup_ratio: markupRatio,
      is_active_product: listingMeta.activeCount > 0,
      is_dead_stock: isDeadStock,
      qty_dead_window: sales.qtyDeadWindow,
      qty_turnover_window: sales.qtyDeadWindow,
      last_sale_at:
        lastSaleAtMs != null ? new Date(lastSaleAtMs).toISOString().slice(0, 10) : null,
      days_since_last_sale: daysSinceLastSale,
      product_age_days: productAgeDays,
    });
  }

  const abcMix = montarDistribuicaoCurvaAbcMix(snapshots);
  const stockCoverage = montarDistribuicaoCoberturaEstoque(snapshots);
  const profitabilityMix = montarDistribuicaoLucratividadeMix(snapshots);

  const withRevenue = snapshots
    .filter((s) => toDecimalOrZero(s.gross_revenue_lifetime_brl).gt(0))
    .map((s) => ({
      product_id: String(s.product_id),
      gross_revenue_brl: toDecimalOrZero(s.gross_revenue_lifetime_brl),
    }));
  const totalRevenue = withRevenue.reduce((sum, row) => sum.plus(row.gross_revenue_brl), new Decimal(0));
  const abcCurveByProductId = classificarCurvaAbcPorFaturamento(withRevenue, totalRevenue);
  const summaryCards = montarSummaryCardsCentralSaudeProdutos(snapshots, abcCurveByProductId);

  logAuditoriaEstoqueParadoDev({
    sellerId: userId,
    thresholdDays: PRODUCT_HEALTH_DEAD_STOCK_DAYS,
    deadStock: summaryCards.dead_stock,
    snapshots,
  });

  logAuditoriaCentralSaudeEstoque({
    sellerId: userId,
    thresholdDays: PRODUCT_HEALTH_DEAD_STOCK_DAYS,
    deadStock: summaryCards.dead_stock,
    snapshots,
    dateWindowStart: deadStockPeriod.start_date ?? null,
    dateWindowEnd: deadStockPeriod.end_date ?? null,
  });

  const totalProducts = snapshots.length;

  logProductHealthDashboard("total_products", { total_products: totalProducts });
  logProductHealthDashboard("abc buckets sum", {
    buckets_sum: abcMix.buckets_sum,
    total_products: totalProducts,
  });
  logProductHealthDashboard("stock coverage buckets sum", {
    buckets_sum: stockCoverage.buckets_sum,
    total_products: totalProducts,
  });
  logProductHealthDashboard("profitability buckets sum", {
    buckets_sum: profitabilityMix.buckets_sum,
    total_products: totalProducts,
  });

  if (abcMix.unclassified_count > 0) {
    logProductHealthDashboard("unclassified product ids", { dimension: "abc_mix", count: abcMix.unclassified_count });
  }
  if (stockCoverage.unclassified_count > 0) {
    logProductHealthDashboard("unclassified product ids", {
      dimension: "stock_coverage",
      count: stockCoverage.unclassified_count,
    });
  }
  if (profitabilityMix.unclassified_count > 0) {
    logProductHealthDashboard("unclassified product ids", {
      dimension: "profitability_mix",
      count: profitabilityMix.unclassified_count,
    });
  }

  return {
    ok: true,
    source: "dashboard-products-health-summary-ssot",
    metadata: {
      marketplace_provider: PRODUCT_HEALTH_MARKETPLACE_PROVIDER,
      stock_source: "products.stock_quantity",
      cost_source: "products.cost_price+operational_cost+packaging_cost",
      sales_source: "sales_order_items+executive_orders",
      abc_revenue_scope: PRODUCT_HEALTH_ABC_SCOPE,
      profitability_scope: PRODUCT_HEALTH_ABC_SCOPE,
      operational_metrics_preset: PRODUCT_HEALTH_OPERATIONAL_PERIOD_PRESET,
      markup_price_source: summaryCards.markup_price_source,
    },
    total_products: totalProducts,
    period: {
      type: PRODUCT_HEALTH_ABC_SCOPE,
      label: "Histórico completo",
      source: "since_first_sync",
      start_date: lifetimePeriod.start_date ?? null,
      end_date: lifetimePeriod.end_date ?? null,
    },
    abc_mix: {
      title: "Curva ABC",
      scope: abcMix.scope ?? PRODUCT_HEALTH_ABC_SCOPE,
      total: abcMix.total_products,
      total_revenue_brl: abcMix.total_revenue_brl,
      buckets_sum: abcMix.buckets_sum,
      unclassified_count: abcMix.unclassified_count,
      buckets: abcMix.distribution,
      chart: abcMix.chart,
    },
    stock_coverage: {
      title: "Cobertura de Estoque",
      total: stockCoverage.total_products,
      sales_window_days: stockCoverage.sales_window_days,
      buckets_sum: stockCoverage.buckets_sum,
      unclassified_count: stockCoverage.unclassified_count,
      buckets: stockCoverage.distribution,
      chart: stockCoverage.chart,
      data_quality: stockCoverage.data_quality,
    },
    profitability_mix: {
      title: "Lucratividade dos Produtos",
      scope: profitabilityMix.scope ?? PRODUCT_HEALTH_ABC_SCOPE,
      total: profitabilityMix.total_products,
      buckets_sum: profitabilityMix.buckets_sum,
      unclassified_count: profitabilityMix.unclassified_count,
      buckets: profitabilityMix.distribution.filter((row) => row.is_main_kpi !== false),
      financial_data_pending: profitabilityMix.financial_data_pending,
      chart: profitabilityMix.chart,
      data_quality: profitabilityMix.data_quality,
    },
    summary_cards: {
      dead_stock_count: summaryCards.dead_stock_count,
      dead_stock_capital_brl: summaryCards.dead_stock_capital_brl,
      dead_stock_days_threshold: PRODUCT_HEALTH_DEAD_STOCK_DAYS,
      dead_stock: summaryCards.dead_stock,
      stockout_risk_count: summaryCards.stockout_risk_count,
      average_markup: summaryCards.average_markup,
      low_markup_count: summaryCards.low_markup_count,
      product_turnover: summaryCards.product_turnover,
    },
  };
}
