// ======================================================================
// Snapshots batch — Central de Saúde da Precificação (Dashboard).
// marketplace_listings + products + marketplace_listing_health + imposto seller.
// ======================================================================

import { externalListingIdKeyVariants } from "../../../handlers/ml/_helpers/listingGridJoinKeys.js";
import { fetchAllListingHealthRowsCompat } from "../../../handlers/ml/_helpers/mlHealthSchemaCompat.js";
import { montarSnapshotPrecificacaoAnuncio } from "./pricingHealthFinancialHelpers.js";
import { enriquecerSnapshotPrecificacaoAnuncio } from "./pricingHealthListingAttributes.js";

const LISTINGS_SELECT =
  "id, external_listing_id, product_id, seller_sku, title, price, base_price, attention_reason, marketplace, listing_type_id, raw_json, products(product_name, sku, cost_price, operational_cost, packaging_cost)";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function fetchAllSellerMarketplaceListings(supabase, userId) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("marketplace_listings")
      .select(LISTINGS_SELECT)
      .eq("user_id", userId)
      .order("api_last_seen_at", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
async function fetchSellerTaxPct(supabase, userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("imposto_percentual")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.warn("[S7_PRICING_HEALTH] seller_tax_query", error);
    return null;
  }
  return data?.imposto_percentual != null && String(data.imposto_percentual).trim() !== ""
    ? String(data.imposto_percentual).trim()
    : null;
}

/**
 * @param {Record<string, unknown>[]} healthRows
 */
function indexHealthRowsByExternalListingId(healthRows) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  for (const row of healthRows || []) {
    const ext =
      row?.external_listing_id != null ? String(row.external_listing_id).trim() : "";
    if (!ext) continue;
    for (const variant of externalListingIdKeyVariants(ext)) {
      if (!map.has(variant)) map.set(variant, row);
    }
  }
  return map;
}

/**
 * @param {Record<string, unknown>} listingRow
 */
function extrairCustosProdutoDoListing(listingRow) {
  const prodRel = listingRow.products;
  const prod =
    Array.isArray(prodRel) && prodRel[0] && typeof prodRel[0] === "object"
      ? /** @type {Record<string, unknown>} */ (prodRel[0])
      : prodRel && typeof prodRel === "object"
        ? /** @type {Record<string, unknown>} */ (prodRel)
        : null;

  if (!prod) return null;

  return {
    product_name: prod.product_name ?? listingRow.title ?? null,
    sku: prod.sku ?? listingRow.seller_sku ?? null,
    cost_price: prod.cost_price ?? null,
    operational_cost: prod.operational_cost ?? null,
    packaging_cost: prod.packaging_cost ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function buildPricingHealthListingSnapshots(supabase, userId) {
  const [allListings, healthResult, sellerTaxPct] = await Promise.all([
    fetchAllSellerMarketplaceListings(supabase, userId),
    fetchAllListingHealthRowsCompat(supabase, userId),
    fetchSellerTaxPct(supabase, userId),
  ]);

  if (healthResult.error) {
    console.warn("[S7_PRICING_HEALTH] health_query_partial", healthResult.error);
  }

  const healthByExtId = indexHealthRowsByExternalListingId(
    Array.isArray(healthResult.data) ? healthResult.data : [],
  );

  /** @type {Array<Record<string, unknown>>} */
  const snapshots = [];

  for (const listingRow of allListings || []) {
    const listingId = listingRow?.id != null ? String(listingRow.id).trim() : "";
    if (!listingId) continue;

    const ext =
      listingRow.external_listing_id != null ? String(listingRow.external_listing_id).trim() : "";
    let health = null;
    if (ext) {
      for (const variant of externalListingIdKeyVariants(ext)) {
        const hit = healthByExtId.get(variant);
        if (hit) {
          health = hit;
          break;
        }
      }
    }

    const productCosts = extrairCustosProdutoDoListing(listingRow);
    const { products: _products, ...listing } = listingRow;

    snapshots.push(
      enriquecerSnapshotPrecificacaoAnuncio(
        montarSnapshotPrecificacaoAnuncio({
          listing,
          health,
          productCosts,
          sellerTaxPct,
        }),
        { listing, health },
      ),
    );
  }

  return snapshots;
}
