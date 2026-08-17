// ======================================================================
// Contrato genérico de mídia — multi-marketplace (Raio-X Anúncio).
// ======================================================================

import { normalizeMercadoLivreMediaSummary } from "./normalizeMercadoLivreMediaSummary.js";

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
export function normalizeListingMediaSummary(rawListing, options = {}) {
  if (isMercadoLivreMarketplace(options.marketplace ?? "mercadolivre")) {
    return normalizeMercadoLivreMediaSummary(rawListing);
  }
  return {
    clips_count: 0,
    clips_label: "0",
    has_clips: false,
    source: "unknown",
    source_confidence: "unknown",
  };
}

export { normalizeMercadoLivreMediaSummary };
