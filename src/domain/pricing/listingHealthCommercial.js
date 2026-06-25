// ======================================================
// Ajustes comerciais — persistência/leitura em marketplace_listing_health.
// ======================================================

import Decimal from "decimal.js";
import { isPostgrestMissingColumnError } from "../../handlers/ml/_helpers/mlHealthSchemaCompat.js";
import {
  HEALTH_FLAG_SPECS,
  readCommercialFlagsFromHealthRow,
} from "../sales/saleListingHealthCommercial.js";

const HEALTH_COMMERCIAL_SELECT =
  "discount_promo_enabled,discount_promo_percent,ml_ads_enabled,ml_ads_percent,affiliates_enabled,affiliates_percent,reserve_enabled,reserve_percent";

/**
 * @param {import("../sales/saleListingHealthCommercial.js").PricingSimulationConfig} config
 */
export function commercialConfigToHealthPatch(config) {
  const c = config && typeof config === "object" ? config : {};
  /** @param {string} key */
  const read = (key) => {
    const node = c[key];
    if (!node || typeof node !== "object") return { enabled: false, percent: null };
    const n = /** @type {Record<string, unknown>} */ (node);
    const enabled = n.enabled === true || String(n.enabled ?? "").toLowerCase() === "true";
    const pctRaw = n.percent ?? n.pct;
    const pct =
      pctRaw != null && String(pctRaw).trim() !== ""
        ? new Decimal(String(pctRaw).replace(",", ".")).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toNumber()
        : null;
    return { enabled, percent: pct };
  };

  const promo = read("planned_promo");
  const ads = read("ml_ads");
  const aff = read("affiliates");
  const reserve = read("safety_reserve");

  return {
    discount_promo_enabled: promo.enabled,
    discount_promo_percent: promo.percent,
    ml_ads_enabled: ads.enabled,
    ml_ads_percent: ads.percent,
    affiliates_enabled: aff.enabled,
    affiliates_percent: aff.percent,
    reserve_enabled: reserve.enabled,
    reserve_percent: reserve.percent,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ marketplace: string; external_listing_id: string; marketplace_account_id?: string | null; seller_company_id?: string | null }} listing
 * @param {import("../sales/saleListingHealthCommercial.js").PricingSimulationConfig} config
 */
export async function persistListingHealthCommercial(supabase, userId, listing, config) {
  const marketplace = listing.marketplace != null ? String(listing.marketplace).trim() : "";
  const externalListingId =
    listing.external_listing_id != null ? String(listing.external_listing_id).trim() : "";
  if (!marketplace || !externalListingId) {
    return { ok: false, error: "listing_incomplete" };
  }

  const patch = commercialConfigToHealthPatch(config);
  const row = {
    user_id: userId,
    marketplace,
    external_listing_id: externalListingId,
    ...patch,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("marketplace_listing_health")
    .upsert(row, { onConflict: "user_id,marketplace,external_listing_id" });

  if (error) {
    if (isPostgrestMissingColumnError(error)) {
      return { ok: false, error: "health_commercial_columns_missing" };
    }
    return { ok: false, error: error.message ?? "upsert_failed" };
  }

  return { ok: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplace
 * @param {string} externalListingId
 */
export async function fetchListingHealthCommercialRow(supabase, userId, marketplace, externalListingId) {
  const { data, error } = await supabase
    .from("marketplace_listing_health")
    .select(HEALTH_COMMERCIAL_SELECT)
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .eq("external_listing_id", externalListingId)
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isPostgrestMissingColumnError(error)) return null;
    throw error;
  }
  return data;
}

export { readCommercialFlagsFromHealthRow };
