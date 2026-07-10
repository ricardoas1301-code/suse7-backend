// ======================================================================
// Provider marketplace — Central de Saúde dos Produtos (multi-canal futuro).
// V1: Mercado Livre; arquitetura preparada para Shopee, Amazon, Shein.
// ======================================================================

/** @typedef {{ id: string; label: string }} ProductHealthMarketplaceStrategy */

/** @type {ProductHealthMarketplaceStrategy} */
const MERCADO_LIVRE_STRATEGY = {
  id: "mercado_livre",
  label: "Mercado Livre",
};

/** @type {Record<string, ProductHealthMarketplaceStrategy>} */
const STRATEGIES = {
  mercado_livre: MERCADO_LIVRE_STRATEGY,
  mercadolivre: MERCADO_LIVRE_STRATEGY,
};

export const PRODUCT_HEALTH_MARKETPLACE_PROVIDER = MERCADO_LIVRE_STRATEGY.id;

/**
 * @param {string | null | undefined} marketplace
 * @returns {ProductHealthMarketplaceStrategy}
 */
export function resolveProductHealthMarketplaceStrategy(marketplace) {
  const key = String(marketplace ?? "")
    .trim()
    .toLowerCase();
  return STRATEGIES[key] ?? MERCADO_LIVRE_STRATEGY;
}
