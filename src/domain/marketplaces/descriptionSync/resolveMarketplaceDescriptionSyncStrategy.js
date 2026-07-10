// ======================================================================
// Factory — resolve strategy de sync de descrição por marketplace
// ======================================================================

import { ML_MARKETPLACE_LISTING_ALIASES } from "../../../handlers/ml/_helpers/mlMarketplace.js";
import { MercadoLivreDescriptionSyncStrategy } from "./MercadoLivreDescriptionSyncStrategy.js";

/** @type {import("./MarketplaceDescriptionSyncStrategy.js").MarketplaceDescriptionSyncStrategy[]} */
const STRATEGIES = [MercadoLivreDescriptionSyncStrategy];

/**
 * @param {string | null | undefined} marketplace
 * @returns {import("./MarketplaceDescriptionSyncStrategy.js").MarketplaceDescriptionSyncStrategy | null}
 */
export function resolveMarketplaceDescriptionSyncStrategy(marketplace) {
  const slug = String(marketplace ?? "")
    .trim()
    .toLowerCase();
  if (!slug) return null;
  if (ML_MARKETPLACE_LISTING_ALIASES.includes(slug)) {
    return MercadoLivreDescriptionSyncStrategy;
  }
  return STRATEGIES.find((s) => s.marketplaceSlug === slug) ?? null;
}
