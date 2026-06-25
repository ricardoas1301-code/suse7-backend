/**
 * Contratos homologados — Precificação Inteligente (PI.2.10 / PI.2.10A).
 * Fonte única para regressão offline e live da engine financeira congelada.
 *
 * Valores validados contra Simulador de Custos ML (Mission Control S7).
 * Não alterar sem nova trilha + homologação.
 */

/** @typedef {"premium" | "classic"} TipoAnuncioHomologado */

/**
 * @typedef {{
 *   id: string;
 *   listing_id: string;
 *   listing_type_id: "gold_pro" | "gold_special";
 *   tipo: TipoAnuncioHomologado;
 *   category_id: string;
 *   sale_price_brl: string;
 *   fee_amount_brl: string;
 *   fee_percent?: string;
 *   shipping_cost_brl?: string;
 *   payout_brl?: string;
 *   product_cost_brl?: string;
 *   tax_amount_brl?: string;
 *   operational_brl?: string;
 *   profit_brl?: string;
 *   margin_pct?: string;
 *   homologacaoCompleta?: boolean;
 *   nota?: string;
 * }} ContratoHomologado
 */

/** @type {Record<string, Record<string, unknown>>} */
export const LISTING_BASE_HOMOLOGADO = {
  MLB6086959274: {
    external_listing_id: "MLB6086959274",
    listing_type_id: "gold_pro",
    currency_id: "BRL",
    raw_json: {
      site_id: "MLB",
      category_id: "MLB186068",
      shipping: { free_shipping: true, mode: "me2", logistic_type: "xd_drop_off" },
    },
  },
  MLB3303267547: {
    external_listing_id: "MLB3303267547",
    listing_type_id: "gold_pro",
    currency_id: "BRL",
    raw_json: {
      site_id: "MLB",
      category_id: "MLB1051",
      shipping: { free_shipping: true, mode: "me2", logistic_type: "cross_docking" },
    },
  },
};

/** Frete stale conhecido — regressão deve rejeitar reutilização silenciosa. */
export const STALE_SHIPPING_HOMOLOGADO = {
  MLB6086959274: "68.65",
  MLB3303267547: "25.55",
};

/** Tarifa stale conhecida (catálogo premium cheio). */
export const STALE_FEE_HOMOLOGADO = {
  MLB6086959274: "40.49",
};

/** @type {ContratoHomologado[]} */
export const CONTRATOS_PREMIUM_HOMOLOGADOS = [
  {
    id: "P_299_90",
    listing_id: "MLB6086959274",
    listing_type_id: "gold_pro",
    tipo: "premium",
    category_id: "MLB186068",
    sale_price_brl: "299.90",
    fee_amount_brl: "40.49",
    fee_percent: "13.50",
    shipping_cost_brl: "68.65",
    payout_brl: "190.76",
    product_cost_brl: "129.00",
    tax_amount_brl: "17.99",
    operational_brl: "1.16",
    profit_brl: "42.61",
    margin_pct: "14.21",
    homologacaoCompleta: true,
  },
  {
    id: "P_284_90",
    listing_id: "MLB6086959274",
    listing_type_id: "gold_pro",
    tipo: "premium",
    category_id: "MLB186068",
    sale_price_brl: "284.90",
    fee_amount_brl: "38.46",
    fee_percent: "13.50",
    shipping_cost_brl: "68.65",
    payout_brl: "177.79",
    product_cost_brl: "129.00",
    tax_amount_brl: "17.09",
    operational_brl: "1.16",
    profit_brl: "30.54",
    margin_pct: "10.72",
    homologacaoCompleta: true,
  },
  {
    id: "P_109_00",
    listing_id: "MLB6086959274",
    listing_type_id: "gold_pro",
    tipo: "premium",
    category_id: "MLB186068",
    sale_price_brl: "109.00",
    fee_amount_brl: "17.98",
    fee_percent: "16.50",
    shipping_cost_brl: "48.05",
    payout_brl: "42.97",
    homologacaoCompleta: true,
  },
  {
    id: "P_65_00",
    listing_id: "MLB6086959274",
    listing_type_id: "gold_pro",
    tipo: "premium",
    category_id: "MLB186068",
    sale_price_brl: "65.00",
    fee_amount_brl: "10.72",
    fee_percent: "16.50",
    shipping_cost_brl: "10.95",
    payout_brl: "43.33",
    homologacaoCompleta: true,
    nota: "Homologado PI card Premium — MLB6086959274",
  },
];

/** @type {ContratoHomologado[]} */
export const CONTRATOS_CLASSIC_HOMOLOGADOS = [
  {
    id: "C_149_90",
    listing_id: "MLB6086959274",
    listing_type_id: "gold_special",
    tipo: "classic",
    category_id: "MLB186068",
    sale_price_brl: "149.90",
    fee_amount_brl: "17.24",
    fee_percent: "11.50",
    homologacaoCompleta: false,
    nota: "Tarifa 11,50% homologada; frete/recebe validados em --live",
  },
  {
    id: "C_105_00",
    listing_id: "MLB6086959274",
    listing_type_id: "gold_special",
    tipo: "classic",
    category_id: "MLB186068",
    sale_price_brl: "105.00",
    fee_amount_brl: "12.08",
    fee_percent: "11.50",
    homologacaoCompleta: false,
    nota: "Tarifa 11,50% homologada; frete/recebe validados em --live",
  },
  {
    id: "C_58_00",
    listing_id: "MLB6086959274",
    listing_type_id: "gold_special",
    tipo: "classic",
    category_id: "MLB186068",
    sale_price_brl: "58.00",
    fee_amount_brl: "6.67",
    fee_percent: "11.50",
    homologacaoCompleta: false,
    nota: "Tarifa 11,50% homologada; frete/recebe validados em --live",
  },
  {
    id: "C_35_00",
    listing_id: "MLB6086959274",
    listing_type_id: "gold_special",
    tipo: "classic",
    category_id: "MLB186068",
    sale_price_brl: "35.00",
    fee_amount_brl: "4.03",
    fee_percent: "11.50",
    homologacaoCompleta: false,
    nota: "Tarifa 11,50% homologada; frete/recebe validados em --live",
  },
  {
    id: "C_109_00",
    listing_id: "MLB6086959274",
    listing_type_id: "gold_special",
    tipo: "classic",
    category_id: "MLB186068",
    sale_price_brl: "109.00",
    fee_amount_brl: "12.54",
    fee_percent: "11.50",
    shipping_cost_brl: "48.05",
    payout_brl: "48.41",
    homologacaoCompleta: true,
    nota: "Homologado PI card Clássico — comparativo 109 / 65",
  },
  {
    id: "C_65_00",
    listing_id: "MLB6086959274",
    listing_type_id: "gold_special",
    tipo: "classic",
    category_id: "MLB186068",
    sale_price_brl: "65.00",
    fee_amount_brl: "7.48",
    fee_percent: "11.50",
    shipping_cost_brl: "10.95",
    payout_brl: "46.57",
    homologacaoCompleta: true,
    nota: "Homologado PI card Clássico — comparativo 109 / 65",
  },
];

/** @type {ContratoHomologado[]} */
export const CONTRATOS_HOMOLOGADOS = [
  ...CONTRATOS_PREMIUM_HOMOLOGADOS,
  ...CONTRATOS_CLASSIC_HOMOLOGADOS,
];

/** Payloads shipping_options representativos (auditoria ML — premium). */
export const SHIPPING_PAYLOADS_HOMOLOGADOS = {
  "284.90": {
    options: [{ list_cost: 68.65, cost: 0, discount: { promoted_amount: 42.2 } }],
  },
  "109.00": {
    options: [{ list_cost: 96.1, cost: 0, discount: { promoted_amount: 48.05 } }],
  },
  "65.00": {
    options: [{ list_cost: 82.5, cost: 0, discount: { promoted_amount: 41.25 } }],
  },
};

/** Extras PI homologados (65,00 — reserva + custos operacionais). */
export const EXTRAS_PI_HOMOLOGADOS_65 = {
  plannedPromoEnabled: true,
  plannedPromoPercent: "5",
  affiliatesEnabled: true,
  affiliatePercent: "2.5",
  mlAdsEnabled: true,
  mlAdsPercent: "1",
  operationalCostEnabled: true,
  operationalCostPercent: "2",
};

/** Lucro esperado com extras PI ativos (65,00 — ambos os tipos). */
export const LUCRO_COM_EXTRAS_PI_65 = {
  classic: "-94.32",
  premium: "-97.56",
  margin_classic: "-145.11",
  margin_premium: "-150.09",
};
