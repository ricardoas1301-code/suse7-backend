// ======================================================================

// Métricas financeiras do catálogo de produtos — SSOT via executive-summary.

// S7-HIST-001..004: sem fallback vivo, Decimal no backend, sem lucro paralelo.

// Paridade com Raio-X: uma chamada scoped por product_id (mesmo motor da aba Vendas).

// ======================================================================



import Decimal from "decimal.js";
import { externalListingIdKeyVariants } from "../../handlers/ml/_helpers/listingGridJoinKeys.js";
import { computeExecutiveLineRealProfit } from "../sales/saleExecutiveLineRealResult.js";
import {
  saleDetailMoneyToDecimal,
  saleDetailToQty,
} from "../sales/saleDetailInternalCosts.js";
import { isExecutiveSummaryEligibleOrderRow } from "../sales/saleExecutiveOrderValidity.js";
import { orderMatchesExecutivePeriod } from "../sales/saleExecutivePeriod.js";
import { fetchExecutiveSummaryOrdersById } from "../sales/saleExecutiveSourceItems.js";

const LIFETIME_PERIOD = { preset: "lifetime", start_date: null, end_date: null, start_ms: null, end_ms_exclusive: null };
const LISTING_IN_CHUNK_SIZE = 120;
const ORDER_ID_CHUNK_SIZE = 300;
const CATALOG_FINANCIAL_CACHE_TTL_MS = 60_000;

/** @type {Map<string, { expires_at: number; payload: Record<string, unknown> }>} */
const catalogFinancialCacheByUser = new Map();
/** @type {Map<string, Promise<Record<string, unknown>>>} */
const catalogFinancialInflightByUser = new Map();



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @returns {Promise<Record<string, number>>}

 */

async function fetchProductListingScope(supabase, userId) {
  /** @type {Record<string, number>} */
  const adsLinkedCountByProductId = {};
  /** @type {Map<string, string>} */
  const listingToProductId = new Map();
  /** @type {Set<string>} */
  const listingIdsForSalesQuery = new Set();
  let listingsCount = 0;

  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("marketplace_listings")
      .select("product_id,external_listing_id")
      .eq("user_id", userId)
      .not("product_id", "is", null)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;

    const page = Array.isArray(data) ? data : [];
    for (const row of page) {
      const pid = row?.product_id != null ? String(row.product_id).trim() : "";
      const listingId = row?.external_listing_id != null ? String(row.external_listing_id).trim() : "";
      if (!pid) continue;

      adsLinkedCountByProductId[pid] = (adsLinkedCountByProductId[pid] ?? 0) + 1;
      listingsCount += 1;
      if (listingId) {
        for (const candidate of externalListingIdKeyVariants(listingId)) {
          listingToProductId.set(candidate, pid);
          listingIdsForSalesQuery.add(candidate);
        }
      }
    }

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return {
    adsLinkedCountByProductId,
    listingToProductId,
    listingIdsForSalesQuery: [...listingIdsForSalesQuery],
    listingsCount,
  };
}

/**
 * @param {string[]} values
 * @param {number} size
 */
function chunkValues(values, size) {
  /** @type {string[][]} */
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

/**
 * Busca somente itens dos anúncios vinculados aos produtos do catálogo.
 * Mantém batch e evita N+1, mas não depende de snapshots financeiros parciais.
 *
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
      .select(
        "id,sales_order_id,external_listing_id,quantity,gross_amount,net_amount,raw_json,created_at",
      )
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
 * @param {unknown} v
 */
function toDecimalOrZero(v) {
  if (v == null) return new Decimal(0);
  const raw = String(v).trim().replace(",", ".");
  if (!raw) return new Decimal(0);
  try {
    return new Decimal(raw);
  } catch {
    return new Decimal(0);
  }
}



/**

 * Mesma base do Raio-X (ProductFinancialRayXPanel): ticket = faturamento ÷ unidades.

 * @param {string} pid

 * @param {Record<string, unknown> | null | undefined} summary

 */

function summaryToCatalogFinancialRow(pid, summary) {
  const s = summary ?? {};
  const qty = Math.trunc(Number(s.quantity_sold ?? 0) || 0);
  const gross = toDecimalOrZero(s.gross_sales_brl);
  const profit = toDecimalOrZero(s.contribution_profit_brl);
  const netReceived = toDecimalOrZero(s.net_received_brl);

  const averageTicket =
    qty > 0
      ? gross.div(qty).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : null;
  const margin =
    gross.gt(0)
      ? profit.div(gross).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : "0.00";
  const netReceivedStr = netReceived.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

  return {
    product_id: pid,
    quantity_sold: qty,
    gross_sales_brl: gross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    average_ticket_brl: averageTicket,
    contribution_profit_brl: profit.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    contribution_margin_percent: margin,
    net_received_brl: netReceivedStr,
    you_receive_brl: netReceivedStr,
  };
}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @param {{ startedAt?: number }} [options]

 */

export async function buildProductCatalogFinancial(supabase, userId, options = {}) {
  const cacheNow = Date.now();
  const cached = catalogFinancialCacheByUser.get(userId);
  if (cached && cached.expires_at > cacheNow) {
    console.info("[S7_CATALOG_FINANCIAL_PERF] cache_hit", {
      user_id: userId,
      cache_ttl_ms_remaining: Math.max(0, cached.expires_at - cacheNow),
      result_rows_count: Object.keys(cached.payload?.by_product_id ?? {}).length,
    });
    return cached.payload;
  }

  const inflight = catalogFinancialInflightByUser.get(userId);
  if (inflight) {
    console.info("[S7_CATALOG_FINANCIAL_PERF] inflight_join", { user_id: userId });
    return inflight;
  }

  const buildPromise = (async () => {
  const startedAt = options.startedAt ?? Date.now();
  const perfStart = Date.now();
  console.info("[S7_CATALOG_FINANCIAL_PERF] start", { user_id: userId, started_at: startedAt });
  const perf = {
    auth_done_ms: Date.now() - perfStart,
    listings_query_done_ms: 0,
    sales_query_done_ms: 0,
    aggregation_done_ms: 0,
    serialization_done_ms: 0,
  };

  const scope = await fetchProductListingScope(supabase, userId);
  const adsLinkedCountByProductId = scope.adsLinkedCountByProductId;
  perf.listings_query_done_ms = Date.now() - perfStart;
  console.info("[S7_CATALOG_FINANCIAL_PERF] listings_query_done", {
    elapsed_ms: perf.listings_query_done_ms,
    product_ids_with_ads: Object.keys(adsLinkedCountByProductId).length,
    listings_count: scope.listingsCount,
  });

  const productIds = Object.keys(adsLinkedCountByProductId);
  const salesItems = await fetchSalesItemsByListings(
    supabase,
    userId,
    scope.listingIdsForSalesQuery,
  );
  const ordersById = await fetchOrdersBySalesItems(supabase, userId, salesItems);
  /** @type {Record<string, { quantity_sold: number; gross_sales_brl: Decimal; contribution_profit_brl: Decimal; net_received_brl: Decimal; }>} */
  const totalsByProduct = {};

  for (const pid of productIds) {
    totalsByProduct[pid] = {
      quantity_sold: 0,
      gross_sales_brl: new Decimal(0),
      contribution_profit_brl: new Decimal(0),
      net_received_brl: new Decimal(0),
    };
  }

  let salesRowsIncludedCount = 0;
  let salesRowsUnmappedListingCount = 0;
  let salesRowsWithoutProfitCount = 0;
  const warnings = new Set();

  for (const item of salesItems) {
    const orderId = item?.sales_order_id != null ? String(item.sales_order_id) : "";
    const order = orderId ? ordersById.get(orderId) ?? null : null;
    if (order && !isExecutiveSummaryEligibleOrderRow(order)) continue;
    if (!orderMatchesExecutivePeriod(order, LIFETIME_PERIOD, item)) continue;

    let pid = null;
    for (const candidate of externalListingIdKeyVariants(item?.external_listing_id)) {
      const hit = scope.listingToProductId.get(candidate);
      if (hit) {
        pid = hit;
        break;
      }
    }
    if (!pid) {
      salesRowsUnmappedListingCount += 1;
      continue;
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

    const target = totalsByProduct[pid];
    if (!target) continue;
    target.quantity_sold += qty;
    target.gross_sales_brl = target.gross_sales_brl.plus(grossLine);
    target.net_received_brl = target.net_received_brl.plus(netLine);
    if (profitDec != null) {
      target.contribution_profit_brl = target.contribution_profit_brl.plus(profitDec);
    } else {
      salesRowsWithoutProfitCount += 1;
    }
    salesRowsIncludedCount += 1;
  }

  if (salesRowsUnmappedListingCount > 0) {
    warnings.add(`sales_rows_unmapped_listing:${salesRowsUnmappedListingCount}`);
  }
  if (salesRowsWithoutProfitCount > 0) {
    warnings.add(`sales_rows_without_official_profit:${salesRowsWithoutProfitCount}`);
  }
  perf.sales_query_done_ms = Date.now() - perfStart;
  console.info("[S7_CATALOG_FINANCIAL_PERF] sales_query_done", {
    elapsed_ms: perf.sales_query_done_ms,
    sales_rows_count: salesRowsIncludedCount,
    sales_rows_unmapped_listing_count: salesRowsUnmappedListingCount,
  });

  /** @type {Record<string, Record<string, unknown>>} */
  const byProductId = {};

  for (const pid of productIds) {
    const row = totalsByProduct[pid] ?? {
      quantity_sold: 0,
      gross_sales_brl: new Decimal(0),
      contribution_profit_brl: new Decimal(0),
      net_received_brl: new Decimal(0),
    };
    byProductId[pid] = summaryToCatalogFinancialRow(pid, row);
  }

  perf.aggregation_done_ms = Date.now() - perfStart;
  console.info("[S7_CATALOG_FINANCIAL_PERF] aggregation_done", {
    elapsed_ms: perf.aggregation_done_ms,
    output_rows: Object.keys(byProductId).length,
    sales_rows_included_count: salesRowsIncludedCount,
    sales_rows_without_profit_count: salesRowsWithoutProfitCount,
  });

  const result = {
    ok: true,
    source: "catalog-financial-lite-ssot",
    period: {
      preset: LIFETIME_PERIOD.preset,
      start_date: LIFETIME_PERIOD.start_date,
      end_date: LIFETIME_PERIOD.end_date,
    },
    by_product_id: byProductId,
    ads_linked_count_by_product_id: adsLinkedCountByProductId,
    data_quality: {
      status: warnings.size > 0 ? "partial" : "complete",
      warnings: [...warnings],
    },
    truncated_scan: false,
    diagnostics: {
      products_count: productIds.length,
      listings_count: scope.listingsCount,
      sales_rows_count: salesRowsIncludedCount,
      sales_rows_included_count: salesRowsIncludedCount,
      sales_rows_unmapped_listing_count: salesRowsUnmappedListingCount,
      sales_rows_without_profit_count: salesRowsWithoutProfitCount,
      result_rows_count: Object.keys(byProductId).length,
      cache_hit: false,
    },
  };

  perf.serialization_done_ms = Date.now() - perfStart;
  const totalMs = perf.serialization_done_ms;
  console.info("[S7_CATALOG_FINANCIAL_PERF] response_done", {
    total_ms: totalMs,
    auth_done_ms: perf.auth_done_ms,
    listings_query_done_ms: perf.listings_query_done_ms,
    sales_query_done_ms: perf.sales_query_done_ms,
    aggregation_done_ms: perf.aggregation_done_ms,
    serialization_done_ms: perf.serialization_done_ms,
    products_scanned_count: productIds.length,
    listings_count: scope.listingsCount,
    sales_rows_count: salesRowsIncludedCount,
    sales_rows_included_count: salesRowsIncludedCount,
    result_rows_count: Object.keys(byProductId).length,
  });

  catalogFinancialCacheByUser.set(userId, {
    expires_at: Date.now() + CATALOG_FINANCIAL_CACHE_TTL_MS,
    payload: result,
  });

  return result;
  })();

  catalogFinancialInflightByUser.set(userId, buildPromise);
  try {
    return await buildPromise;
  } finally {
    if (catalogFinancialInflightByUser.get(userId) === buildPromise) {
      catalogFinancialInflightByUser.delete(userId);
    }
  }
}

/**
 * Acumulado lifetime do produto — mesma SSOT do Raio-X do Produto / catálogo.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string | null | undefined} productId
 */
export async function resolveProductLifetimeSalesMetricsFromCatalogSsot(supabase, userId, productId) {
  const pid = productId != null ? String(productId).trim() : "";
  if (!pid) {
    return {
      product_sales_quantity: null,
      product_sales_amount_brl: null,
      source: "missing_product_id",
      fallback_used: true,
    };
  }

  const catalog = await buildProductCatalogFinancial(supabase, userId);
  const row =
    catalog?.by_product_id && typeof catalog.by_product_id === "object"
      ? /** @type {Record<string, unknown>} */ (catalog.by_product_id)[pid]
      : null;

  if (!row) {
    return {
      product_sales_quantity: null,
      product_sales_amount_brl: null,
      source: "catalog_financial_lite_ssot",
      fallback_used: false,
    };
  }

  const qtyRaw = row.quantity_sold != null ? Number(row.quantity_sold) : 0;
  const qty = Number.isFinite(qtyRaw) ? Math.trunc(qtyRaw) : 0;
  const gross =
    row.gross_sales_brl != null && String(row.gross_sales_brl).trim() !== ""
      ? String(row.gross_sales_brl).trim()
      : null;

  return {
    product_sales_quantity: qty > 0 ? String(qty) : null,
    product_sales_amount_brl: gross,
    source: "catalog_financial_lite_ssot",
    fallback_used: false,
  };
}

