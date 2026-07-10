// ======================================================================
// DEV — performance log executive-summary (gate operacional / homologação)
// ======================================================================

import { buildExecutiveSummaryPeriodDedupeFields } from "./executiveSummaryPeriodNormalize.js";

/**
 * @param {Record<string, unknown>} payload
 */
export function logSalesExecutiveSummaryPerformance(payload) {
  console.info("[S7_SALES_EXECUTIVE_SUMMARY_PERFORMANCE]", payload);
}

/**
 * @param {string} [prefix]
 */
export function createSalesExecutiveSummaryPerfTracker(prefix = "") {
  const requestId = `${prefix || "ses"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const requestReceivedAt = Date.now();
  /** @type {Record<string, number | null>} */
  const marks = {
    auth_ms: null,
    account_resolution_ms: null,
    sales_orders_query_ms: null,
    sales_items_query_ms: null,
    snapshots_query_ms: null,
    product_aggregation_ms: null,
    listing_aggregation_ms: null,
    financial_calculation_ms: null,
    top_sales_ms: null,
    top_revenue_ms: null,
    top_profit_ms: null,
    normalization_ms: null,
    serialization_ms: null,
  };

  return {
    requestId,
    requestReceivedAtIso: new Date(requestReceivedAt).toISOString(),
    mark(phase, phaseStartedAt) {
      marks[phase] = Math.max(0, Date.now() - phaseStartedAt);
    },
    setDuration(phase, durationMs) {
      marks[phase] = durationMs != null && Number.isFinite(durationMs) ? Math.max(0, durationMs) : null;
    },
    finish(extra = {}) {
      const finishedAt = Date.now();
      logSalesExecutiveSummaryPerformance({
        request_id: requestId,
        request_received_at: new Date(requestReceivedAt).toISOString(),
        auth_ms: marks.auth_ms,
        account_resolution_ms: marks.account_resolution_ms,
        sales_orders_query_ms: marks.sales_orders_query_ms,
        sales_items_query_ms: marks.sales_items_query_ms,
        snapshots_query_ms: marks.snapshots_query_ms,
        product_aggregation_ms: marks.product_aggregation_ms,
        listing_aggregation_ms: marks.listing_aggregation_ms,
        financial_calculation_ms: marks.financial_calculation_ms,
        top_sales_ms: marks.top_sales_ms,
        top_revenue_ms: marks.top_revenue_ms,
        top_profit_ms: marks.top_profit_ms,
        normalization_ms: marks.normalization_ms,
        serialization_ms: marks.serialization_ms,
        total_http_ms: finishedAt - requestReceivedAt,
        finished_at: new Date(finishedAt).toISOString(),
        ...extra,
      });
    },
  };
}

/** @type {Map<string, Promise<unknown>>} */
const inflightByKey = new Map();

/**
 * @template T
 * @param {string} dedupeKey
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function dedupeExecutiveSummaryRequest(dedupeKey, fn) {
  const key = String(dedupeKey || "").trim();
  if (!key) return fn();

  const existing = inflightByKey.get(key);
  if (existing) return /** @type {Promise<T>} */ (existing);

  const run = fn().finally(() => {
    if (inflightByKey.get(key) === run) inflightByKey.delete(key);
  });
  inflightByKey.set(key, run);
  return run;
}

/**
 * @param {Record<string, unknown>} filters
 * @param {string} userId
 */
export function buildExecutiveSummaryDedupeKey(userId, filters) {
  const periodFields = buildExecutiveSummaryPeriodDedupeFields(filters.period ?? {});
  return JSON.stringify({
    userId,
    product_id: filters.product_id ?? null,
    marketplace: filters.marketplace ?? null,
    marketplace_account_id: filters.marketplace_account_id ?? null,
    seller_company_id: filters.seller_company_id ?? null,
    q: filters.q ?? null,
    filter: filters.filter ?? "all",
    ...periodFields,
    ranking_limit: filters.ranking_limit ?? 10,
    product_ranking_limit: filters.product_ranking_limit ?? null,
  });
}
