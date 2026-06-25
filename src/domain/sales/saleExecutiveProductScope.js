// ======================================================================
// Escopo de produto para executive-summary e listagem /api/sales.
// Resolve anúncios vinculados (marketplace_listings.product_id) — mesma
// fonte usada na hidratação de /vendas e no Raio-X da venda.
// ======================================================================

import { chunkIds } from "../../handlers/sales/_vendasSalesRows.js";

/**
 * @typedef {{
 *   product_id: string | null;
 *   sku: string | null;
 *   external_listing_ids: string[];
 *   listing_count: number;
 * }} ExecutiveProductScope
 */

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string | null | undefined} productId
 * @returns {Promise<ExecutiveProductScope>}
 */
export async function resolveExecutiveProductScope(supabase, userId, productId) {
  const pid = productId != null ? String(productId).trim() : "";
  if (!pid) {
    return { product_id: null, sku: null, external_listing_ids: [], listing_count: 0 };
  }

  /** @type {string | null} */
  let sku = null;
  const productSelectVariants = ["id,sku,normalized_sku", "id,sku"];
  for (const sel of productSelectVariants) {
    const { data, error } = await supabase
      .from("products")
      .select(sel)
      .eq("user_id", userId)
      .eq("id", pid)
      .maybeSingle();
    if (error) {
      const msg = String(error.message ?? "").toLowerCase();
      if (msg.includes("column") || String(error.code ?? "") === "42703") continue;
      throw error;
    }
    if (data) {
      const row = /** @type {Record<string, unknown>} */ (data);
      const rawSku =
        row.sku != null && String(row.sku).trim() !== ""
          ? String(row.sku).trim()
          : row.normalized_sku != null && String(row.normalized_sku).trim() !== ""
            ? String(row.normalized_sku).trim()
            : "";
      sku = rawSku || null;
    }
    break;
  }

  /** @type {string[]} */
  const externalListingIds = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("marketplace_listings")
      .select("external_listing_id")
      .eq("user_id", userId)
      .eq("product_id", pid)
      .range(offset, offset + pageSize - 1);

    if (error) throw error;

    const page = Array.isArray(data) ? data : [];
    for (const row of page) {
      const ext =
        row?.external_listing_id != null ? String(row.external_listing_id).trim() : "";
      if (ext) externalListingIds.push(ext);
    }

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  const uniq = [...new Set(externalListingIds)];

  return {
    product_id: pid,
    sku,
    external_listing_ids: uniq,
    listing_count: uniq.length,
  };
}

/**
 * Mapa external_listing_id → product_id conforme vínculo atual em marketplace_listings.
 * Usado para rankings de produto alinhados ao Raio-X (só vendas de anúncios vinculados).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<Map<string, string>>}
 */
export async function fetchExternalListingProductMap(supabase, userId) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("marketplace_listings")
      .select("external_listing_id,product_id")
      .eq("user_id", userId)
      .not("product_id", "is", null)
      .range(offset, offset + pageSize - 1);

    if (error) throw error;

    const page = Array.isArray(data) ? data : [];
    for (const row of page) {
      const ext =
        row?.external_listing_id != null ? String(row.external_listing_id).trim() : "";
      const pid = row?.product_id != null ? String(row.product_id).trim() : "";
      if (ext && pid) map.set(ext, pid);
    }

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return map;
}

/**
 * @param {ExecutiveProductScope | null | undefined} scope
 * @param {{
 *   sales_count?: number;
 *   revenue?: string | null;
 *   profit?: string | null;
 *   margin?: string | null;
 *   source?: string | null;
 * }} metrics
 */
export function logS7ProductPerformance(scope, metrics = {}) {
  console.info("[S7_PRODUCT_PERFORMANCE]", {
    product_id: scope?.product_id ?? null,
    sku: scope?.sku ?? null,
    listing_count: scope?.listing_count ?? 0,
    sales_count: metrics.sales_count ?? 0,
    revenue: metrics.revenue ?? null,
    profit: metrics.profit ?? null,
    margin: metrics.margin ?? null,
    source: metrics.source ?? null,
  });
}

/** Chunk seguro para `.in(external_listing_id)` no PostgREST. */
export const EXECUTIVE_PRODUCT_LISTING_IN_CHUNK_SIZE = 80;

/**
 * @param {string[]} listingIds
 * @returns {string[][]}
 */
export function chunkExecutiveProductListingIds(listingIds) {
  return chunkIds(listingIds, EXECUTIVE_PRODUCT_LISTING_IN_CHUNK_SIZE);
}
