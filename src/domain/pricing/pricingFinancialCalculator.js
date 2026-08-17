// ======================================================
// PricingFinancialCalculator — payout, identidade financeira, validação.
// Sem float; Decimal/string para dinheiro.
//
/**
 * ENGINE FINANCEIRA HOMOLOGADA
 *
 * Alterações exigem:
 * - Nova trilha
 * - Nova homologação
 * - Comparação com simulador oficial ML
 *
 * Não alterar sem aprovação explícita.
 * Doc: docs/precificacao/PI_ENGINE_HOMOLOGADA.md
 */
// ======================================================

import Decimal from "decimal.js";

const ROUND = Decimal.ROUND_HALF_UP;
const TOL_BRL = new Decimal("0.02");

/** @param {unknown} v @returns {Decimal | null} */
function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null} d @returns {string | null} */
export function decStr2Financeiro(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/**
 * Repasse alinhado: sale_price − tarifa − frete.
 * @param {string | Decimal | null | undefined} salePrice
 * @param {string | Decimal | null | undefined} feeAmount
 * @param {string | Decimal | null | undefined} shippingAmount
 */
export function calcularRepasseOficialMercadoLivre(salePrice, feeAmount, shippingAmount) {
  const sale = salePrice instanceof Decimal ? salePrice : toDec(salePrice);
  const fee = feeAmount instanceof Decimal ? feeAmount : toDec(feeAmount);
  const ship = shippingAmount instanceof Decimal ? shippingAmount : toDec(shippingAmount);
  if (sale == null || fee == null || ship == null) return null;
  return decStr2Financeiro(sale.minus(fee).minus(ship));
}

/**
 * Valida identidade payout = sale − fee − shipping.
 * @param {{
 *   sale_price_brl: string;
 *   fee_amount_brl: string;
 *   shipping_cost_brl: string;
 *   payout_brl: string;
 *   tolerance_brl?: string;
 * }} p
 */
export function validarIdentidadeFinanceiraOficial(p) {
  const calc = calcularRepasseOficialMercadoLivre(
    p.sale_price_brl,
    p.fee_amount_brl,
    p.shipping_cost_brl,
  );
  const tol = p.tolerance_brl != null ? toDec(p.tolerance_brl) : TOL_BRL;
  const payout = toDec(p.payout_brl);
  const calcDec = toDec(calc);
  if (calcDec == null || payout == null || tol == null) {
    return { ok: false, payout_calculado_brl: calc, diff_brl: null };
  }
  const diff = payout.minus(calcDec).abs();
  return {
    ok: diff.lte(tol),
    payout_calculado_brl: calc,
    diff_brl: decStr2Financeiro(diff),
  };
}

/**
 * Tarifa em R$ para o preço do cenário — espelha regra anti-stale da engine.
 * @param {string} salePriceBrl
 * @param {string | null} feePctStr
 * @param {string | null} feeAmtCandidate
 * @param {{ officialSource?: string | null; preferOfficialAmount?: boolean; trustPercentForScenarioPrice?: boolean }} [opts]
 */
export function resolverTarifaCenarioMercadoLivreBrl(salePriceBrl, feePctStr, feeAmtCandidate, opts = {}) {
  const priceDec = toDec(salePriceBrl);
  if (priceDec == null || !priceDec.gt(0)) return null;

  const { officialSource = null, preferOfficialAmount = false, trustPercentForScenarioPrice = false } =
    opts;

  if (preferOfficialAmount && feeAmtCandidate != null && String(feeAmtCandidate).trim() !== "") {
    const amtDec = toDec(String(feeAmtCandidate).trim());
    if (amtDec != null && amtDec.gte(0)) return decStr2Financeiro(amtDec);
  }

  const pct = toDec(feePctStr);
  const fromPct =
    pct != null && pct.gt(0) ? priceDec.mul(pct).div(100).toDecimalPlaces(2, ROUND) : null;
  const candDec =
    feeAmtCandidate != null && String(feeAmtCandidate).trim() !== ""
      ? toDec(String(feeAmtCandidate).trim())
      : null;

  if (fromPct != null) {
    if (candDec != null && candDec.gte(0) && candDec.minus(fromPct).abs().lte(TOL_BRL)) {
      return decStr2Financeiro(candDec);
    }
    if (trustPercentForScenarioPrice || officialSource === "ml_listing_prices" || candDec == null) {
      return decStr2Financeiro(fromPct);
    }
  }

  if (candDec != null && candDec.gte(0)) return decStr2Financeiro(candDec);
  return null;
}
