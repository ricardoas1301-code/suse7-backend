// ======================================================================
// Factory — resolve strategy de sync por marketplace
// ======================================================================

import { MercadoLivreImageSyncStrategy } from "./MercadoLivreImageSyncStrategy.js";

/** @type {import("./MarketplaceImageSyncStrategy.js").MarketplaceImageSyncStrategy[]} */
const STRATEGIES = [MercadoLivreImageSyncStrategy];

/**
 * @param {string | null | undefined} marketplace
 * @returns {import("./MarketplaceImageSyncStrategy.js").MarketplaceImageSyncStrategy | null}
 */
export function resolveMarketplaceImageSyncStrategy(marketplace) {
  const slug = String(marketplace ?? "")
    .trim()
    .toLowerCase();
  if (!slug) return null;
  return STRATEGIES.find((s) => s.marketplaceSlug === slug) ?? null;
}
