// ======================================================
// REGRA ARQUITETURAL SUSE7
// ======================================================
// Dados de marketplace NUNCA devem ser exibidos diretamente da API externa no produto.
// Todo dado deve: (1) persistir no banco próprio; (2) ser tratado/calculado no backend;
// (3) só então ser exibido no frontend. Exceções só conscientes e raras.
// ======================================================
// Mercado Livre — motor financeiro unitário (Strategy).
// Comissão bruta: sale_price_effective × % (`resolveMercadoLivreSalePriceOfficial`).
// ======================================================

import { resolveMercadoLivreSalePriceOfficial } from "../../../../../domain/pricing/mercadoLivreSalePriceOfficial.js";
import { buildMercadoLivreFeeBreakdown } from "../mercadoLivreFeeBreakdown.js";

/**
 * @typedef {{
 *   marketplace: "mercado_livre";
 *   listing_id?: string | null;
 *   listing_price: number;
 *   promotion_price: number | null;
 *   has_active_promotion: boolean;
 *   marketplace_fee_percent: number;
 *   marketplace_fee_amount_api: number | string | null;
 *   shipping_cost_marketplace?: number | string;
 *   fixed_fee_amount?: number | string;
 * }} MercadoLivreSaleBreakdownInput
 */

/**
 * @typedef {{
 *   sale_price_effective: string;
 *   gross_fee_amount: string | null;
 *   marketplace_fee_discount_amount: string;
 *   sale_fee_amount: string;
 *   expected_marketplace_fee_amount: string;
 *   marketplace_fee_amount_api: string | null;
 *   marketplace_fee_validation_status: "missing_api_value" | "matched" | "divergent";
 *   marketplace_fee_difference_amount: string | null;
 *   marketplace_payout: string;
 *   marketplace_fee_source: "api" | "calculated";
 *   calculation_confidence: "high" | "medium" | "low";
 * }} MercadoLivreSaleBreakdownOutput
 */

/** Strategy Mercado Livre — comissão sobre preço efetivo; subsídio ML em marketplace_fee_discount_amount. */
export class MercadoLivreCalculator {
  /**
   * @param {MercadoLivreSaleBreakdownInput} input
   * @returns {MercadoLivreSaleBreakdownOutput}
   */
  calculateSaleBreakdown(input) {
    const resolved = resolveMercadoLivreSalePriceOfficial({
      marketplace: input.marketplace,
      listing_id: input.listing_id ?? null,
      listing_price: input.listing_price,
      promotion_price: input.promotion_price,
      has_active_promotion_hint: input.has_active_promotion,
      context: "mercado_livre_calculator_strategy",
    });
    const sale_price_effective =
      resolved.sale_price_effective != null
        ? Number(resolved.sale_price_effective)
        : input.listing_price;

    const b = buildMercadoLivreFeeBreakdown({
      sale_price_effective,
      marketplace_fee_percent: input.marketplace_fee_percent,
      marketplace_fee_amount_api: input.marketplace_fee_amount_api,
      shipping_cost_marketplace: input.shipping_cost_marketplace ?? 0,
      fixed_fee_amount: input.fixed_fee_amount ?? 0,
      listing_id: input.listing_id ?? null,
      sale_fee_label: null,
      audit_listing_price: input.listing_price,
      audit_promotion_price: input.promotion_price,
    });

    const grossStr = b.gross_fee_amount ?? b.sale_fee_amount;

    return {
      sale_price_effective: b.sale_price_effective,
      gross_fee_amount: b.gross_fee_amount,
      marketplace_fee_discount_amount: b.marketplace_fee_discount_amount,
      sale_fee_amount: b.sale_fee_amount,
      expected_marketplace_fee_amount: grossStr,
      marketplace_fee_amount_api: b.sale_fee_amount_api,
      marketplace_fee_validation_status: /** @type {const} */ (b.sale_fee_validation_status),
      marketplace_fee_difference_amount: b.sale_fee_difference_amount,
      marketplace_payout: b.marketplace_payout,
      marketplace_fee_source: /** @type {const} */ (b.marketplace_fee_source),
      calculation_confidence: /** @type {const} */ (b.calculation_confidence),
    };
  }
}
