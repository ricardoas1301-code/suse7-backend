// ======================================================
// Log comparativo Raio-X vs Precificação Inteligente
// ======================================================

/**
 * @param {{
 *   flow: "rayx" | "pi";
 *   handler: string;
 *   listingExternalId?: string | null;
 *   sale_price?: string | null;
 *   listing_type?: string | null;
 *   has_marketplace_account?: boolean;
 *   has_access_token?: boolean;
 *   token_source?: string | null;
 *   calls_listing_prices?: boolean;
 *   listing_prices_status?: number | string | null;
 *   fee_amount_brl?: string | null;
 *   fee_source?: string | null;
 *   shipping_cost_brl?: string | null;
 *   shipping_source?: string | null;
 *   payout_brl?: string | null;
 *   warnings?: string[];
 *   engine_path?: string | null;
 * }} payload
 */
export function logPricingFlowDiff(payload) {
  console.info("[pricing-flow-diff]", payload);
}

/**
 * Log obrigatório PI — tarifa listing_prices + frete shipping_options/free (true/false).
 * @param {Record<string, unknown>} payload
 */
export function logPricingPiOfficialApiCall(payload) {
  console.info("[pricing-pi-official-api-call]", payload);
}

/**
 * Diagnóstico tarifa listing_prices em preços baixos (PI / simulação customizada).
 * @param {Record<string, unknown>} payload
 */
export function logPricingLowPriceFeeDebug(payload) {
  console.info("[pricing-low-price-fee-debug]", payload);
}

/**
 * @param {Record<string, unknown> | null | undefined} scenario
 */
export function extrairMetricasFluxoPrecificacao(scenario) {
  if (scenario == null || typeof scenario !== "object") {
    return {
      fee_amount_brl: null,
      fee_source: null,
      shipping_cost_brl: null,
      shipping_source: null,
      payout_brl: null,
      warnings: /** @type {string[]} */ ([]),
    };
  }
  const m =
    scenario.marketplace != null && typeof scenario.marketplace === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.marketplace)
      : {};
  const dq =
    scenario.data_quality != null && typeof scenario.data_quality === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.data_quality)
      : {};
  /** @type {string[]} */
  const warnings = [];
  if (Array.isArray(dq.warnings)) {
    for (const w of dq.warnings) {
      if (w != null && String(w).trim() !== "") warnings.push(String(w).trim());
    }
  }
  return {
    fee_amount_brl:
      m.sale_fee_amount_brl != null
        ? String(m.sale_fee_amount_brl)
        : m.fee_amount_brl != null
          ? String(m.fee_amount_brl)
          : null,
    fee_source:
      scenario.official_fee_source != null
        ? String(scenario.official_fee_source)
        : m.sale_fee_percent != null
          ? "scenario_marketplace"
          : null,
    shipping_cost_brl:
      m.shipping_cost_amount_brl != null ? String(m.shipping_cost_amount_brl) : null,
    shipping_source: m.shipping_cost_source != null ? String(m.shipping_cost_source) : null,
    payout_brl:
      m.marketplace_payout_amount_brl != null
        ? String(m.marketplace_payout_amount_brl)
        : m.net_receivable_brl != null
          ? String(m.net_receivable_brl)
          : null,
    warnings,
  };
}
