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



/**

 * Cap de linhas processadas (fetch + hidratação + agregação).

 * S7_EXECUTIVE_SUMMARY_MAX_ITEMS ou S7_EXECUTIVE_SUMMARY_MAX_ORDERS (alias temporário).

 * Default 500 — evita timeout em contas grandes com period_preset=all.

 */

export const EXECUTIVE_SUMMARY_MAX_ITEMS_SCAN = (() => {

  const raw =

    process.env.S7_EXECUTIVE_SUMMARY_MAX_ITEMS ?? process.env.S7_EXECUTIVE_SUMMARY_MAX_ORDERS ?? "500";

  const parsed = parseInt(String(raw), 10);

  const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : 500;

  return Math.min(15000, Math.max(50, cap));

})();



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

function buildExecutiveSourceItemsQuery(supabase, userId, filters, selectExpr) {

  let itemsQuery = supabase.from("sales_order_items").select(selectExpr).eq("user_id", userId);

  if (filters.marketplace) itemsQuery = itemsQuery.eq("marketplace", filters.marketplace);

  if (filters.marketplace_account_id) {

    itemsQuery = itemsQuery.eq("marketplace_account_id", filters.marketplace_account_id);

  }

  if (filters.seller_company_id) {

    itemsQuery = itemsQuery.eq("seller_company_id", filters.seller_company_id);

  }

  const period = filters.period;

  if (period?.start_ms != null && Number.isFinite(period.start_ms)) {

    itemsQuery = itemsQuery.gte("created_at", new Date(period.start_ms).toISOString());

  }

  if (period?.end_ms_exclusive != null && Number.isFinite(period.end_ms_exclusive)) {

    itemsQuery = itemsQuery.lt("created_at", new Date(period.end_ms_exclusive).toISOString());

  }

  return itemsQuery;

}



/**

 * Mesmos filtros base de canal/conta/busca que a listagem /api/sales (sales_order_items).

 *

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {string} userId

 * @param {{

 *   marketplace?: string | null;

 *   marketplace_account_id?: string | null;

 *   seller_company_id?: string | null;

 *   q?: string | null;

 * }} filters

 */

export async function fetchExecutiveSummarySourceItems(supabase, userId, filters) {

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



  /**

   * @param {string} selectExpr

   */

  async function runSelect(selectExpr) {

    let itemsQuery = buildExecutiveSourceItemsQuery(supabase, userId, filters, selectExpr);

    if (qNormalized) {

      const tokens = splitSearchTokens(qNormalized);

      const orExpr = buildVendasSalesItemQOrFilter(tokens, orderIdsForSearch);

      if (!orExpr) return { data: [], error: null };

      itemsQuery = itemsQuery.or(orExpr);

    }



    return itemsQuery.order("created_at", { ascending: false }).limit(EXECUTIVE_SUMMARY_MAX_ITEMS_SCAN);

  }



  try {

    let { data, error } = await runSelect(ITEM_SELECT);



    if (error) {

      logExecutiveSourceItemsFailed(error, ITEM_SELECT);



      if (isShapeError(error)) {

        console.warn("[Suse7][executive-summary] source_items_select_fallback", {

          reason: String(/** @type {{ message?: unknown }} */ (error).message ?? error),

          fallback: "*",

        });

        ({ data, error } = await runSelect("*"));

      }



      if (error) {

        logExecutiveSourceItemsFailed(error, isShapeError(error) ? "*" : ITEM_SELECT);

        throw error;

      }

    }



    return Array.isArray(data) ? data : [];

  } catch (err) {

    if (!isShapeError(err)) {

      logExecutiveSourceItemsFailed(err, ITEM_SELECT);

    }

    throw err;

  }

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


