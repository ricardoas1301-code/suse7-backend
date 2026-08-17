// ======================================================================
// SSOT — anúncio dependente de SKU/produto
// A pendência existe exclusivamente enquanto marketplace_listings.product_id
// for nulo. Status do anúncio não participa deste contrato.
// ======================================================================

export const SKU_DEPENDENCY_REASON_ML_MISSING_SKU = "ml_missing_sku";
export const SKU_DEPENDENCY_REASON_PRODUCT_LINK_MISSING = "product_link_missing";

/** @param {Record<string, unknown> | null | undefined} listing */
export function projectSkuDependencyPending(listing) {
  const pending = listing?.product_id == null;
  return {
    sku_dependency_pending: pending,
    sku_dependency_reason: pending
      ? String(listing?.attention_reason ?? "") === "sku_pending_ml"
        ? SKU_DEPENDENCY_REASON_ML_MISSING_SKU
        : SKU_DEPENDENCY_REASON_PRODUCT_LINK_MISSING
      : null,
  };
}

/** @param {import("@supabase/supabase-js").SupabaseClient} supabase @param {string} userId */
export async function countSkuDependencyPendingForUser(supabase, userId) {
  const uid = String(userId || "").trim();
  if (!uid) return 0;
  const { count, error } = await supabase
    .from("marketplace_listings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", uid)
    .is("product_id", null);
  if (error) throw error;
  return Math.max(0, Number(count) || 0);
}

/** @param {unknown} raw @param {number} fallback @param {number} max */
function positiveInt(raw, fallback, max) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ page?: unknown; pageSize?: unknown; q?: unknown }} [options]
 */
export async function listSkuDependencyPendingForUser(supabase, userId, options = {}) {
  const uid = String(userId || "").trim();
  const page = positiveInt(options.page, 1, 100000);
  const pageSize = positiveInt(options.pageSize, 50, 100);
  const q = String(options.q ?? "")
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!uid) return { items: [], total: 0, page, page_size: pageSize };

  const from = (page - 1) * pageSize;
  let query = supabase
    .from("marketplace_listings")
    .select(
      "id, external_listing_id, title, raw_json, marketplace, marketplace_account_id, seller_sku, seller_custom_field, attention_reason, product_id, marketplace_accounts(account_alias, ml_nickname)",
      { count: "exact" },
    )
    .eq("user_id", uid)
    .is("product_id", null);

  if (q) {
    query = query.or(
      `title.ilike.%${q}%,external_listing_id.ilike.%${q}%,seller_sku.ilike.%${q}%,seller_custom_field.ilike.%${q}%`,
    );
  }

  const { data, count, error } = await query
    .order("api_last_seen_at", { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) throw error;

  const items = (data || []).map((row) => {
    const account = Array.isArray(row.marketplace_accounts)
      ? row.marketplace_accounts[0]
      : row.marketplace_accounts;
    const raw = row.raw_json && typeof row.raw_json === "object" ? row.raw_json : {};
    const images = Array.isArray(raw?.pictures)
      ? raw.pictures
          .map((picture) => picture?.secure_url || picture?.url)
          .filter(Boolean)
      : [];
    const projection = projectSkuDependencyPending(row);
    const imageUrl = images[0] || raw?.thumbnail || raw?.thumbnail_url || null;
    const accountAlias = account?.account_alias || account?.ml_nickname || null;
    return {
      id: row.id,
      listing_id: row.id,
      external_listing_id: row.external_listing_id,
      title: row.title,
      image_url: imageUrl,
      image: imageUrl,
      raw_json: row.raw_json ?? null,
      marketplace: row.marketplace,
      canal: row.marketplace,
      marketplace_account_id: row.marketplace_account_id,
      account_alias: accountAlias,
      conta: accountAlias || row.marketplace_account_id || null,
      seller_sku: row.seller_custom_field || row.seller_sku || null,
      reason: projection.sku_dependency_reason,
      ...projection,
    };
  });

  return { items, total: Math.max(0, Number(count) || 0), page, page_size: pageSize };
}
