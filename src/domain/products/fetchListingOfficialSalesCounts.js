// ======================================================================
// Vendas oficiais por anúncio — SSOT operacional SUS7 (sales_order_items).
// Mesma base do executive-summary / aba Anúncios do Raio-X do Produto.
// ======================================================================

import { externalListingIdKeyVariants } from "../../handlers/ml/_helpers/listingGridJoinKeys.js";
import { isExecutiveSummaryEligibleOrderRow } from "../sales/saleExecutiveOrderValidity.js";
import { orderMatchesExecutivePeriod } from "../sales/saleExecutivePeriod.js";
import { fetchExecutiveSummaryOrdersById } from "../sales/saleExecutiveSourceItems.js";
import { saleDetailToQty } from "../sales/saleDetailInternalCosts.js";

const LIFETIME_PERIOD = {
  preset: "lifetime",
  start_date: null,
  end_date: null,
  start_ms: null,
  end_ms_exclusive: null,
};
const LISTING_IN_CHUNK_SIZE = 120;
const ORDER_ID_CHUNK_SIZE = 300;

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
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} listingIds
 */
async function fetchSalesItemsByExternalListingIds(supabase, userId, listingIds) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  if (!listingIds.length) return rows;

  for (const chunk of chunkValues(listingIds, LISTING_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("sales_order_items")
      .select("id, sales_order_id, external_listing_id, quantity, created_at")
      .eq("user_id", userId)
      .in("external_listing_id", chunk);
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
 * @param {string} externalListingId
 * @param {Map<string, string>} variantToCanonical
 * @returns {string | null}
 */
function resolveCanonicalListingId(externalListingId, variantToCanonical) {
  const trimmed = String(externalListingId ?? "").trim();
  if (!trimmed) return null;
  if (variantToCanonical.has(trimmed)) return variantToCanonical.get(trimmed) ?? trimmed;
  const variants = externalListingIdKeyVariants(trimmed);
  for (const v of variants) {
    if (variantToCanonical.has(v)) return variantToCanonical.get(v) ?? v;
  }
  return variants[0] ?? trimmed;
}

/**
 * Contagem oficial de vendas por external_listing_id (histórico consolidado).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string[]} externalListingIds
 * @returns {Promise<Map<string, number>>}
 */
export async function fetchListingOfficialSalesCounts(supabase, userId, externalListingIds) {
  /** @type {Set<string>} */
  const queryIds = new Set();
  /** @type {Map<string, string>} */
  const variantToCanonical = new Map();

  for (const raw of externalListingIds) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) continue;
    const variants = externalListingIdKeyVariants(trimmed);
    const canonical = variants[0] ?? trimmed;
    variantToCanonical.set(trimmed, canonical);
    variantToCanonical.set(canonical, canonical);
    for (const v of variants) {
      queryIds.add(v);
      variantToCanonical.set(v, canonical);
    }
  }

  if (queryIds.size === 0) return new Map();

  const salesItems = await fetchSalesItemsByExternalListingIds(supabase, userId, [...queryIds]);
  const ordersById = await fetchOrdersBySalesItems(supabase, userId, salesItems);

  /** @type {Map<string, number>} */
  const counts = new Map();

  for (const item of salesItems) {
    const orderId = item?.sales_order_id != null ? String(item.sales_order_id).trim() : "";
    const order = orderId ? ordersById.get(orderId) ?? null : null;
    if (order && !isExecutiveSummaryEligibleOrderRow(order)) continue;
    if (!orderMatchesExecutivePeriod(order, LIFETIME_PERIOD, item)) continue;

    const extRaw = item?.external_listing_id != null ? String(item.external_listing_id).trim() : "";
    const canonical = resolveCanonicalListingId(extRaw, variantToCanonical);
    if (!canonical) continue;
    const qty = saleDetailToQty(item.quantity);
    counts.set(canonical, (counts.get(canonical) ?? 0) + qty);
  }

  return counts;
}

/**
 * @param {string | null | undefined} externalListingId
 * @param {Map<string, number>} countsByCanonical
 */
export function pickOfficialSalesCount(externalListingId, countsByCanonical) {
  const trimmed = String(externalListingId ?? "").trim();
  if (!trimmed || countsByCanonical.size === 0) return 0;
  for (const candidate of externalListingIdKeyVariants(trimmed)) {
    if (countsByCanonical.has(candidate)) {
      return Math.max(0, Math.trunc(Number(countsByCanonical.get(candidate)) || 0));
    }
  }
  return Math.max(0, Math.trunc(Number(countsByCanonical.get(trimmed)) || 0));
}
