// ======================================================
// Espelha product_health_* em marketplace_listing_health após vínculo SKU/listing.
// ======================================================

import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import { deriveProductHealthSnapshot } from "./marketplaces/mercadoLivreRaioxPricing.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplace
 * @param {string} externalListingId
 * @param {Record<string, unknown>} listingSnippet — product_id, attention_reason
 */
export async function syncListingHealthProductSnapshot(
  supabase,
  userId,
  marketplace,
  externalListingId,
  listingSnippet
) {
  const ext = String(externalListingId ?? "").trim();
  if (!ext || !supabase) return { ok: false, reason: "bad_args" };

  /** @type {Record<string, unknown> | null} */
  let productCosts = null;
  const pid = listingSnippet?.product_id != null ? String(listingSnippet.product_id).trim() : "";
  if (pid) {
    const { data: pc, error: pcErr } = await supabase
      .from("products")
      .select("product_name, sku, cost_price, packaging_cost, operational_cost")
      .eq("id", pid)
      .eq("user_id", userId)
      .maybeSingle();
    if (pcErr) {
      console.warn("[ml/health-product-snapshot] load_product_costs", pcErr);
    } else if (pc && typeof pc === "object") {
      productCosts = /** @type {Record<string, unknown>} */ (pc);
    }
  }

  const snap = deriveProductHealthSnapshot(
    {
      product_id: pid || null,
      attention_reason: listingSnippet?.attention_reason ?? null,
      product_name: productCosts?.product_name ?? null,
      product_sku: productCosts?.sku != null ? String(productCosts.sku) : null,
    },
    productCosts
  );

  const mkt = marketplace != null && String(marketplace).trim() !== "" ? String(marketplace) : ML_MARKETPLACE_SLUG;

  const { error } = await supabase
    .from("marketplace_listing_health")
    .update({
      has_product_link: snap.has_product_link,
      has_complete_costs: snap.has_complete_costs,
      product_health_status: snap.product_health_status,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("external_listing_id", ext)
    .eq("marketplace", mkt);

  if (error) {
    const msg = String(error.message || "");
    if (/column .* does not exist|42703/i.test(msg)) {
      return { ok: false, reason: "schema_migration_pending" };
    }
    console.warn("[ml/health-product-snapshot] update_failed", { ext, error });
    return { ok: false, reason: "update_error" };
  }

  return { ok: true, snapshot: snap };
}
