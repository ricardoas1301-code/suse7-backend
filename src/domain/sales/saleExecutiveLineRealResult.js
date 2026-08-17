// ======================================================================
// Lucro por linha no executive-summary — mesmo contrato do Raio-X da venda.
// net_received − product_cost − internal_tax − operation_packaging − contingency (ML Ads + reserva).
// Promoção e afiliados ficam fora (desconto já refletido no faturamento/repasse).
// ======================================================================

import Decimal from "decimal.js";
import {
  buildSaleDetailInternalCostsContract,
  computeSaleDetailRealResult,
  saleDetailMoneyToDecimal as toDecimal,
} from "./saleDetailInternalCosts.js";

/**
 * @param {unknown} lines
 * @returns {Decimal | null}
 */
export function sumRayxContingencyLinesDec(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let total = new Decimal(0);
  let any = false;
  for (const row of lines) {
    if (!row || typeof row !== "object") continue;
    const amt = toDecimal(/** @type {Record<string, unknown>} */ (row).amount_brl);
    if (amt != null && amt.gt(0)) {
      total = total.plus(amt);
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * @param {unknown} lines
 * @param {string} key
 * @returns {Decimal | null}
 */
function sumContingencyLinesByKeyDec(lines, key) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let total = new Decimal(0);
  let any = false;
  for (const row of lines) {
    if (!row || typeof row !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (row);
    if (String(r.key ?? "") !== key) continue;
    const amt = toDecimal(r.amount_brl);
    if (amt != null && amt.gt(0)) {
      total = total.plus(amt);
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * @param {{
 *   item?: Record<string, unknown> | null;
 *   qty: number;
 *   grossDec: Decimal;
 *   netDec: Decimal | null;
 * }} ctx
 */
export function computeExecutiveLineRealProfit(ctx) {
  const { item = null, qty, grossDec, netDec } = ctx;

  const internalCosts = buildSaleDetailInternalCostsContract({
    item,
    qty,
    grossDec,
    taxPercent: null,
    taxPercentSource: null,
    seller_company_id: null,
    marketplace_account_id: null,
  });

  const raw =
    item?.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;
  const fin =
    raw?._s7_financial && typeof raw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (raw._s7_financial)
      : null;
  const snap =
    fin?.contingency_margin_snapshot && typeof fin.contingency_margin_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.contingency_margin_snapshot)
      : null;
  /** @type {Array<Record<string, unknown>>} */
  const contingencyLines = [];
  if (snap) {
    if (snap.ml_ads_brl != null && String(snap.ml_ads_brl).trim() !== "") {
      contingencyLines.push({
        key: "ml_ads",
        label: "ML Ads",
        amount_brl: String(snap.ml_ads_brl),
        percent: snap.ml_ads_percent != null ? String(snap.ml_ads_percent) : null,
      });
    }
    const reserveAmount =
      snap.reserve_brl ?? snap.safety_reserve_brl ?? snap.reserve_amount_brl ?? null;
    const reservePercent = snap.reserve_percent ?? snap.safety_reserve_percent ?? null;
    if (reserveAmount != null && String(reserveAmount).trim() !== "") {
      contingencyLines.push({
        key: "safety_reserve",
        label: "Reserva perdas e devolucoes",
        amount_brl: String(reserveAmount),
        percent: reservePercent != null ? String(reservePercent) : null,
      });
    }
  }
  if (!contingencyLines.some((line) => line.key === "ml_ads")) {
    const adsSnap =
      fin?.ads_snapshot && typeof fin.ads_snapshot === "object"
        ? /** @type {Record<string, unknown>} */ (fin.ads_snapshot)
        : null;
    const adsAmount = adsSnap?.amount_brl ?? adsSnap?.ml_ads_brl ?? null;
    if (adsAmount != null && String(adsAmount).trim() !== "") {
      contingencyLines.push({
        key: "ml_ads",
        label: "ML Ads",
        amount_brl: String(adsAmount),
        percent: adsSnap?.percent != null ? String(adsSnap.percent) : null,
      });
    }
  }
  if (!contingencyLines.some((line) => line.key === "safety_reserve")) {
    const operationalSnap =
      fin?.operational_cost_snapshot && typeof fin.operational_cost_snapshot === "object"
        ? /** @type {Record<string, unknown>} */ (fin.operational_cost_snapshot)
        : null;
    const reserveAmount =
      operationalSnap?.reserve_brl ?? operationalSnap?.operational_costs_brl ?? null;
    if (reserveAmount != null && String(reserveAmount).trim() !== "") {
      contingencyLines.push({
        key: "safety_reserve",
        label: "Reserva perdas e devolucoes",
        amount_brl: String(reserveAmount),
        percent: operationalSnap?.reserve_percent != null ? String(operationalSnap.reserve_percent) : null,
      });
    }
  }
  const contingencyDec = sumRayxContingencyLinesDec(contingencyLines);

  const { profitDec, is_definitive, confidence } = computeSaleDetailRealResult({
    netReceivedDec: netDec,
    internalCosts,
    contingencyDec,
  });

  return {
    profitDec,
    internalCosts,
    contingencyLines,
    contingencyDec,
    mlAdsDec: sumContingencyLinesByKeyDec(contingencyLines, "ml_ads"),
    reserveDec: sumContingencyLinesByKeyDec(contingencyLines, "safety_reserve"),
    productCostDec: toDecimal(internalCosts.product_cost_brl),
    operationPackagingDec: toDecimal(internalCosts.operation_packaging_cost_brl),
    internalTaxDec: toDecimal(internalCosts.internal_tax_brl),
    is_definitive,
    confidence,
  };
}
