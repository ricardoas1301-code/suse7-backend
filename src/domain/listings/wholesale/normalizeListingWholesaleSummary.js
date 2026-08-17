// ======================================================================
// Contrato genérico de atacado — multi-marketplace (Raio-X Anúncio).
// ======================================================================

import { normalizeMercadoLivreWholesaleSummary } from "./normalizeMercadoLivreWholesaleSummary.js";

/**
 * @param {string | null | undefined} marketplace
 */
function isMercadoLivreMarketplace(marketplace) {
  const text = marketplace != null ? String(marketplace).trim().toLowerCase() : "";
  return text === "mercadolivre" || text === "mercado_livre" || text === "ml" || text.startsWith("mercado");
}

/**
 * @param {Record<string, unknown> | null | undefined} rawListing
 * @param {{ marketplace?: string | null }} [options]
 */
export function normalizeListingWholesaleSummary(rawListing, options = {}) {
  if (isMercadoLivreMarketplace(options.marketplace ?? "mercadolivre")) {
    return normalizeMercadoLivreWholesaleSummary(rawListing);
  }
  return {
    enabled: false,
    min_quantity: null,
    unit_price_brl: null,
    unit_price_label: "Não vende no atacado",
    tiers_count: 0,
    label: "Não vende no atacado",
    source: "unknown",
    source_confidence: "unknown",
  };
}

export { normalizeMercadoLivreWholesaleSummary };
