// ======================================================
// REGRA ARQUITETURAL SUSE7
// ======================================================
// Dados de marketplace NUNCA devem ser exibidos diretamente da API externa no produto.
// Todo dado deve: (1) persistir no banco próprio; (2) ser tratado/calculado no backend;
// (3) só então ser exibido no frontend. Exceções só conscientes e raras.
// ======================================================
// Motor financeiro Suse7 — marketplaces (entrada única no backend).
// Comissão bruta: sale_price_effective × percentual — núcleo em domain/pricing + compat getSalePriceEffective.
// ======================================================

export {
  getSalePriceEffective,
  resolveMercadoLivreSalePriceOfficial,
} from "./salePriceEffective.js";
export {
  calculateExpectedMarketplaceFee,
  calculateMarketplacePayout,
  validateMarketplaceFee,
} from "./marketplaceFeeMath.js";
export { MercadoLivreCalculator } from "./strategies/mercadoLivreCalculator.js";
export { buildMercadoLivreFeeBreakdown } from "./mercadoLivreFeeBreakdown.js";
export { formatMercadoLivreSaleFeeLabel } from "./mercadoLivreListingTypeLabel.js";
