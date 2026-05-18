// ======================================================
// Ajustes comerciais — leitura de marketplace_listing_health.
// ======================================================

import Decimal from "decimal.js";
import { extractExternalListingIdFromOrderLine } from "../../handlers/ml/_helpers/mlSalesPersist.js";
import { ML_MARKETPLACE_LISTING_ALIASES } from "../../handlers/ml/_helpers/mlMarketplace.js";
import { isPostgrestMissingColumnError } from "../../handlers/ml/_helpers/mlHealthSchemaCompat.js";

/** @typedef {{ enabled: boolean; percent: string | null; amount: string | null }} PricingSimVar */

/** @typedef {Record<string, PricingSimVar>} PricingSimulationConfig */

const HEALTH_COMMERCIAL_SELECT =
  "discount_promo_enabled,discount_promo_percent,ml_ads_enabled,ml_ads_percent,affiliates_enabled,affiliates_percent,reserve_enabled,reserve_percent";

export const HEALTH_FLAG_SPECS = [
  { flagKey: "planned_promo", enabledCol: "discount_promo_enabled", percentCol: "discount_promo_percent", label: "Desc. / promoção" },
  { flagKey: "ml_ads", enabledCol: "ml_ads_enabled", percentCol: "ml_ads_percent", label: "ML Ads" },
  { flagKey: "affiliates", enabledCol: "affiliates_enabled", percentCol: "affiliates_percent", label: "Afiliados" },
  { flagKey: "safety_reserve", enabledCol: "reserve_enabled", percentCol: "reserve_percent", label: "Reserva perdas e devoluções" },
];

const FLAG_TO_VAR = {
  planned_promo: { amount: "discount_promotion_amount", percent: "discount_promotion_percent" },
  ml_ads: { amount: "ml_ads_amount", percent: "ml_ads_percent" },
  affiliates: { amount: "affiliates_amount", percent: "affiliates_percent" },
  safety_reserve: { amount: "safety_reserve_amount", percent: "safety_reserve_percent" },
};

/**
 * @param {unknown} raw
 */
function toNum(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} grossMoney
 * @param {unknown} percentRaw
 */
export function moneyFromPercentOfGross(grossMoney, percentRaw) {
  const gross = toNum(grossMoney);
  const pct = toNum(percentRaw);
  if (gross == null || pct == null || pct === 0) return null;
  try {
    return new Decimal(gross)
      .mul(pct)
      .div(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toFixed(2);
  } catch {
    return null;
  }
}

/**
 * @param {unknown} raw
 */
function isEnabledCol(raw) {
  return raw === true || raw === 1 || String(raw ?? "").toLowerCase() === "true";
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {PricingSimulationConfig}
 */
export function readCommercialFlagsFromHealthRow(row) {
  const r = row && typeof row === "object" ? row : null;
  if (!r) return {};

  /** @type {PricingSimulationConfig} */
  const out = {};
  for (const spec of HEALTH_FLAG_SPECS) {
    const enabled = isEnabledCol(r[spec.enabledCol]);
    const pctNum = toNum(r[spec.percentCol]);
    if (!enabled && pctNum == null) continue;
    out[spec.flagKey] = {
      enabled,
      percent: pctNum != null ? String(pctNum) : null,
      amount: null,
    };
  }
  return out;
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null} order
 * @param {{
 *   listingIdDisplay?: string | null;
 *   listingExternalId?: string | null;
 *   listingMarketplace?: string | null;
 * }} hints
 */
export function resolveSaleCommercialLookup(item, order, hints = {}) {
  const listingIdDisplay =
    hints.listingIdDisplay != null && String(hints.listingIdDisplay).trim() !== ""
      ? String(hints.listingIdDisplay).trim()
      : "";
  const listingExternalId =
    hints.listingExternalId != null && String(hints.listingExternalId).trim() !== ""
      ? String(hints.listingExternalId).trim()
      : "";

  let externalListingId =
    item.external_listing_id != null && String(item.external_listing_id).trim() !== ""
      ? String(item.external_listing_id).trim()
      : "";
  if (!externalListingId && listingExternalId) externalListingId = listingExternalId;
  if (!externalListingId && listingIdDisplay) externalListingId = listingIdDisplay;
  if (!externalListingId && item.raw_json) {
    const fromRaw = extractExternalListingIdFromOrderLine(
      item.raw_json && typeof item.raw_json === "object" ? item.raw_json : null,
    );
    if (fromRaw) externalListingId = fromRaw;
  }

  let marketplace =
    item.marketplace != null && String(item.marketplace).trim() !== ""
      ? String(item.marketplace).trim()
      : order?.marketplace != null && String(order.marketplace).trim() !== ""
        ? String(order.marketplace).trim()
        : "";
  if (!marketplace && hints.listingMarketplace) {
    marketplace = String(hints.listingMarketplace).trim();
  }

  const accountId =
    item.marketplace_account_id != null && String(item.marketplace_account_id).trim() !== ""
      ? String(item.marketplace_account_id).trim()
      : order?.marketplace_account_id != null && String(order.marketplace_account_id).trim() !== ""
        ? String(order.marketplace_account_id).trim()
        : "";

  const sellerCompanyId =
    item.seller_company_id != null && String(item.seller_company_id).trim() !== ""
      ? String(item.seller_company_id).trim()
      : order?.seller_company_id != null && String(order.seller_company_id).trim() !== ""
        ? String(order.seller_company_id).trim()
        : "";

  /** @type {string[]} */
  const marketplaceCandidates = [];
  if (marketplace) marketplaceCandidates.push(marketplace);
  for (const alias of ML_MARKETPLACE_LISTING_ALIASES) {
    if (!marketplaceCandidates.includes(alias)) marketplaceCandidates.push(alias);
  }

  return {
    externalListingId,
    marketplace,
    marketplaceCandidates,
    accountId,
    sellerCompanyId,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplace
 * @param {string} externalListingId
 * @param {string} accountId
 * @param {string} sellerCompanyId
 */
async function queryHealthCommercialRow(supabase, userId, marketplace, externalListingId, accountId, sellerCompanyId) {
  /** @type {Array<{ cols: string[]; values: string[] }>} */
  const attempts = [];
  if (accountId && sellerCompanyId) {
    attempts.push({
      cols: ["marketplace_account_id", "seller_company_id"],
      values: [accountId, sellerCompanyId],
    });
  }
  if (accountId) {
    attempts.push({ cols: ["marketplace_account_id"], values: [accountId] });
  }
  if (sellerCompanyId) {
    attempts.push({ cols: ["seller_company_id"], values: [sellerCompanyId] });
  }
  attempts.push({ cols: [], values: [] });

  for (const attempt of attempts) {
    let q = supabase
      .from("marketplace_listing_health")
      .select(HEALTH_COMMERCIAL_SELECT)
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .eq("external_listing_id", externalListingId);
    for (let i = 0; i < attempt.cols.length; i++) {
      q = q.eq(attempt.cols[i], attempt.values[i]);
    }
    const { data, error } = await q.limit(1);
    if (error) {
      if (isPostgrestMissingColumnError(error)) continue;
      throw error;
    }
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (row) return row;
  }

  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {ReturnType<typeof resolveSaleCommercialLookup>} lookup
 */
export async function fetchListingHealthCommercialFlagsDetailed(supabase, userId, lookup) {
  const { externalListingId, marketplaceCandidates, accountId, sellerCompanyId } = lookup;
  if (!externalListingId) {
    return { flags: {}, row: null, marketplaceUsed: null };
  }

  for (const mkt of marketplaceCandidates) {
    if (!mkt) continue;
    try {
      const row = await queryHealthCommercialRow(
        supabase,
        userId,
        mkt,
        externalListingId,
        accountId,
        sellerCompanyId,
      );
      if (row) {
        return {
          flags: readCommercialFlagsFromHealthRow(row),
          row,
          marketplaceUsed: mkt,
        };
      }
    } catch (err) {
      if (process.env.NODE_ENV !== "production" || process.env.S7_SALES_DETAIL_COMMERCIAL_DEBUG === "1") {
        console.warn("[sales/detail] marketplace_listing_health_commercial_read_failed", {
          marketplace: mkt,
          external_listing_id: externalListingId,
          message: err && typeof err === "object" && "message" in err ? String(err.message) : String(err),
        });
      }
    }
  }

  return { flags: {}, row: null, marketplaceUsed: null };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null} order
 * @param {Parameters<typeof resolveSaleCommercialLookup>[2]} hints
 */
export async function fetchListingHealthCommercialFlags(supabase, userId, item, order, hints = {}) {
  const lookup = resolveSaleCommercialLookup(item, order, hints);
  const { flags } = await fetchListingHealthCommercialFlagsDetailed(supabase, userId, lookup);
  return flags;
}

/**
 * @param {PricingSimulationConfig} flags
 * @param {Record<string, unknown>} pricingVariables
 * @param {unknown} grossMoney
 */
export function buildCommercialAdjustmentLines(flags, pricingVariables, grossMoney) {
  /** @type {{ label: string; amount_brl: string; percent: string | null }[]} */
  const lines = [];

  for (const spec of HEALTH_FLAG_SPECS) {
    const f = flags[spec.flagKey];
    if (!f || f.enabled !== true) continue;

    const varSpec = FLAG_TO_VAR[spec.flagKey];
    const pct =
      pricingVariables[varSpec.percent] != null
        ? String(pricingVariables[varSpec.percent])
        : f.percent != null
          ? String(f.percent)
          : null;

    let amount =
      pricingVariables[varSpec.amount] != null ? String(pricingVariables[varSpec.amount]) : f.amount;
    if ((amount == null || String(amount).trim() === "") && grossMoney != null && pct != null) {
      amount = moneyFromPercentOfGross(grossMoney, pct);
    }
    if (amount == null && pct == null) continue;

    const amountBrl =
      amount != null && String(amount).trim() !== ""
        ? String(amount)
        : grossMoney != null && pct != null
          ? moneyFromPercentOfGross(grossMoney, pct)
          : null;

    lines.push({
      label: spec.label,
      amount_brl: amountBrl != null ? amountBrl : "0.00",
      percent: pct,
    });
  }

  return lines;
}

export function isSaleCommercialDebugEnabled() {
  return process.env.NODE_ENV !== "production" || process.env.S7_SALES_DETAIL_COMMERCIAL_DEBUG === "1";
}
