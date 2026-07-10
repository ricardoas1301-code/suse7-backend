// ======================================================================
// Contrato genérico de shipping_summary — multi-marketplace (Raio-X Anúncio).
// ======================================================================

import {
  buildEmptyMercadoLivreShippingSummary,
  normalizeMercadoLivreShippingSummary,
} from "./normalizeMercadoLivreShippingSummary.js";

/**
 * @param {string | null | undefined} marketplace
 */
function isMercadoLivreMarketplace(marketplace) {
  const text = marketplace != null ? String(marketplace).trim().toLowerCase() : "";
  return (
    text === "mercadolivre" ||
    text === "mercado_livre" ||
    text === "ml" ||
    text.startsWith("mercado_livre") ||
    text.startsWith("mercadolivre")
  );
}

/**
 * @param {Record<string, unknown> | null | undefined} rawListingOrShipping
 * @param {{ marketplace?: string | null }} [options]
 */
export function normalizeListingShippingSummary(rawListingOrShipping, options = {}) {
  const marketplace = options.marketplace ?? "mercadolivre";
  if (isMercadoLivreMarketplace(marketplace)) {
    return normalizeMercadoLivreShippingSummary(rawListingOrShipping);
  }
  return buildEmptyMercadoLivreShippingSummary();
}

export { normalizeMercadoLivreShippingSummary, buildEmptyMercadoLivreShippingSummary };
