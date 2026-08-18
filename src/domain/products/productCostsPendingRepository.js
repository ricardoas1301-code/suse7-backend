// ======================================================================
// Repositório canônico — produtos com custos incompletos (SSOT public.products)
// countPendingProductCosts + listPendingProductCosts compartilham mesma regra.
// ======================================================================

import { isProductCostsIncomplete } from "./persistProductCosts.js";

/** Filtro SQL alinhado ao domínio isProductCostsIncomplete (campos numéricos SSOT). */
export const PENDING_PRODUCT_COSTS_OR_FILTER =
  "cost_price.is.null,cost_price.lte.0,packaging_cost.is.null,operational_cost.is.null";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

function parsePositiveInt(raw, fallback) {
  const n = parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function escapeIlikePattern(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/[%_,]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

/**
 * Contagem leve — sem hidratar registros completos.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{ ok: true; count: number } | { ok: false; error: string }>}
 */
export async function countPendingProductCosts(supabase, userId) {
  const { count, error } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .or(PENDING_PRODUCT_COSTS_OR_FILTER);

  if (error) {
    return { ok: false, error: error.message || "Erro ao contar produtos pendentes" };
  }

  return { ok: true, count: typeof count === "number" && count >= 0 ? count : 0 };
}

/**
 * @param {Record<string, unknown>[]} listingRows
 */
function buildLinkedListingsCountByProductId(listingRows) {
  /** @type {Record<string, number>} */
  const map = {};
  for (const row of listingRows || []) {
    const pid = row?.product_id != null ? String(row.product_id).trim() : "";
    if (!pid) continue;
    map[pid] = (map[pid] || 0) + 1;
  }
  return map;
}

/**
 * Lista paginada de produtos com custos incompletos.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ page?: number; pageSize?: number; q?: string }} [options]
 */
export async function listPendingProductCosts(supabase, userId, options = {}) {
  const page = parsePositiveInt(options.page, 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, parsePositiveInt(options.pageSize, DEFAULT_PAGE_SIZE));
  const qRaw = escapeIlikePattern(options.q);
  const offset = (page - 1) * pageSize;

  let query = supabase
    .from("products")
    .select(
      "id, product_name, sku, cost_price, packaging_cost, operational_cost, catalog_source, product_image_links ( storage_path, sort_order, is_primary )",
      { count: "exact" }
    )
    .eq("user_id", userId)
    .or(PENDING_PRODUCT_COSTS_OR_FILTER)
    .order("product_name", { ascending: true });

  if (qRaw) {
    const pattern = `%${qRaw}%`;
    query = query.or(`product_name.ilike.${pattern},sku.ilike.${pattern}`);
  }

  const { data: rows, error, count } = await query.range(offset, offset + pageSize - 1);
  if (error) {
    return { ok: false, error: error.message || "Erro ao listar produtos pendentes" };
  }

  const filtered = (rows || []).filter((row) =>
    isProductCostsIncomplete(row?.cost_price, row?.packaging_cost, row?.operational_cost)
  );

  const productIds = filtered.map((row) => String(row.id));
  /** @type {Record<string, number>} */
  let linkedCounts = {};
  if (productIds.length > 0) {
    const { data: listingRows, error: listingError } = await supabase
      .from("marketplace_listings")
      .select("product_id")
      .eq("user_id", userId)
      .in("product_id", productIds);

    if (!listingError) {
      linkedCounts = buildLinkedListingsCountByProductId(listingRows || []);
    }
  }

  const items = filtered.map((row) => ({
    product_id: String(row.id),
    product_name: row.product_name != null ? String(row.product_name) : "",
    sku: row.sku != null ? String(row.sku) : "",
    cost_price: row.cost_price ?? null,
    packaging_cost: row.packaging_cost ?? null,
    operational_cost: row.operational_cost ?? null,
    product_image_links: Array.isArray(row.product_image_links) ? row.product_image_links : [],
    linked_listings_count: linkedCounts[String(row.id)] || 0,
  }));

  const total = typeof count === "number" ? count : items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    ok: true,
    items,
    page,
    page_size: pageSize,
    total,
    total_pages: totalPages,
  };
}
