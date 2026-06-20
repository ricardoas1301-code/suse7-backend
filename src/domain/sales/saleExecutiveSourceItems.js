// ======================================================================

// Busca operacional de linhas para executive-summary — mesma origem que /api/sales.

// ======================================================================



import {

  buildVendasSalesItemQOrFilter,

  chunkIds,

  fetchOrderIdsFromItemTextSearch,

  fetchVendasSearchOrderIds,

  normalizeSearchQuery,

  splitSearchTokens,

} from "../../handlers/sales/_vendasSalesRows.js";



/**

 * Colunas confirmadas em sales_order_items (persist ML + migrations multiconta).

 * Não inclui product_id — produto vem de marketplace_listings na hidratação (/api/sales).

 */

const ITEM_SELECT =

  "id,sales_order_id,user_id,marketplace,marketplace_account_id,seller_company_id,external_listing_id,external_variation_id,external_order_id,external_order_item_id,title_snapshot,sku_snapshot,quantity,unit_price,gross_amount,net_amount,fee_amount,shipping_share_amount,tax_amount,thumbnail_snapshot,raw_json,created_at";

export { ITEM_SELECT };



/**
 * @deprecated Cap legado removido na DASH.4C — scan completo via saleExecutiveBatchScan.js.
 * Mantido apenas para scripts/diag que ainda importam o símbolo.
 */
export const EXECUTIVE_SUMMARY_MAX_ITEMS_SCAN = Number.POSITIVE_INFINITY;



/**

 * @param {unknown} error

 */

function isShapeError(error) {

  return (

    String(/** @type {{ code?: unknown }} */ (error)?.code ?? "") === "42703" ||

    String(/** @type {{ message?: unknown }} */ (error)?.message ?? "")

      .toLowerCase()

      .includes("column") ||

    String(/** @type {{ message?: unknown }} */ (error)?.message ?? "")

      .toLowerCase()

      .includes("schema cache")

  );

}



/**

 * @param {unknown} error

 * @param {string} selectUsed

 */

function logExecutiveSourceItemsFailed(error, selectUsed) {

  const err = /** @type {{ message?: unknown; code?: unknown; details?: unknown; hint?: unknown }} */ (

    error ?? {}

  );

  console.error("[Suse7][executive-summary] source_items_failed", {

    message: err.message ?? String(error),

    code: err.code ?? null,

    details: err.details ?? null,

    hint: err.hint ?? null,

    select: selectUsed,

  });

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @param {{

 *   marketplace?: string | null;

 *   marketplace_account_id?: string | null;

 *   seller_company_id?: string | null;

 *   q?: string | null;

 * }} filters

 * @param {string} selectExpr

 */

export function buildExecutiveSourceItemsQuery(supabase, userId, filters, selectExpr) {

  let itemsQuery = supabase.from("sales_order_items").select(selectExpr).eq("user_id", userId);

  if (filters.marketplace) itemsQuery = itemsQuery.eq("marketplace", filters.marketplace);

  if (filters.marketplace_account_id) {

    itemsQuery = itemsQuery.eq("marketplace_account_id", filters.marketplace_account_id);

  }

  if (filters.seller_company_id) {

    itemsQuery = itemsQuery.eq("seller_company_id", filters.seller_company_id);

  }

  return itemsQuery;

}

/** Paginação de sales_orders ao resolver IDs do período (scan completo, sem cap). */
export const EXECUTIVE_SUMMARY_ORDER_IDS_PAGE_SIZE = (() => {
  const raw = process.env.S7_EXECUTIVE_SUMMARY_ORDER_PAGE_SIZE ?? "1000";
  const parsed = parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(5000, Math.max(100, parsed)) : 1000;
})();

/**
 * Chunk no `.in(sales_order_id)`: muitos UUIDs num único filtro estouram o header HTTP
 * do PostgREST (Bad Request / HeadersOverflowError) — cenário típico em “Todas as contas”.
 */
export const EXECUTIVE_SUMMARY_ORDER_IDS_IN_CHUNK_SIZE = (() => {
  const raw = process.env.S7_EXECUTIVE_SUMMARY_ORDER_IN_CHUNK_SIZE ?? "100";
  const parsed = parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(200, Math.max(50, parsed)) : 100;
})();

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   marketplace?: string | null;
 *   marketplace_account_id?: string | null;
 *   seller_company_id?: string | null;
 *   period?: { start_ms: number | null; end_ms_exclusive: number | null };
 * }} filters
 * @returns {Promise<string[]>}
 */
export async function fetchAllExecutiveSummaryOrderIdsByPeriod(supabase, userId, filters) {
  const period = filters.period;
  const hasPeriod =
    (period?.start_ms != null && Number.isFinite(period.start_ms)) ||
    (period?.end_ms_exclusive != null && Number.isFinite(period.end_ms_exclusive));
  if (!hasPeriod) return [];

  /** @type {string[]} */
  const allIds = [];
  const pageSize = EXECUTIVE_SUMMARY_ORDER_IDS_PAGE_SIZE;
  let offset = 0;

  while (true) {
    let q = supabase.from("sales_orders").select("id").eq("user_id", userId);

    if (filters.marketplace) q = q.eq("marketplace", filters.marketplace);
    if (filters.marketplace_account_id) q = q.eq("marketplace_account_id", filters.marketplace_account_id);
    if (filters.seller_company_id) q = q.eq("seller_company_id", filters.seller_company_id);

    if (period?.start_ms != null && Number.isFinite(period.start_ms)) {
      q = q.gte("date_created_marketplace", new Date(period.start_ms).toISOString());
    }
    if (period?.end_ms_exclusive != null && Number.isFinite(period.end_ms_exclusive)) {
      q = q.lt("date_created_marketplace", new Date(period.end_ms_exclusive).toISOString());
    }

    const { data, error } = await q
      .order("date_created_marketplace", { ascending: false, nullsFirst: false })
      .range(offset, offset + pageSize - 1);

    if (error) throw error;

    const page = Array.isArray(data) ? data.map((r) => String(r?.id ?? "")).filter(Boolean) : [];
    allIds.push(...page);

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return [...new Set(allIds)];
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   marketplace?: string | null;
 *   marketplace_account_id?: string | null;
 *   seller_company_id?: string | null;
 *   q?: string | null;
 * }} filters
 * @param {string[]} orderIds
 * @param {string[]} orderIdsForSearch
 */
async function fetchExecutiveSummaryItemsForOrderIds(
  supabase,
  userId,
  filters,
  orderIds,
  orderIdsForSearch,
) {
  if (!orderIds.length) return [];

  const qNormalized = filters.q ? normalizeSearchQuery(filters.q) : null;

  /**
   * @param {string} selectExpr
   */
  async function runSelect(selectExpr) {
    let itemsQuery = buildExecutiveSourceItemsQuery(supabase, userId, filters, selectExpr);
    itemsQuery = itemsQuery.in("sales_order_id", orderIds);

    if (qNormalized) {
      const tokens = splitSearchTokens(qNormalized);
      const orExpr = buildVendasSalesItemQOrFilter(tokens, orderIdsForSearch);
      if (!orExpr) return [];
      itemsQuery = itemsQuery.or(orExpr);
    }

    const { data, error } = await itemsQuery.order("created_at", { ascending: false });
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }

  try {
    let rows = await runSelect(ITEM_SELECT);
    if (rows.length === 0) {
      rows = await runSelect("*");
    }
    return rows;
  } catch (err) {
    if (isShapeError(err)) {
      return runSelect("*");
    }
    throw err;
  }
}

/**
 * Itera lotes completos do recorte (todos os pedidos do período, sem truncar).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   marketplace?: string | null;
 *   marketplace_account_id?: string | null;
 *   seller_company_id?: string | null;
 *   q?: string | null;
 *   period?: { start_ms: number | null; end_ms_exclusive: number | null };
 * }} filters
 * @returns {AsyncGenerator<{
 *   items: Record<string, unknown>[];
 *   ordersById: Map<string, Record<string, unknown>>;
 *   orderIds: string[];
 *   batchIndex: number;
 *   totalOrderIds: number;
 * }, void, void>}
 */
export async function* iterateExecutiveSummaryBatches(supabase, userId, filters) {
  const qNormalized = filters.q ? normalizeSearchQuery(filters.q) : null;
  /** @type {string[]} */
  let orderIdsForSearch = [];

  if (qNormalized) {
    const [fromOrders, fromItems] = await Promise.all([
      fetchVendasSearchOrderIds(supabase, userId, qNormalized, 800),
      fetchOrderIdsFromItemTextSearch(supabase, userId, qNormalized, 1200),
    ]);
    orderIdsForSearch = [...new Set([...fromOrders, ...fromItems])];
  }

  const allOrderIds = await fetchAllExecutiveSummaryOrderIdsByPeriod(supabase, userId, filters);
  if (allOrderIds.length === 0) return;

  const chunks = chunkIds(allOrderIds, EXECUTIVE_SUMMARY_ORDER_IDS_IN_CHUNK_SIZE);
  let batchIndex = 0;

  for (const orderIds of chunks) {
    batchIndex += 1;
    const items = await fetchExecutiveSummaryItemsForOrderIds(
      supabase,
      userId,
      filters,
      orderIds,
      orderIdsForSearch,
    );
    const ordersById = await fetchExecutiveSummaryOrdersById(supabase, userId, orderIds);
    yield {
      items,
      ordersById,
      orderIds,
      batchIndex,
      totalOrderIds: allOrderIds.length,
    };
  }
}

/**
 * Compatibilidade/diag — concatena todos os lotes (sem cap de amostragem).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   marketplace?: string | null;
 *   marketplace_account_id?: string | null;
 *   seller_company_id?: string | null;
 *   q?: string | null;
 *   period?: { start_ms: number | null; end_ms_exclusive: number | null };
 * }} filters
 */
export async function fetchExecutiveSummarySourceItems(supabase, userId, filters) {
  /** @type {Record<string, unknown>[]} */
  const all = [];
  for await (const batch of iterateExecutiveSummaryBatches(supabase, userId, filters)) {
    all.push(...batch.items);
  }
  return all;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} orderIds
 */
export async function fetchExecutiveSummaryOrdersById(supabase, userId, orderIds) {

  /** @type {Map<string, Record<string, unknown>>} */

  const ordersById = new Map();

  for (const chunk of chunkIds(orderIds, 150)) {

    const { data, error } = await supabase

      .from("sales_orders")

      .select(

        "id,order_status,order_substatus,marketplace,marketplace_account_id,seller_company_id,date_created_marketplace,paid_at,date_closed_marketplace,created_at,raw_json,external_order_id",

      )

      .eq("user_id", userId)

      .in("id", chunk);

    if (error) throw error;

    for (const row of data || []) {

      if (row?.id) ordersById.set(String(row.id), row);

    }

  }

  return ordersById;

}



/**

 * @param {unknown} row

 */

export function pickExecutiveDebugOrderSnapshot(row) {

  if (!row || typeof row !== "object") return null;

  const r = /** @type {Record<string, unknown>} */ (row);

  return {

    id: r.id ?? null,

    external_order_id: r.external_order_id ?? null,

    order_status: r.order_status ?? null,

    order_substatus: r.order_substatus ?? null,

    date_created_marketplace: r.date_created_marketplace ?? null,

  };

}



/**

 * @param {unknown} row

 */

export function pickExecutiveDebugItemSnapshot(row) {

  if (!row || typeof row !== "object") return null;

  const r = /** @type {Record<string, unknown>} */ (row);

  return {

    id: r.id ?? null,

    sales_order_id: r.sales_order_id ?? null,

    external_listing_id: r.external_listing_id ?? null,

    external_order_id: r.external_order_id ?? null,

    gross_amount: r.gross_amount ?? null,

    created_at: r.created_at ?? null,

  };

}



/**

 * @param {unknown} row

 */

export function pickExecutiveDebugHydratedSnapshot(row) {

  if (!row || typeof row !== "object") return null;

  const r = /** @type {Record<string, unknown>} */ (row);

  return {

    item_id: r.item_id ?? null,

    sales_order_id: r.sales_order_id ?? null,

    listing_id_display: r.listing_id_display ?? null,

    gross_sales:

      r.financials && typeof r.financials === "object"

        ? /** @type {Record<string, unknown>} */ (r.financials).sale_price ?? null

        : null,

  };

}



/**

 * Linhas mínimas quando a hidratação completa falha (não derruba o endpoint).

 *

 * @param {Record<string, unknown>[]} items

 */

export function buildExecutiveMinimalUiRowsFromItems(items) {

  return items.map((it) => ({

    item_id: it.id,

    sales_order_id: it.sales_order_id,

    marketplace: it.marketplace,

    marketplace_account_id: it.marketplace_account_id,

    seller_company_id: it.seller_company_id,

    product_display_title: it.title_snapshot,

    sku_display: it.sku_snapshot,

    product_thumbnail_url: it.thumbnail_snapshot ?? null,

    financials: { health: "unknown" },

  }));

}



/**

 * Auto-debug em DEV/preview (sem exigir S7_EXEC_SUMMARY_DEBUG=1).

 */

export function isExecutiveSummaryDevAutoDebugEnabled() {

  if (process.env.S7_EXEC_SUMMARY_DEBUG === "1") return true;

  const nodeEnv = String(process.env.NODE_ENV ?? "").toLowerCase();

  if (nodeEnv === "development" || nodeEnv === "test") return true;

  const vercelEnv = String(process.env.VERCEL_ENV ?? "").toLowerCase();

  if (vercelEnv === "development" || vercelEnv === "preview") return true;

  const hostHints = [

    process.env.VERCEL_URL,

    process.env.VERCEL_BRANCH_URL,

    process.env.S7_PUBLIC_API_URL,

    process.env.API_BASE_URL,

  ]

    .filter(Boolean)

    .map((v) => String(v).toLowerCase());

  return hostHints.some((h) => h.includes("dev") || h.includes("localhost"));

}



/**

 * @param {Record<string, unknown>} payload

 */

export function logExecutiveSummaryZeroDebug(payload) {

  if (!isExecutiveSummaryDevAutoDebugEnabled()) return;

  console.info("[S7_EXEC_SUMMARY_ZERO_DEBUG]", payload);

}


