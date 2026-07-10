// ======================================================================
// Factory — resolve strategy de sync de título por marketplace
// ======================================================================

import { ML_MARKETPLACE_LISTING_ALIASES } from "../../../handlers/ml/_helpers/mlMarketplace.js";
import { MercadoLivreTitleSyncStrategy } from "./MercadoLivreTitleSyncStrategy.js";

/** @type {import("./MarketplaceTitleSyncStrategy.js").MarketplaceTitleSyncStrategy[]} */
const STRATEGIES = [MercadoLivreTitleSyncStrategy];

/**
 * @param {string | null | undefined} marketplace
 * @returns {import("./MarketplaceTitleSyncStrategy.js").MarketplaceTitleSyncStrategy | null}
 */
export function resolveMarketplaceTitleSyncStrategy(marketplace) {
  const slug = String(marketplace ?? "")
    .trim()
    .toLowerCase();
  if (!slug) return null;
  if (ML_MARKETPLACE_LISTING_ALIASES.includes(slug)) {
    return MercadoLivreTitleSyncStrategy;
  }
  return STRATEGIES.find((s) => s.marketplaceSlug === slug) ?? null;
}
