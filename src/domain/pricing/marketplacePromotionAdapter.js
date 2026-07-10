// ======================================================
// Strategy/Adapter — promoções por marketplace (extensível).
// Implementações futuras: Shopee, Amazon, Shein, etc.
// ======================================================

import {
  buildCanonicalPromotionOfferContract,
  buildPromotionScenarioSsotAuditPayload,
  enrichOfficialSellerPromotionRowsFromApi,
  normalizeOfficialSellerPromotionsFromApi,
  resolveOfficialSellerPromotionFinancials,
  resolvePromotionUiFinancials,
} from "./mercadoLivreOfficialSellerPromotions.js";

/**
 * @typedef {{
 *   marketplace: string;
 *   normalizePromotionsFromApi: typeof normalizeOfficialSellerPromotionsFromApi;
 *   buildOfferContract: typeof buildCanonicalPromotionOfferContract;
 *   resolvePromotionFinancials: typeof resolveOfficialSellerPromotionFinancials;
 *   resolveUiFinancials: typeof resolvePromotionUiFinancials;
 *   enrichPromotionRows?: typeof enrichOfficialSellerPromotionRowsFromApi;
 *   buildScenarioSsotAudit: typeof buildPromotionScenarioSsotAuditPayload;
 * }} MarketplacePromotionAdapter
 */

/** @type {MarketplacePromotionAdapter} */
export const mercadoLivrePromotionAdapter = {
  marketplace: "mercado_livre",
  normalizePromotionsFromApi: normalizeOfficialSellerPromotionsFromApi,
  buildOfferContract: buildCanonicalPromotionOfferContract,
  resolvePromotionFinancials: resolveOfficialSellerPromotionFinancials,
  resolveUiFinancials: resolvePromotionUiFinancials,
  enrichPromotionRows: enrichOfficialSellerPromotionRowsFromApi,
  buildScenarioSsotAudit: buildPromotionScenarioSsotAuditPayload,
};

/** @type {Record<string, MarketplacePromotionAdapter>} */
export const marketplacePromotionAdapters = {
  mercado_livre: mercadoLivrePromotionAdapter,
};

/**
 * @param {unknown} marketplace
 * @returns {MarketplacePromotionAdapter | null}
 */
export function resolveMarketplacePromotionAdapter(marketplace) {
  const key = String(marketplace ?? "mercado_livre")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  return marketplacePromotionAdapters[key] ?? null;
}
