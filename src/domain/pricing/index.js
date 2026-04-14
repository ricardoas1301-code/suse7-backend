// ======================================================
// DOMAIN — pricing (Suse7)
// ======================================================
// Ponto de entrada para núcleo de precificação e telemetria de inconsistência.
// ======================================================

export { resolveMercadoLivreSalePriceOfficial } from "./mercadoLivreSalePriceOfficial.js";
export {
  normalizeMoneyToDecimal,
  validatePromotionListingConsistency,
  guardPersistSaleFeeAmount,
  maybeLogFeeGrossVsPercentBase,
} from "./pricingGuards.js";
export {
  logPricingEvent,
  PRICING_LOG_LEVEL,
  PRICING_EVENT_CODE,
} from "./pricingInconsistencyLog.js";
export {
  ML_SHIPPING_COST_OFFICIAL_LABEL,
  mercadoLivreShippingCostOfficialToPersistBlob,
  mercadoLivreShippingOfficialToNetProceedsFields,
  resolveMercadoLivreShippingBuyerContext,
  resolveMercadoLivreShippingCostOfficial,
} from "./mercadoLivreShippingCostOfficial.js";
export {
  resolveMercadoLivreScenarioShippingAsync,
  resolveMercadoLivreBaselineCatalogBrl,
  resolveMercadoLivrePromotionFinancials,
} from "./pricingScenarioResolver.js";
