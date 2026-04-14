// ======================================================
// Orquestrador de cenário de precificação — reexporta estratégias ML.
// Multi-marketplace: novos canais podem expor o mesmo contrato sem alterar o handler HTTP.
// ======================================================

export { resolveMercadoLivreScenarioShippingAsync } from "./mercadoLivreScenarioShippingResolve.js";
export {
  resolveMercadoLivreBaselineCatalogBrl,
  resolveMercadoLivrePromotionFinancials,
} from "./strategies/mercadoLivrePromotionResolverStrategy.js";
