// ======================================================================

// Constantes SSOT — Central de Saúde da Precificação (Dashboard).

// Unidade principal: anúncio/listing. Estado atual — ignora filtro de período.

// ======================================================================



/** Escopo temporal — precificação atual dos anúncios. */

export const PRICING_HEALTH_SCOPE = "current_pricing";



/** Faixas — Status da Oferta. */

export const PRICING_HEALTH_OFFER_STATUS_BANDS = [

  { key: "healthy", label: "Saudável", chart_color: "#22c55e" },

  { key: "attention", label: "Atenção", chart_color: "#f97316" },

  { key: "critical", label: "Crítico", chart_color: "#ef4444" },

  { key: "no_data", label: "Sem dados", chart_color: "#94a3b8" },

];



/**

 * Faixas — Margem Projetada (paridade Saúde Comercial dos Anúncios).

 * Mesmos limiares de resolverChaveFaixaMargemComercial.

 */

export const PRICING_HEALTH_PROJECTED_MARGIN_BANDS = [

  { key: "margin_30_plus", label: "Margem ≥30%", chart_color: "#16a34a" },

  { key: "margin_20_29", label: "Margem 20–29%", chart_color: "#22c55e" },

  { key: "margin_10_19", label: "Margem 10–19%", chart_color: "#3b82f6" },

  { key: "margin_0_9", label: "Margem 0–9%", chart_color: "#f97316" },

  { key: "loss", label: "Prejuízo", chart_color: "#ef4444" },

  { key: "no_data", label: "Sem dados", chart_color: "#94a3b8" },

];



/** Faixas — Promoções dos Anúncios (mutuamente exclusivas por prioridade). */

export const PRICING_HEALTH_PROMOTION_STATUS_BANDS = [

  { key: "active_promotion", label: "Em promoção", chart_color: "#22c55e" },

  { key: "scheduled_promotion", label: "Promoção programada", chart_color: "#3b82f6" },

  { key: "available_promotion", label: "Disponíveis para promoção", chart_color: "#f97316" },

  { key: "no_promotion", label: "Sem promoção", chart_color: "#94a3b8" },

];



/** Limiares — Status da Oferta (margem projetada %). */

export const PRICING_HEALTH_OFFER_HEALTHY_MARGIN_MIN_EXCLUSIVE = "5";

export const PRICING_HEALTH_OFFER_ATTENTION_MARGIN_MAX = "5";


