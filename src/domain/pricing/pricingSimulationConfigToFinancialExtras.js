// ======================================================
// Converte config persistida (raw_json / health) → extras PI da engine homologada.
// ======================================================

/**
 * @param {Record<string, { enabled?: boolean; percent?: string | null }> | null | undefined} config
 * @returns {import("./aplicarExtrasPrecificacaoInteligente.js").ExtrasPrecificacaoInteligenteInput}
 */
export function pricingSimulationConfigToFinancialExtras(config) {
  const c = config != null && typeof config === "object" ? config : {};
  /** @param {string} key */
  const read = (key) => {
    const node = c[key];
    if (!node || typeof node !== "object") return { enabled: false, percent: null };
    const n = /** @type {Record<string, unknown>} */ (node);
    const enabled = n.enabled === true || String(n.enabled ?? "").toLowerCase() === "true";
    const pctRaw = n.percent ?? n.pct;
    const percent =
      pctRaw != null && String(pctRaw).trim() !== "" ? String(pctRaw).trim().replace(",", ".") : null;
    return { enabled, percent };
  };

  const promo = read("planned_promo");
  const ads = read("ml_ads");
  const aff = read("affiliates");
  const reserve = read("safety_reserve");

  return {
    plannedPromoEnabled: promo.enabled,
    plannedPromoPercent: promo.percent,
    affiliatesEnabled: aff.enabled,
    affiliatePercent: aff.percent,
    mlAdsEnabled: ads.enabled,
    mlAdsPercent: ads.percent,
    operationalCostEnabled: reserve.enabled,
    operationalCostPercent: reserve.percent,
  };
}

/**
 * @param {import("./listingPricingSimulationConfig.js").PricingSimulationConfig} healthConfig
 * @param {import("./listingPricingSimulationConfig.js").PricingSimulationConfig} rawConfig
 */
export function mergePricingSimulationConfigPreferHealth(healthConfig, rawConfig) {
  /** @type {import("./listingPricingSimulationConfig.js").PricingSimulationConfig} */
  const out = { ...rawConfig };
  for (const [key, val] of Object.entries(healthConfig ?? {})) {
    if (val && (val.enabled === true || val.percent != null)) {
      out[key] = val;
    }
  }
  return out;
}
