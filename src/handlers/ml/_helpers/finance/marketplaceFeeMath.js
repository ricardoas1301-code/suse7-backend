// ======================================================
// REGRA ARQUITETURAL SUSE7
// ======================================================
// Dados de marketplace NUNCA devem ser exibidos diretamente da API externa no produto.
// Todo dado deve: (1) persistir no banco próprio; (2) ser tratado/calculado no backend;
// (3) só então ser exibido no frontend. Exceções só conscientes e raras.
// ======================================================
// Comissão esperada, repasse e validação vs API (Decimal.js).
// gross_fee / expected_fee usam sempre sale_price_effective como base (ver salePriceEffective.js).
// ======================================================

import Decimal from "decimal.js";

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
 * @param {{ sale_price_effective: number | string; marketplace_fee_percent: number | string }} p
 * @returns {string} — valor em 2 casas (string)
 */
export function calculateExpectedMarketplaceFee({ sale_price_effective, marketplace_fee_percent }) {
  const sp = toDec(sale_price_effective);
  const pct = toDec(marketplace_fee_percent);
  if (sp == null || !sp.gt(0)) {
    throw new Error("Invalid sale_price_effective");
  }
  if (pct == null || !pct.gt(0)) {
    throw new Error("Invalid marketplace_fee_percent");
  }
  return sp
    .mul(pct.div(100))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

/**
 * @param {{
 *   sale_price_effective: number | string;
 *   marketplace_fee_amount: number | string;
 *   shipping_cost_marketplace?: number | string;
 *   fixed_fee_amount?: number | string;
 * }} p
 * @returns {string}
 */
export function calculateMarketplacePayout({
  sale_price_effective,
  marketplace_fee_amount,
  shipping_cost_marketplace = 0,
  fixed_fee_amount = 0,
}) {
  const sp = toDec(sale_price_effective);
  const fee = toDec(marketplace_fee_amount) ?? new Decimal(0);
  const ship = toDec(shipping_cost_marketplace) ?? new Decimal(0);
  const fixed = toDec(fixed_fee_amount) ?? new Decimal(0);
  if (sp == null || !sp.gt(0)) {
    throw new Error("Invalid sale_price_effective");
  }
  return sp
    .minus(fee)
    .minus(ship)
    .minus(fixed)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

/**
 * @param {{ expected_fee: Decimal | number | string; api_fee: Decimal | number | string | null | undefined }} p
 * @returns {{ status: "missing_api_value" | "matched" | "divergent"; difference: number | null }}
 */
export function validateMarketplaceFee({ expected_fee, api_fee }) {
  const exp = toDec(expected_fee);
  if (exp == null || !exp.isFinite()) {
    throw new Error("Invalid expected_fee");
  }

  if (api_fee === null || api_fee === undefined) {
    return {
      status: "missing_api_value",
      difference: null,
    };
  }

  const api = toDec(api_fee);
  if (api == null || !api.isFinite()) {
    return {
      status: "missing_api_value",
      difference: null,
    };
  }

  const difference = exp.minus(api).abs();
  if (difference.lte(new Decimal("0.01"))) {
    return {
      status: "matched",
      difference: difference.toNumber(),
    };
  }

  return {
    status: "divergent",
    difference: difference.toNumber(),
  };
}
