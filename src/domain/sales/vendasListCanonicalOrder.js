/**
 * Ordenação canônica da listagem /vendas (linhas = sales_order_items).
 *
 * PostgREST ignora `order` em `foreignTable`/`referencedTable` no embed
 * `sales_orders!inner`. Paginar pelo `created_at` do item usa a data de
 * ingestão e empurra vendas recentes para fora da primeira página quando o
 * histórico entra. A ordenação canônica é sempre:
 * 1) date_created_marketplace DESC (null por último)
 * 2) sales_orders.created_at DESC
 * 3) sales_order_items.created_at DESC
 * 4) id da linha (estabilidade)
 */

/** @param {unknown} v */
export function parseVendasListMillis(v) {
  if (v == null || String(v).trim() === "") return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {Record<string, unknown>[]} items
 * @param {Map<string, Record<string, unknown>>} ordersById
 */
export function sortSalesOrderItemsForVendasList(items, ordersById) {
  if (!Array.isArray(items) || items.length <= 1) return;

  items.sort((a, b) => {
    const oa = ordersById.get(String(a?.sales_order_id ?? ""));
    const ob = ordersById.get(String(b?.sales_order_id ?? ""));
    const ma = parseVendasListMillis(oa?.date_created_marketplace);
    const mb = parseVendasListMillis(ob?.date_created_marketplace);
    if (ma !== mb) {
      if (ma == null) return 1;
      if (mb == null) return -1;
      if (mb !== ma) return mb - ma;
    }
    const oca = parseVendasListMillis(oa?.created_at);
    const ocb = parseVendasListMillis(ob?.created_at);
    if (oca !== ocb) {
      if (oca == null) return 1;
      if (ocb == null) return -1;
      if (ocb !== oca) return ocb - oca;
    }
    const ia = parseVendasListMillis(a?.created_at);
    const ib = parseVendasListMillis(b?.created_at);
    if (ia !== ib) {
      if (ia == null) return 1;
      if (ib == null) return -1;
      return ib - ia;
    }
    const ida = String(a?.id ?? "");
    const idb = String(b?.id ?? "");
    return idb.localeCompare(ida);
  });
}

/**
 * @param {Record<string, unknown>[] | null | undefined} items
 * @returns {Map<string, Record<string, unknown>>}
 */
export function collectOrdersByIdFromEmbeddedItems(items) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  for (const row of items || []) {
    const oid = row?.sales_order_id != null ? String(row.sales_order_id) : "";
    const nested = row?.sales_orders;
    if (oid && nested && typeof nested === "object" && !Array.isArray(nested)) {
      map.set(oid, /** @type {Record<string, unknown>} */ (nested));
    }
  }
  return map;
}

/**
 * Ordena o conjunto filtrado e só então aplica offset/limit.
 * @param {Record<string, unknown>[]} items
 * @param {Map<string, Record<string, unknown>>} ordersById
 * @param {number} from
 * @param {number} pageSize
 */
export function paginateVendasItemsCanonical(items, ordersById, from, pageSize) {
  const sorted = Array.isArray(items) ? items.slice() : [];
  sortSalesOrderItemsForVendasList(sorted, ordersById);
  const size = Math.max(1, Number(pageSize) || 50);
  const start = Math.max(0, Number(from) || 0);
  return {
    pageItems: sorted.slice(start, start + size),
    total: sorted.length,
  };
}
