// ======================================================================
// Snapshots — Central de Saúde da Concorrência (Dashboard).
// Base total: todos os marketplace_listings do seller.
// Monitoramento: competition_monitored_listings + concorrentes por anúncio.
// ======================================================================

import {
  extractOwnListingSummary,
} from "../competitionRepository.js";
import { listMonitoredListingsWithCompetitors } from "../monitoredListingsRepository.js";

const LISTINGS_SELECT = "id, external_listing_id, product_id, seller_sku, title, raw_json, marketplace";

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
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function buildCompetitionHealthListingSnapshots(supabase, userId) {
  const [allListings, monitoredRows] = await Promise.all([
    fetchAllSellerMarketplaceListings(supabase, userId),
    listMonitoredListingsWithCompetitors(supabase, userId),
  ]);

  /** @type {Map<string, Record<string, unknown>>} */
  const monitoredByListingId = new Map();
  for (const row of monitoredRows || []) {
    const key =
      row?.marketplace_listing_id != null ? String(row.marketplace_listing_id).trim() : "";
    if (key) monitoredByListingId.set(key, row);
  }

  /** @type {Array<Record<string, unknown>>} */
  const snapshots = [];

  for (const listing of allListings || []) {
    const listingId = listing?.id != null ? String(listing.id).trim() : "";
    if (!listingId) continue;

    const monitored = monitoredByListingId.get(listingId) ?? null;
    if (monitored) {
      snapshots.push({
        marketplace_listing_id: listingId,
        external_listing_id: monitored.external_listing_id ?? listing.external_listing_id ?? null,
        monitored_listing_id: monitored.monitored_listing_id ?? null,
        product_id: monitored.product_id ?? listing.product_id ?? null,
        sku: monitored.sku ?? listing.seller_sku ?? null,
        product_name: monitored.product_name ?? listing.title ?? null,
        is_monitored: true,
        competitors_count: Math.max(0, Math.trunc(Number(monitored.competitors_count) || 0)),
        competitors: Array.isArray(monitored.competitors) ? monitored.competitors : [],
        own_listing: monitored.own_listing ?? extractOwnListingSummary(listing),
      });
      continue;
    }

    snapshots.push({
      marketplace_listing_id: listingId,
      external_listing_id: listing.external_listing_id ?? null,
      monitored_listing_id: null,
      product_id: listing.product_id ?? null,
      sku: listing.seller_sku ?? null,
      product_name: listing.title ?? null,
      is_monitored: false,
      competitors_count: 0,
      competitors: [],
      own_listing: extractOwnListingSummary(listing),
    });
  }

  return snapshots;
}
