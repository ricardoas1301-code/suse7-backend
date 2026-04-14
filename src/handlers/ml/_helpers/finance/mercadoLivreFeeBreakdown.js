// ======================================================
// REGRA ARQUITETURAL SUSE7
// ======================================================
// Dados de marketplace NUNCA devem ser exibidos diretamente da API externa no produto.
// Todo dado deve: (1) persistir no banco próprio; (2) ser tratado/calculado no backend;
// (3) só então ser exibido no frontend. Exceções só conscientes e raras.
// ======================================================
// Comissão ML: bruto = sale_price_effective × %; final = API quando houver; desconto = evidência (gross − final).
// Decimal.js; strings monetárias com 2 casas (ROUND_HALF_UP).
// ======================================================

import Decimal from "decimal.js";
import { mlFeeBaseRuleLogEnabled } from "../mlItemMoneyExtract.js";
import {
  calculateExpectedMarketplaceFee,
  calculateMarketplacePayout,
  validateMarketplaceFee,
} from "./marketplaceFeeMath.js";

/**
 * @param {unknown} v
 * @returns {Decimal | null}
 */
function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   sale_price_effective: number | string | import("decimal.js").default;
 *   marketplace_fee_percent: number | string | null;
 *   marketplace_fee_amount_api: number | string | null | undefined;
 *   shipping_cost_marketplace?: number | string;
 *   fixed_fee_amount?: number | string;
 *   listing_id?: string | null;
 *   sale_fee_label?: string | null;
 *   audit_listing_price?: number | string | null;
 *   audit_promotion_price?: number | string | null;
 * }} input
 */
export function buildMercadoLivreFeeBreakdown(input) {
  const sp = toDec(input.sale_price_effective);
  if (sp == null || !sp.gt(0)) {
    throw new Error("Invalid sale_price_effective");
  }

  const pctRaw = input.marketplace_fee_percent;
  const pctDec =
    pctRaw != null && pctRaw !== ""
      ? toDec(pctRaw)
      : null;
  const hasPct = pctDec != null && pctDec.gt(0);

  const apiRaw = input.marketplace_fee_amount_api;
  const apiDec =
    apiRaw != null && apiRaw !== ""
      ? toDec(apiRaw)
      : null;
  const hasApi = apiDec != null && apiDec.gte(0);

  const shipStr = new Decimal(String(input.shipping_cost_marketplace ?? 0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
  const fixedStr = new Decimal(String(input.fixed_fee_amount ?? 0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);

  const extId = input.listing_id ?? null;

  /** Somente valor API (sem %): comissão final = API; bruto/desconto não aplicáveis. */
  if (!hasPct && hasApi && apiDec != null) {
    const finalDec = apiDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const saleFeeStr = finalDec.toFixed(2);
    const payoutStr = calculateMarketplacePayout({
      sale_price_effective: sp.toNumber(),
      marketplace_fee_amount: saleFeeStr,
      shipping_cost_marketplace: input.shipping_cost_marketplace ?? 0,
      fixed_fee_amount: input.fixed_fee_amount ?? 0,
    });
    return {
      sale_price_effective: sp.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      sale_fee_percent: null,
      sale_fee_label: input.sale_fee_label ?? null,
      gross_fee_amount: null,
      marketplace_fee_discount_amount: "0.00",
      sale_fee_amount: saleFeeStr,
      sale_fee_amount_api: saleFeeStr,
      sale_fee_validation_status: /** @type {const} */ ("matched"),
      sale_fee_difference_amount: "0.00",
      marketplace_fee_source: /** @type {const} */ ("api"),
      calculation_confidence: /** @type {const} */ ("high"),
      shipping_cost_marketplace: shipStr,
      fixed_fee_amount: fixedStr,
      marketplace_payout: payoutStr,
    };
  }

  if (!hasPct) {
    throw new Error("Invalid marketplace fee: need sale_fee_percent or sale_fee_amount (API)");
  }

  const grossStr = calculateExpectedMarketplaceFee({
    sale_price_effective: sp.toNumber(),
    marketplace_fee_percent: pctDec.toNumber(),
  });
  const grossDec = new Decimal(grossStr);

  let finalDec;
  if (hasApi && apiDec != null) {
    finalDec = apiDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else {
    finalDec = grossDec;
  }

  const discountDec = hasApi && apiDec != null ? Decimal.max(0, grossDec.minus(apiDec)) : new Decimal(0);

  if (hasApi && apiDec != null && apiDec.gt(grossDec.plus(new Decimal("0.01")))) {
    console.warn("Marketplace fee divergence detected", {
      marketplace: "mercado_livre",
      listing_id: extId,
      expected_fee: grossStr,
      api_fee: apiDec.toFixed(2),
      difference: apiDec.minus(grossDec).toNumber(),
    });
  }

  /** Validação do valor cobrado: comissão final vs API (subsídio fica em marketplace_fee_discount_amount). */
  const valFinalVsApi =
    hasApi && apiDec != null
      ? validateMarketplaceFee({ expected_fee: finalDec, api_fee: apiDec })
      : { status: /** @type {const} */ ("missing_api_value"), difference: null };

  const saleFeeStr = finalDec.toFixed(2);
  const payoutStr = calculateMarketplacePayout({
    sale_price_effective: sp.toNumber(),
    marketplace_fee_amount: saleFeeStr,
    shipping_cost_marketplace: input.shipping_cost_marketplace ?? 0,
    fixed_fee_amount: input.fixed_fee_amount ?? 0,
  });

  const saleFeePctStr = pctDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

  if (mlFeeBaseRuleLogEnabled(extId)) {
    const lp =
      input.audit_listing_price !== undefined && input.audit_listing_price !== null && input.audit_listing_price !== ""
        ? Number(input.audit_listing_price)
        : null;
    const pp =
      input.audit_promotion_price !== undefined &&
      input.audit_promotion_price !== null &&
      input.audit_promotion_price !== ""
        ? Number(input.audit_promotion_price)
        : null;
    console.info(
      "[ML_FEE_BASE_RULE]",
      JSON.stringify({
        listing_id: extId,
        listing_price: lp != null && Number.isFinite(lp) ? lp : null,
        promotion_price: pp != null && Number.isFinite(pp) ? pp : null,
        sale_price_effective: sp.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        marketplace_fee_percent: saleFeePctStr,
        gross_fee_amount: grossStr,
      })
    );
  }

  const marketplace_fee_source = hasApi ? /** @type {const} */ ("api") : /** @type {const} */ ("calculated");

  const sale_fee_validation_status =
    valFinalVsApi.status === "matched"
      ? /** @type {const} */ ("matched")
      : valFinalVsApi.status === "divergent"
        ? /** @type {const} */ ("divergent")
        : /** @type {const} */ ("missing_api_value");

  const sale_fee_difference_amount =
    valFinalVsApi.difference != null
      ? new Decimal(valFinalVsApi.difference).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : "0.00";

  const calculation_confidence =
    hasApi && valFinalVsApi.status === "matched"
      ? /** @type {const} */ ("high")
      : !hasApi
        ? /** @type {const} */ ("medium")
        : /** @type {const} */ ("low");

  return {
    sale_price_effective: sp.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    sale_fee_percent: saleFeePctStr,
    sale_fee_label: input.sale_fee_label ?? null,
    gross_fee_amount: grossStr,
    marketplace_fee_discount_amount: discountDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    sale_fee_amount: saleFeeStr,
    sale_fee_amount_api: hasApi && apiDec != null ? apiDec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
    sale_fee_validation_status,
    sale_fee_difference_amount,
    marketplace_fee_source,
    calculation_confidence,
    shipping_cost_marketplace: shipStr,
    fixed_fee_amount: fixedStr,
    marketplace_payout: payoutStr,
  };
}
