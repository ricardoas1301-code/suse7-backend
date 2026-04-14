// ======================================================
// GET /api/ml/listings — repasse ao vivo via listing_prices
// quando health/métricas ainda não permitem um net_proceeds válido
// (ex.: anúncio sem vendas importadas e sync de health defasado).
// ======================================================

import { enrichItemWithListingPricesFees } from "./mercadoLibreItemsApi.js";
import { getValidMLToken } from "./mlToken.js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import { buildListingGridRow } from "./listingGridAssembler.js";
import { getListingGridRow, normalizeMarketplaceSlug } from "./listingGridJoinKeys.js";

/**
 * Monta o shape mínimo esperado por `enrichItemWithListingPricesFees` / listing_prices.
 * @param {Record<string, unknown>} listing — linha `marketplace_listings`
 */
export function listingRowToMlItemShapeForListingPrices(listing) {
  const extId =
    listing.external_listing_id != null ? String(listing.external_listing_id).trim() : "";
  const raw =
    listing.raw_json && typeof listing.raw_json === "object" && !Array.isArray(listing.raw_json)
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : {};
  const priceRaw = listing.price != null ? listing.price : raw.price ?? null;
  const price = priceRaw != null ? Number(priceRaw) : NaN;

  let siteId = raw.site_id != null ? String(raw.site_id).trim() : "";
  if (!siteId && extId) {
    const m = extId.match(/^([A-Z]{3})\d/i);
    if (m) siteId = m[1].toUpperCase();
  }

  /** @type {Record<string, unknown>} */
  const item = {
    id: extId || (listing.id != null ? String(listing.id) : ""),
    site_id: siteId,
    price: Number.isFinite(price) && price > 0 ? price : raw.price,
    currency_id: listing.currency_id ?? raw.currency_id ?? "BRL",
    category_id: raw.category_id ?? null,
    listing_type_id: listing.listing_type_id ?? raw.listing_type_id ?? null,
    base_price: listing.base_price ?? raw.base_price ?? null,
    original_price: listing.original_price ?? raw.original_price ?? null,
  };

  const sh = raw.shipping;
  if (sh && typeof sh === "object") item.shipping = sh;

  return item;
}

/**
 * Injeta taxa/frete retornados pelo enrich na linha do listing persistido (in-memory).
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown>} enriched
 */
export function mergeMlEnrichIntoMarketplaceListingRow(listing, enriched) {
  if (!enriched || typeof enriched !== "object") return { ...listing };
  const e = enriched;
  const rawBase =
    listing.raw_json && typeof listing.raw_json === "object" && !Array.isArray(listing.raw_json)
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : {};
  const raw = { ...rawBase };
  if (e.sale_fee_amount != null) raw.sale_fee_amount = e.sale_fee_amount;
  if (e.sale_fee_details != null) raw.sale_fee_details = e.sale_fee_details;
  if (e.shipping && typeof e.shipping === "object") raw.shipping = e.shipping;
  if (e.price != null) raw.price = e.price;

  return {
    ...listing,
    price: e.price != null ? e.price : listing.price,
    base_price: e.base_price != null ? e.base_price : listing.base_price,
    original_price: e.original_price != null ? e.original_price : listing.original_price,
    listing_type_id: e.listing_type_id != null ? e.listing_type_id : listing.listing_type_id,
    currency_id: e.currency_id != null ? e.currency_id : listing.currency_id,
    raw_json: raw,
  };
}

/**
 * @param {{
 *   userId: string;
 *   listings: Record<string, unknown>[];
 *   gridRows: Record<string, unknown>[];
 *   healthByKey: Map<string, Record<string, unknown>>;
 *   metricsByKey: Map<string, Record<string, unknown>>;
 *   sellerTaxPct?: string | number | null;
 * }} p
 */
export async function maybeEnrichGridRowsWithLiveListingPrices(p) {
  const { userId, listings, gridRows, healthByKey, metricsByKey, sellerTaxPct } = p;

  const max = Math.max(0, parseInt(process.env.ML_LISTINGS_LIVE_FEE_MAX ?? "50", 10) || 50);
  const conc = Math.max(1, parseInt(process.env.ML_LISTINGS_LIVE_FEE_CONCURRENCY ?? "4", 10) || 4);
  if (max === 0 || process.env.ML_LISTINGS_LIVE_FEE === "0") return gridRows;

  let accessToken = null;
  try {
    accessToken = await getValidMLToken(userId);
  } catch {
    return gridRows;
  }

  /** @type {number[]} */
  const indices = [];
  for (let i = 0; i < gridRows.length; i++) {
    const row = gridRows[i];
    const listing = /** @type {Record<string, unknown>} */ (listings[i]);
    if (normalizeMarketplaceSlug(listing.marketplace) !== ML_MARKETPLACE_SLUG) continue;
    const np = row?.net_proceeds;
    if (np && typeof np === "object" && np.has_valid_data === true) continue;
    indices.push(i);
  }

  const toProcess = indices.slice(0, max);
  if (toProcess.length === 0) return gridRows;

  for (let i = 0; i < toProcess.length; i += conc) {
    const chunk = toProcess.slice(i, i + conc);
    await Promise.all(
      chunk.map(async (idx) => {
        const listing = /** @type {Record<string, unknown>} */ (listings[idx]);
        const prevRow = gridRows[idx];
        const met = getListingGridRow(metricsByKey, listing.marketplace, listing.external_listing_id);
        const hlth = getListingGridRow(healthByKey, listing.marketplace, listing.external_listing_id);
        const cover =
          prevRow.cover_thumbnail_url ??
          prevRow.cover_image_url ??
          null;
        try {
          const itemShape = listingRowToMlItemShapeForListingPrices(listing);
          if (!itemShape.id || String(itemShape.id).trim() === "") return;
          const priceN = Number(itemShape.price);
          if (!Number.isFinite(priceN) || priceN <= 0) return;

          const enriched = await enrichItemWithListingPricesFees(
            accessToken,
            /** @type {Record<string, unknown>} */ (itemShape)
          );
          const merged = mergeMlEnrichIntoMarketplaceListingRow(listing, enriched);
          const fresh = buildListingGridRow(
            String(listing.marketplace ?? ML_MARKETPLACE_SLUG),
            merged,
            met,
            hlth,
            cover != null ? String(cover) : null,
            { sellerTaxPct: sellerTaxPct ?? null }
          );
          gridRows[idx] = {
            ...fresh,
            gallery_image_urls: prevRow.gallery_image_urls,
            gallery_image_source: prevRow.gallery_image_source,
            _listing_cover_trace: prevRow._listing_cover_trace,
          };
        } catch (err) {
          console.warn("[ml/listings] live_listing_prices_row_skip", {
            external_listing_id: listing.external_listing_id ?? null,
            message: err?.message ? String(err.message) : String(err),
          });
        }
      })
    );
  }

  return gridRows;
}
