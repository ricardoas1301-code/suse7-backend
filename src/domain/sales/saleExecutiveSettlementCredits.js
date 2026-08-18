// ======================================================================
// Créditos de liquidação ML — agregação executive-summary (read-only snapshot).
// ======================================================================

import Decimal from "decimal.js";

/**
 * @param {unknown} raw
 * @returns {Decimal | null}
 */
function toDecimal(raw) {
  if (raw == null || raw === "") return null;
  try {
    const d = new Decimal(String(raw).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * Extrai créditos de liquidação de uma linha (_s7_financial).
 * Fonte única: positive_adjustments_brl + selected_shipping_bonus (sem duplicar rebate).
 *
 * @param {Record<string, unknown> | null | undefined} itemFinancial
 * @returns {Decimal}
 */
export function resolveMarketplaceSettlementCreditsFromItemFinancial(itemFinancial) {
  if (!itemFinancial || typeof itemFinancial !== "object") {
    return new Decimal(0);
  }

  let total = new Decimal(0);

  const posAdj = toDecimal(itemFinancial.positive_adjustments_brl);
  if (posAdj != null && posAdj.gt(0)) {
    total = total.plus(posAdj);
  } else {
    const rebate = itemFinancial.marketplace_rebate;
    if (rebate && typeof rebate === "object") {
      const rebateObj = /** @type {Record<string, unknown>} */ (rebate);
      const rebateAmt = toDecimal(rebateObj.amount_brl);
      if (rebateAmt != null && rebateAmt.gt(0)) {
        total = total.plus(rebateAmt);
      }
    }
  }

  const formulaDebug =
    itemFinancial.formula_debug && typeof itemFinancial.formula_debug === "object"
      ? /** @type {Record<string, unknown>} */ (itemFinancial.formula_debug)
      : null;
  const shipBonusRaw =
    formulaDebug?.selected_shipping_bonus &&
    typeof formulaDebug.selected_shipping_bonus === "object"
      ? /** @type {Record<string, unknown>} */ (formulaDebug.selected_shipping_bonus).amount
      : null;
  const shipBonus = toDecimal(shipBonusRaw);
  if (shipBonus != null && shipBonus.gt(0)) {
    total = total.plus(shipBonus);
  }

  return total;
}
