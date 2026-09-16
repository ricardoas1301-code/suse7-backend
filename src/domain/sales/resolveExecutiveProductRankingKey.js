// ======================================================================
// Chave de agrupamento do ranking de produtos do Resumo Diário / Top 3.
// Produto canônico quando existir; senão SKU; senão listing+conta (não descarta).
// ======================================================================

/**
 * @param {{
 *   attributionProductId?: string | null;
 *   skuNorm?: string | null;
 *   sellerCo?: string | null;
 *   listingId?: string | null;
 *   marketplace?: string | null;
 *   accountId?: string | null;
 * }} input
 * @returns {string | null}
 */
export function resolveExecutiveProductRankingKey(input) {
  const productId = String(input.attributionProductId ?? "").trim();
  if (productId) return `pid::${productId}`;
  const skuNorm = String(input.skuNorm ?? "").trim();
  const sellerCo = String(input.sellerCo ?? "").trim();
  if (skuNorm) return `sku::${sellerCo}::${skuNorm}`;
  const listingId = String(input.listingId ?? "").trim();
  if (!listingId) return null;
  const marketplace = String(input.marketplace ?? "").trim();
  const accountId = String(input.accountId ?? "").trim();
  return `listing::${marketplace}::${accountId}::${listingId}`;
}
