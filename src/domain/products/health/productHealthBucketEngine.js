// ======================================================================
// Motor exaustivo de buckets — Central de Saúde dos Produtos (Dashboard).
// Unidade: product_id único.
// ======================================================================

import Decimal from "decimal.js";
import {
  PRODUCT_HEALTH_ABC_CURVE_A_MAX_PCT,
  PRODUCT_HEALTH_ABC_CURVE_B_MAX_PCT,
  PRODUCT_HEALTH_ABC_MIX_BANDS,
  PRODUCT_HEALTH_COVERAGE_SALES_DAYS,
  PRODUCT_HEALTH_STOCK_COVERAGE_BANDS,
  PRODUCT_HEALTH_STOCK_UNKNOWN_BUCKET_KEY,
  PRODUCT_HEALTH_PROFITABILITY_BANDS,
  PRODUCT_HEALTH_PROFITABILITY_SCOPE,
  STOCK_COVERAGE_CRITICAL_MAX_DAYS,
  STOCK_COVERAGE_LOW_MAX_DAYS,
} from "./productHealthConstants.js";
import {
  formatDecimalFixed,
  formatPercentFromRatio,
  isStockQuantityKnown,
  readKnownStockQuantity,
  toDecimalOrNull,
  toDecimalOrZero,
} from "./productHealthNumericHelpers.js";
import {
  montarContagemBucketsExclusiva,
  somarBucketsDistribuicao,
  validarTotaisBuckets,
} from "../../listings/health/listingHealthBucketEngine.js";
import { montarAgregadoEstoqueParado } from "./productHealthDeadStock.js";
import { montarKpiGiroProdutos, produtoTeveVendaNaJanela } from "./productHealthTurnover.js";

const LOG_PREFIX = "[S7_PRODUCT_HEALTH_DASHBOARD]";

/** @param {string} label @param {Record<string, unknown>} [payload] */
export function logProductHealthDashboard(label, payload = {}) {
  if (process.env.NODE_ENV === "production") return;
  console.info(`${LOG_PREFIX} ${label}`, payload);
}

/**
 * @param {{
 *   stock_quantity?: number | null;
 *   stock_known?: boolean;
 *   recent_sales_30d?: number;
 *   quantity_sold_period?: number;
 * }} snapshot
 * @returns {string}
 */
export function resolverChaveBucketCoberturaEstoque(snapshot) {
  if (!produtoTeveVendaNaJanela(snapshot)) return "no_turnover";

  const stockKnown =
    snapshot.stock_known === true || isStockQuantityKnown(snapshot.stock_quantity);

  if (!stockKnown) return PRODUCT_HEALTH_STOCK_UNKNOWN_BUCKET_KEY;

  const stock = readKnownStockQuantity(snapshot.stock_quantity) ?? 0;
  const recentSales = Number(snapshot.recent_sales_30d ?? snapshot.quantity_sold_period ?? 0) || 0;

  if (stock <= 0) return "rupture";

  const dailyAvg = new Decimal(recentSales).div(PRODUCT_HEALTH_COVERAGE_SALES_DAYS);
  if (!dailyAvg.gt(0)) return "no_turnover";

  const coverageDays = new Decimal(stock).div(dailyAvg);

  if (coverageDays.lte(STOCK_COVERAGE_CRITICAL_MAX_DAYS)) return "critical";
  if (coverageDays.lte(STOCK_COVERAGE_LOW_MAX_DAYS)) return "low";
  return "healthy";
}

/**
 * @param {{
 *   quantity_sold_lifetime?: number;
 *   quantity_sold_period?: number;
 *   gross_revenue_lifetime_brl?: unknown;
 *   gross_revenue_brl?: unknown;
 *   contribution_margin_percent_lifetime?: string | null;
 *   contribution_margin_percent?: string | null;
 *   has_financial_data_lifetime?: boolean;
 *   has_financial_data?: boolean;
 * }} snapshot
 * @returns {string}
 */
export function resolverChaveBucketLucratividadeMix(snapshot) {
  const sales = Number(snapshot.quantity_sold_lifetime ?? snapshot.quantity_sold_period ?? 0) || 0;
  const grossRevenue = toDecimalOrZero(
    snapshot.gross_revenue_lifetime_brl ?? snapshot.gross_revenue_brl,
  );
  const hasFinancial =
    snapshot.has_financial_data_lifetime === true ||
    (snapshot.has_financial_data === true && snapshot.has_financial_data_lifetime == null);
  const marginRaw =
    snapshot.contribution_margin_percent_lifetime ?? snapshot.contribution_margin_percent;

  if (sales <= 0 || !grossRevenue.gt(0)) {
    return "no_sales";
  }

  if (!hasFinancial || marginRaw == null || String(marginRaw).trim() === "") {
    return "financial_data_pending";
  }

  const margin = toDecimalOrNull(marginRaw);
  if (margin == null) return "financial_data_pending";

  if (margin.isNegative()) return "loss";
  if (margin.gt(30)) return "high_profit";
  if (margin.gt(5)) return "profit";
  return "low_profit";
}

/**
 * @param {Array<{ product_id: string; gross_revenue_brl: Decimal }>} productsWithRevenue
 * @param {Decimal} totalRevenue
 * @returns {Map<string, string>}
 */
export function classificarCurvaAbcPorFaturamento(productsWithRevenue, totalRevenue) {
  /** @type {Map<string, string>} */
  const curveByProductId = new Map();

  if (!totalRevenue.gt(0) || productsWithRevenue.length === 0) {
    return curveByProductId;
  }

  const sorted = [...productsWithRevenue].sort((a, b) =>
    b.gross_revenue_brl.comparedTo(a.gross_revenue_brl),
  );

  let cumulative = new Decimal(0);
  for (const row of sorted) {
    const prevShare = totalRevenue.gt(0) ? cumulative.div(totalRevenue) : new Decimal(0);
    cumulative = cumulative.plus(row.gross_revenue_brl);

    let curveKey = "curve_c";
    if (prevShare.lt(PRODUCT_HEALTH_ABC_CURVE_A_MAX_PCT / 100)) {
      curveKey = "curve_a";
    } else if (prevShare.lt(PRODUCT_HEALTH_ABC_CURVE_B_MAX_PCT / 100)) {
      curveKey = "curve_b";
    }

    curveByProductId.set(row.product_id, curveKey);
  }

  return curveByProductId;
}

/** @param {Record<string, unknown>} snapshot */
function resolverFaturamentoHistoricoAbc(snapshot) {
  if (snapshot.gross_revenue_lifetime_brl != null) {
    return toDecimalOrZero(snapshot.gross_revenue_lifetime_brl);
  }
  return toDecimalOrZero(snapshot.gross_revenue_brl);
}

/** @param {Array<Record<string, unknown>>} snapshots */
export function montarDistribuicaoCurvaAbcMix(snapshots) {
  const totalProducts = snapshots.length;
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(PRODUCT_HEALTH_ABC_MIX_BANDS.map((b) => [b.key, 0]));
  /** @type {Record<string, Decimal>} */
  const revenueByBucket = Object.fromEntries(PRODUCT_HEALTH_ABC_MIX_BANDS.map((b) => [b.key, new Decimal(0)]));

  let totalRevenue = new Decimal(0);
  /** @type {Array<{ product_id: string; gross_revenue_brl: Decimal }>} */
  const withRevenue = [];

  for (const snapshot of snapshots) {
    const revenue = resolverFaturamentoHistoricoAbc(snapshot);
    if (revenue.gt(0)) {
      totalRevenue = totalRevenue.plus(revenue);
      withRevenue.push({
        product_id: String(snapshot.product_id ?? ""),
        gross_revenue_brl: revenue,
      });
    }
  }

  const curveByProductId = classificarCurvaAbcPorFaturamento(withRevenue, totalRevenue);

  for (const snapshot of snapshots) {
    const pid = String(snapshot.product_id ?? "");
    const revenue = resolverFaturamentoHistoricoAbc(snapshot);
    const bucketKey = revenue.gt(0) ? curveByProductId.get(pid) ?? "curve_c" : "no_sales";
    counts[bucketKey] = (counts[bucketKey] ?? 0) + 1;
    if (revenue.gt(0)) {
      revenueByBucket[bucketKey] = (revenueByBucket[bucketKey] ?? new Decimal(0)).plus(revenue);
    }
  }

  const distribution = PRODUCT_HEALTH_ABC_MIX_BANDS.map((bandDef) => ({
    key: bandDef.key,
    label: bandDef.label,
    short_label: bandDef.short_label,
    step_label: bandDef.step_label,
    severity: bandDef.severity,
    count: counts[bandDef.key] ?? 0,
    revenue_share_percent:
      bandDef.key === "no_sales"
        ? "0.00"
        : formatPercentFromRatio(revenueByBucket[bandDef.key] ?? new Decimal(0), totalRevenue),
    mix_share_percent:
      bandDef.key === "no_sales"
        ? formatPercentFromRatio(new Decimal(counts.no_sales ?? 0), new Decimal(totalProducts > 0 ? totalProducts : 0))
        : null,
    chart_color: bandDef.chart_color ?? null,
  }));

  const chartSegments = distribution
    .filter((row) => row.key !== "no_sales")
    .map((row) => ({
      key: row.key,
      label: row.label,
      short_label: row.short_label,
      count: row.count,
      revenue_share_percent: row.revenue_share_percent,
      chart_color: row.chart_color,
    }));

  const revenueSegmentsSum = chartSegments.reduce(
    (sum, row) => sum.plus(toDecimalOrZero(row.revenue_share_percent)),
    new Decimal(0),
  );

  const validation = validarTotaisBuckets(totalProducts, distribution, "abc_mix");

  return {
    total_products: totalProducts,
    scope: "lifetime",
    total_revenue_brl: formatDecimalFixed(totalRevenue),
    buckets_sum: validation.buckets_sum,
    unclassified_count: validation.unclassified_count,
    distribution,
    chart: {
      center_label: "ABC",
      center_subtitle: "Faturamento histórico",
      segments: chartSegments,
      no_sales_count: counts.no_sales ?? 0,
      revenue_segments_sum_percent: formatDecimalFixed(revenueSegmentsSum),
    },
  };
}

/** @param {number} unknownStockCount @param {number} totalProducts */
function montarQualidadeDadosCoberturaEstoque(unknownStockCount, totalProducts) {
  if (unknownStockCount <= 0) {
    return {
      status: "ok",
      reason: null,
      unknown_stock_count: 0,
      message: null,
    };
  }

  const reason =
    totalProducts > 0 && unknownStockCount >= totalProducts ? "stock_not_synced" : "unknown_stock_found";

  return {
    status: "warning",
    reason,
    unknown_stock_count: unknownStockCount,
    message: "Dados de estoque podem estar incompletos nesta conta.",
  };
}

/** @param {Array<Record<string, unknown>>} snapshots */
export function montarDistribuicaoCoberturaEstoque(snapshots) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(PRODUCT_HEALTH_STOCK_COVERAGE_BANDS.map((band) => [band.key, 0]));
  /** @type {string[]} */
  const unknownStockIds = [];

  for (const snapshot of snapshots) {
    const bucketKey = resolverChaveBucketCoberturaEstoque(snapshot);
    if (bucketKey === PRODUCT_HEALTH_STOCK_UNKNOWN_BUCKET_KEY) {
      unknownStockIds.push(String(snapshot.product_id ?? ""));
      continue;
    }
    if (counts[bucketKey] != null) {
      counts[bucketKey] += 1;
    }
  }

  const totalProducts = snapshots.length;
  const distribution = PRODUCT_HEALTH_STOCK_COVERAGE_BANDS.map((bandDef) => ({
    key: bandDef.key,
    label: bandDef.label,
    short_label: bandDef.short_label,
    step_label: bandDef.step_label,
    severity: bandDef.severity,
    count: counts[bandDef.key] ?? 0,
    mix_share_percent: formatPercentFromRatio(
      new Decimal(counts[bandDef.key] ?? 0),
      new Decimal(totalProducts > 0 ? totalProducts : 0),
    ),
    chart_color: bandDef.chart_color ?? null,
  }));

  const chartSegments = distribution
    .filter((row) => (row.count ?? 0) > 0)
    .map((row) => ({
      key: row.key,
      label: row.label,
      short_label: row.short_label,
      count: row.count,
      mix_share_percent: row.mix_share_percent,
      chart_color: row.chart_color,
    }));

  const mixSegmentsSum = chartSegments.reduce(
    (sum, row) => sum.plus(toDecimalOrZero(row.mix_share_percent)),
    new Decimal(0),
  );

  const validation = validarTotaisBuckets(totalProducts, distribution, "stock_coverage", unknownStockIds);
  const dataQuality = montarQualidadeDadosCoberturaEstoque(unknownStockIds.length, totalProducts);

  return {
    total_products: totalProducts,
    sales_window_days: PRODUCT_HEALTH_COVERAGE_SALES_DAYS,
    buckets_sum: validation.buckets_sum,
    unclassified_count: unknownStockIds.length,
    distribution,
    data_quality: dataQuality,
    chart: {
      segments: chartSegments,
      mix_segments_sum_percent: formatDecimalFixed(mixSegmentsSum),
    },
  };
}

/** @param {number} pendingCount @param {number} totalProducts */
function montarQualidadeDadosLucratividadeProdutos(pendingCount, totalProducts) {
  if (pendingCount <= 0 || totalProducts <= 0) {
    return { status: "ok", reason: null, message: null };
  }

  return {
    status: "warning",
    reason: "financial_data_pending",
    message: `${pendingCount} produto${pendingCount === 1 ? "" : "s"} com dados financeiros pendentes.`,
  };
}

/** @param {number} pendingCount @param {number} totalProducts */
function montarPendenciaFinanceiraLucratividade(pendingCount, totalProducts) {
  const productsSharePercent = formatPercentFromRatio(
    new Decimal(pendingCount),
    new Decimal(totalProducts > 0 ? totalProducts : 0),
  );

  return {
    products_count: pendingCount,
    products_share_percent: productsSharePercent,
    message:
      pendingCount > 0
        ? `${pendingCount} produto${pendingCount === 1 ? "" : "s"} com dados financeiros pendentes.`
        : null,
  };
}

/** @param {Array<Record<string, unknown>>} snapshots */
export function montarDistribuicaoLucratividadeMix(snapshots) {
  const items = snapshots.map((snapshot) => ({
    listing_id: String(snapshot.product_id ?? ""),
    snapshot,
  }));

  const { counts, unclassifiedIds } = montarContagemBucketsExclusiva(
    items,
    resolverChaveBucketLucratividadeMix,
    PRODUCT_HEALTH_PROFITABILITY_BANDS,
  );

  const totalProducts = snapshots.length;
  const distribution = PRODUCT_HEALTH_PROFITABILITY_BANDS.map((bandDef) => {
    const bucketCount = counts[bandDef.key] ?? 0;
    const productsSharePercent = formatPercentFromRatio(
      new Decimal(bucketCount),
      new Decimal(totalProducts > 0 ? totalProducts : 0),
    );

    return {
      key: bandDef.key,
      label: bandDef.label,
      short_label: bandDef.short_label,
      step_label: bandDef.step_label,
      severity: bandDef.severity,
      profit_range_label: bandDef.profit_range_label ?? null,
      count_phrase_suffix: bandDef.count_phrase_suffix ?? null,
      is_main_kpi: bandDef.is_main_kpi !== false,
      count: bucketCount,
      products_share_percent: productsSharePercent,
      mix_share_percent: productsSharePercent,
      chart_color: bandDef.chart_color ?? null,
    };
  });

  const chartSegments = distribution
    .filter((row) => row.is_main_kpi !== false && (row.count ?? 0) > 0)
    .map((row) => ({
      key: row.key,
      label: row.label,
      short_label: row.short_label,
      count: row.count,
      products_share_percent: row.products_share_percent,
      mix_share_percent: row.mix_share_percent,
      chart_color: row.chart_color,
    }));

  const mixSegmentsSum = chartSegments.reduce(
    (sum, row) => sum.plus(toDecimalOrZero(row.products_share_percent)),
    new Decimal(0),
  );

  const pendingCount = counts.financial_data_pending ?? 0;
  const validation = validarTotaisBuckets(totalProducts, distribution, "profitability_mix", unclassifiedIds);
  const dataQuality = montarQualidadeDadosLucratividadeProdutos(pendingCount, totalProducts);
  const financialDataPending = montarPendenciaFinanceiraLucratividade(pendingCount, totalProducts);

  return {
    total_products: totalProducts,
    scope: PRODUCT_HEALTH_PROFITABILITY_SCOPE,
    buckets_sum: validation.buckets_sum,
    unclassified_count: validation.unclassified_count,
    distribution,
    financial_data_pending: financialDataPending,
    data_quality: dataQuality,
    chart: {
      segments: chartSegments,
      no_sales_count: counts.no_sales ?? 0,
      financial_data_pending_count: pendingCount,
      products_segments_sum_percent: formatDecimalFixed(mixSegmentsSum),
      mix_segments_sum_percent: formatDecimalFixed(mixSegmentsSum),
    },
  };
}

/**
 * @param {Array<Record<string, unknown>>} snapshots
 * @param {Map<string, string>} abcCurveByProductId
 */
export function montarSummaryCardsCentralSaudeProdutos(snapshots, abcCurveByProductId) {
  const deadStockAgg = montarAgregadoEstoqueParado(snapshots);
  const productTurnover = montarKpiGiroProdutos(snapshots);
  let stockoutRiskCount = 0;
  let markupSum = new Decimal(0);
  let markupCount = 0;
  let lowMarkupCount = 0;
  const lowMarkupThreshold = toDecimalOrZero("1.5");

  for (const snapshot of snapshots) {
    const pid = String(snapshot.product_id ?? "");
    const recentSales = Number(snapshot.recent_sales_30d ?? 0) || 0;
    const coverageKey = resolverChaveBucketCoberturaEstoque(snapshot);
    const abcKey =
      abcCurveByProductId.get(pid) ??
      (resolverFaturamentoHistoricoAbc(snapshot).gt(0) ? "curve_c" : "no_sales");

    if (
      recentSales > 0 &&
      (coverageKey === "rupture" || coverageKey === "critical") &&
      (abcKey === "curve_a" || abcKey === "curve_b")
    ) {
      stockoutRiskCount += 1;
    }

    const markup =
      snapshot.markup_ratio instanceof Decimal
        ? snapshot.markup_ratio
        : toDecimalOrNull(snapshot.markup_ratio);
    if (markup != null && markup.gt(0)) {
      markupSum = markupSum.plus(markup);
      markupCount += 1;
      if (markup.lt(lowMarkupThreshold)) lowMarkupCount += 1;
    }
  }

  return {
    dead_stock_count: deadStockAgg.products_count,
    dead_stock_capital_brl: deadStockAgg.stock_value_brl,
    dead_stock: deadStockAgg,
    stockout_risk_count: stockoutRiskCount,
    average_markup: markupCount > 0 ? formatDecimalFixed(markupSum.div(markupCount), 2) : "0.00",
    low_markup_count: lowMarkupCount,
    product_turnover: productTurnover,
    markup_price_source: "active_listings_average_price",
  };
}

export { somarBucketsDistribuicao };
