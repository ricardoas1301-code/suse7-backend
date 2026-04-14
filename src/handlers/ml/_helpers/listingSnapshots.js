import Decimal from "decimal.js";

const DEFAULT_MARKETPLACE = "mercado_livre";

/** @param {unknown} v */
function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} v */
function money2(v) {
  const n = toNum(v);
  if (n == null) return null;
  return new Decimal(String(n)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * @param {{
 *  listing: Record<string, unknown>;
 *  health?: Record<string, unknown> | null;
 *  metrics?: Record<string, unknown> | null;
 *  capturedAt: string;
 * }} p
 */
function buildSnapshotRow(p) {
  const { listing, health, metrics, capturedAt } = p;
  const visits = metrics?.visits != null ? Math.trunc(Number(metrics.visits)) : health?.visits != null ? Math.trunc(Number(health.visits)) : 0;
  const orders = metrics?.orders_count != null ? Math.trunc(Number(metrics.orders_count)) : 0;
  const payoutVal = health?.marketplace_payout_amount_brl ?? health?.marketplace_payout_amount;
  return {
    listing_id: listing.id != null ? String(listing.id) : null,
    product_id: listing.product_id != null ? String(listing.product_id) : null,
    marketplace: listing.marketplace != null ? String(listing.marketplace) : DEFAULT_MARKETPLACE,
    price: money2(listing.price),
    promotion_price: money2(health?.promotion_price ?? health?.promotional_price_brl),
    sale_fee_amount: money2(health?.sale_fee_amount),
    shipping_cost: money2(health?.shipping_cost_amount ?? health?.shipping_cost),
    marketplace_payout_amount: money2(payoutVal),
    visits: Number.isFinite(visits) && visits > 0 ? visits : 0,
    orders: Number.isFinite(orders) && orders > 0 ? orders : 0,
    captured_at: capturedAt,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *  userId: string;
 *  listingId: string;
 *  marketplace?: string;
 *  capturedAt?: string;
 * }} input
 */
export async function createListingSnapshot(supabase, input) {
  const marketplace = input.marketplace ?? DEFAULT_MARKETPLACE;
  const capturedAt = input.capturedAt ?? new Date().toISOString();

  const { data: listing, error: lErr } = await supabase
    .from("marketplace_listings")
    .select("id, user_id, product_id, marketplace, external_listing_id, price")
    .eq("id", input.listingId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (lErr || !listing) return { ok: false, error: "listing_not_found" };

  const ext = listing.external_listing_id != null ? String(listing.external_listing_id) : "";
  const { data: health } = await supabase
    .from("marketplace_listing_health")
    .select("visits, sale_fee_amount, shipping_cost, shipping_cost_amount, marketplace_payout_amount, marketplace_payout_amount_brl, promotion_price, promotional_price_brl")
    .eq("user_id", input.userId)
    .eq("marketplace", marketplace)
    .eq("external_listing_id", ext)
    .maybeSingle();
  const { data: metrics } = await supabase
    .from("listing_sales_metrics")
    .select("orders_count")
    .eq("user_id", input.userId)
    .eq("marketplace", marketplace)
    .eq("external_listing_id", ext)
    .maybeSingle();

  const row = buildSnapshotRow({
    listing: /** @type {Record<string, unknown>} */ (listing),
    health: health && typeof health === "object" ? /** @type {Record<string, unknown>} */ (health) : null,
    metrics: metrics && typeof metrics === "object" ? /** @type {Record<string, unknown>} */ (metrics) : null,
    capturedAt,
  });
  if (!row.listing_id) return { ok: false, error: "listing_id_missing" };
  const { error: insErr } = await supabase.from("marketplace_listing_snapshots").insert(row);
  if (insErr) {
    console.warn("[listing/snapshot] insert_failed", { listingId: input.listingId, message: insErr.message });
    return { ok: false, error: insErr.message };
  }
  return { ok: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *  userId: string;
 *  marketplace?: string;
 *  capturedAt?: string;
 * }} input
 */
export async function createListingSnapshotsForUserMarketplace(supabase, input) {
  const marketplace = input.marketplace ?? DEFAULT_MARKETPLACE;
  const capturedAt = input.capturedAt ?? new Date().toISOString();

  const { data: listings, error: lErr } = await supabase
    .from("marketplace_listings")
    .select("id, user_id, product_id, marketplace, external_listing_id, price")
    .eq("user_id", input.userId)
    .eq("marketplace", marketplace);
  if (lErr || !Array.isArray(listings) || listings.length === 0) {
    return { ok: false, error: lErr?.message ?? "no_listings" };
  }

  const extIds = listings
    .map((l) => (l.external_listing_id != null ? String(l.external_listing_id) : ""))
    .filter((x) => x !== "");

  const { data: healthRows } = await supabase
    .from("marketplace_listing_health")
    .select("external_listing_id, visits, sale_fee_amount, shipping_cost, shipping_cost_amount, marketplace_payout_amount, marketplace_payout_amount_brl, promotion_price, promotional_price_brl")
    .eq("user_id", input.userId)
    .eq("marketplace", marketplace)
    .in("external_listing_id", extIds);
  const { data: metricRows } = await supabase
    .from("listing_sales_metrics")
    .select("external_listing_id, orders_count")
    .eq("user_id", input.userId)
    .eq("marketplace", marketplace)
    .in("external_listing_id", extIds);

  const healthByExt = new Map(
    (healthRows || []).map((h) => [String(h.external_listing_id ?? ""), h]),
  );
  const metricsByExt = new Map(
    (metricRows || []).map((m) => [String(m.external_listing_id ?? ""), m]),
  );

  const rows = listings
    .map((listing) => {
      const ext = listing.external_listing_id != null ? String(listing.external_listing_id) : "";
      return buildSnapshotRow({
        listing: /** @type {Record<string, unknown>} */ (listing),
        health: healthByExt.get(ext) ?? null,
        metrics: metricsByExt.get(ext) ?? null,
        capturedAt,
      });
    })
    .filter((r) => r.listing_id != null);

  if (rows.length === 0) return { ok: false, error: "no_rows" };
  const { error: insErr } = await supabase.from("marketplace_listing_snapshots").insert(rows);
  if (insErr) {
    console.warn("[listing/snapshot] bulk_insert_failed", { message: insErr.message });
    return { ok: false, error: insErr.message };
  }
  return { ok: true, inserted: rows.length };
}
