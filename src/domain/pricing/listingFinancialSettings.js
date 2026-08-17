// ======================================================
// Configuração financeira por anúncio (Precificação → Raio-x).
// Persistência canônica: marketplace_listing_health + fallback raw_json.
// ======================================================

import Decimal from "decimal.js";
import {
  mergePricingSimulationConfigIntoRawJson,
  readPricingSimulationConfigFromRawJson,
} from "./listingPricingSimulationConfig.js";
import {
  fetchListingHealthCommercialRow,
  persistListingHealthCommercial,
  readCommercialFlagsFromHealthRow,
} from "./listingHealthCommercial.js";

/** @typedef {import("../sales/saleListingHealthCommercial.js").PricingSimulationConfig} PricingSimulationConfig */

export const FINANCIAL_SETTINGS_FIELD_SPECS = [
  { apiPercent: "promo_discount_percent", configKey: "planned_promo" },
  { apiPercent: "ml_ads_percent", configKey: "ml_ads" },
  { apiPercent: "affiliate_percent", configKey: "affiliates" },
  { apiPercent: "reserve_percent", configKey: "safety_reserve" },
];

/**
 * @param {unknown} raw
 * @param {string} fieldLabel
 */
export function parseFinancialSettingsPercent(raw, fieldLabel) {
  if (raw == null || String(raw).trim() === "") {
    return { percent: "0.00", enabled: false, numeric: new Decimal(0) };
  }
  let d;
  try {
    d = new Decimal(String(raw).replace(",", ".").trim());
  } catch {
    throw new Error(`${fieldLabel} inválido.`);
  }
  if (!d.isFinite()) throw new Error(`${fieldLabel} inválido.`);
  if (d.lt(0)) throw new Error(`${fieldLabel} não pode ser negativo.`);
  if (d.gt(100)) throw new Error(`${fieldLabel} não pode ser maior que 100%.`);
  const pct = d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  return { percent: pct, enabled: d.gt(0), numeric: d };
}

/**
 * @param {unknown} body
 * @returns {PricingSimulationConfig}
 */
export function parseFinancialSettingsBody(body) {
  const b = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
  /** @type {PricingSimulationConfig} */
  const config = {};

  const enabledKeysByConfig = {
    planned_promo: ["promo_discount_enabled"],
    ml_ads: ["ml_ads_enabled"],
    affiliates: ["affiliates_enabled", "affiliate_enabled"],
    safety_reserve: ["reserve_enabled", "safety_reserve_enabled"],
  };

  for (const spec of FINANCIAL_SETTINGS_FIELD_SPECS) {
    const keys = enabledKeysByConfig[spec.configKey] ?? [];
    let explicitEnabled = null;
    for (const enabledKey of keys) {
      if (b[enabledKey] === true || String(b[enabledKey] ?? "").toLowerCase() === "true") {
        explicitEnabled = true;
        break;
      }
      if (b[enabledKey] === false || String(b[enabledKey] ?? "").toLowerCase() === "false") {
        explicitEnabled = false;
        break;
      }
    }

    const parsed = parseFinancialSettingsPercent(b[spec.apiPercent], spec.apiPercent);
    const enabled = explicitEnabled != null ? explicitEnabled : parsed.enabled;

    config[spec.configKey] = {
      enabled,
      percent: enabled ? parsed.percent : null,
      amount: null,
    };
  }

  return config;
}

/**
 * @param {PricingSimulationConfig} config
 */
export function financialSettingsFromConfig(config) {
  const c = config && typeof config === "object" ? config : {};
  /** @type {Record<string, string>} */
  const out = {};

  for (const spec of FINANCIAL_SETTINGS_FIELD_SPECS) {
    const node = c[spec.configKey];
    const enabled =
      node &&
      typeof node === "object" &&
      (/** @type {Record<string, unknown>} */ (node).enabled === true ||
        String(/** @type {Record<string, unknown>} */ (node).enabled ?? "").toLowerCase() === "true");
    const pctRaw =
      node && typeof node === "object" ? /** @type {Record<string, unknown>} */ (node).percent : null;
    if (!enabled || pctRaw == null || String(pctRaw).trim() === "") {
      out[spec.apiPercent] = "0.00";
      continue;
    }
    try {
      out[spec.apiPercent] = new Decimal(String(pctRaw).replace(",", "."))
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        .toFixed(2);
    } catch {
      out[spec.apiPercent] = "0.00";
    }
  }

  return out;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} listingRow
 * @param {PricingSimulationConfig} config
 */
export async function persistListingFinancialSettings(supabase, userId, listingRow, config) {
  const listingId = listingRow.id != null ? String(listingRow.id).trim() : "";
  if (!listingId) return { ok: false, error: "listing_incomplete" };

  const nextRaw = mergePricingSimulationConfigIntoRawJson(listingRow.raw_json, config);
  const { error: upErr } = await supabase
    .from("marketplace_listings")
    .update({ raw_json: nextRaw })
    .eq("id", listingId)
    .eq("user_id", userId);

  if (upErr) {
    return { ok: false, error: upErr.message ?? "raw_json_update_failed" };
  }

  const marketplace = listingRow.marketplace != null ? String(listingRow.marketplace).trim() : "";
  const externalListingId =
    listingRow.external_listing_id != null ? String(listingRow.external_listing_id).trim() : "";

  if (marketplace && externalListingId) {
    const healthPersist = await persistListingHealthCommercial(supabase, userId, listingRow, config);
    if (!healthPersist.ok && healthPersist.error === "health_commercial_columns_missing") {
      console.warn("[pricing/financial-settings] health_columns_missing", { listing_id: listingId });
    } else if (!healthPersist.ok) {
      return { ok: false, error: healthPersist.error ?? "health_persist_failed" };
    }
  }

  const savedHealthRow =
    marketplace && externalListingId
      ? await fetchListingHealthCommercialRow(supabase, userId, marketplace, externalListingId)
      : null;
  const savedHealthConfig = readCommercialFlagsFromHealthRow(
    savedHealthRow && typeof savedHealthRow === "object" ? savedHealthRow : null,
  );
  const merged = { ...readPricingSimulationConfigFromRawJson(nextRaw), ...savedHealthConfig };

  return {
    ok: true,
    financial_settings: financialSettingsFromConfig(merged),
    source: Object.keys(savedHealthConfig).length > 0 ? "marketplace_listing_health" : "raw_json",
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} listingRow
 */
export async function readListingFinancialSettings(supabase, userId, listingRow) {
  const rawConfig = readPricingSimulationConfigFromRawJson(listingRow.raw_json);
  const marketplace = listingRow.marketplace != null ? String(listingRow.marketplace).trim() : "";
  const externalListingId =
    listingRow.external_listing_id != null ? String(listingRow.external_listing_id).trim() : "";

  let healthConfig = {};
  if (marketplace && externalListingId) {
    try {
      const healthRow = await fetchListingHealthCommercialRow(supabase, userId, marketplace, externalListingId);
      healthConfig = readCommercialFlagsFromHealthRow(
        healthRow && typeof healthRow === "object" ? healthRow : null,
      );
    } catch (err) {
      console.warn("[pricing/financial-settings] health_read_failed", {
        listing_id: listingRow.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** @type {PricingSimulationConfig} */
  const merged = { ...rawConfig };
  for (const [key, val] of Object.entries(healthConfig)) {
    if (val && (val.enabled === true || val.percent != null)) {
      merged[key] = val;
    }
  }

  return {
    config: merged,
    financial_settings: financialSettingsFromConfig(merged),
    source: Object.keys(healthConfig).length > 0 ? "marketplace_listing_health" : "raw_json",
  };
}
