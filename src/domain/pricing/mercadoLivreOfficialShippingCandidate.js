// ======================================================
// Candidatos de frete seller — alinhamento ao simulador ML via payout oficial.
// Não hardcode; Decimal para dinheiro.
// ======================================================

import Decimal from "decimal.js";

const ROUND = Decimal.ROUND_HALF_UP;
const TOL_BRL = new Decimal("0.02");

/**
 * @typedef {{
 *   amount: Decimal;
 *   source: string;
 *   context: "buyer_pays" | "free_for_buyer";
 * }} CandidatoFreteSellerMl
 */

/**
 * @param {{
 *   listCost: Decimal | null;
 *   buyerCost: Decimal | null;
 *   promoted: Decimal | null;
 * }} campos
 * @returns {CandidatoFreteSellerMl[]}
 */
export function gerarCandidatosFreteSellerMl(campos) {
  const { listCost, buyerCost, promoted } = campos;
  /** @type {CandidatoFreteSellerMl[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();

  /**
   * @param {Decimal | null} amount
   * @param {string} source
   * @param {"buyer_pays" | "free_for_buyer"} context
   */
  function add(amount, source, context) {
    if (amount == null || !amount.isFinite() || amount.lte(0)) return;
    const k = amount.toDecimalPlaces(2, ROUND).toFixed(2);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ amount: new Decimal(k), source, context });
  }

  const ctxFree =
    buyerCost != null && buyerCost.isZero() ? "free_for_buyer" : "buyer_pays";

  if (listCost != null && buyerCost != null && buyerCost.gt(0) && listCost.gt(0)) {
    add(listCost, "list_cost_buyer_pays", "buyer_pays");
  }
  if (listCost != null && buyerCost != null && buyerCost.isZero() && listCost.gt(0)) {
    add(listCost, "list_cost_free_buyer", "free_for_buyer");
  }
  if (listCost != null && buyerCost != null && listCost.gte(buyerCost) && listCost.gt(0)) {
    add(listCost.minus(buyerCost), "list_cost_minus_buyer_cost", ctxFree);
  }
  if (
    listCost != null &&
    promoted != null &&
    promoted.gt(0) &&
    listCost.gt(0) &&
    promoted.lt(listCost)
  ) {
    add(listCost.minus(promoted), "list_cost_minus_promoted_amount", ctxFree);
  }
  if (listCost != null && listCost.gt(0)) {
    add(listCost, "list_cost_integral", ctxFree);
  }

  return out;
}

/**
 * @param {Decimal} a
 * @param {Decimal | null | undefined} b
 */
function proximoBrl(a, b) {
  if (b == null || !b.isFinite()) return false;
  return a.minus(b).abs().lte(TOL_BRL);
}

/**
 * Escolhe o candidato que bate com listing_prices (logística ou payout) ou heurística segura.
 * @param {{
 *   candidates: CandidatoFreteSellerMl[];
 *   salePriceDec: Decimal | null;
 *   feeAmountDec: Decimal | null;
 *   listingPricesLogisticsDec?: Decimal | null;
 *   listingPricesPayoutDec?: Decimal | null;
 * }} p
 * @returns {(CandidatoFreteSellerMl & { pick_reason: string }) | null}
 */
export function escolherCandidatoFreteSellerOficialMl(p) {
  const { candidates, salePriceDec, feeAmountDec, listingPricesLogisticsDec, listingPricesPayoutDec } =
    p;
  if (!candidates.length) return null;

  if (salePriceDec != null && feeAmountDec != null && listingPricesPayoutDec != null) {
    for (const c of candidates) {
      const payout = salePriceDec.minus(feeAmountDec).minus(c.amount);
      if (proximoBrl(payout, listingPricesPayoutDec)) {
        return { ...c, pick_reason: "listing_prices_payout_match" };
      }
    }
  }

  for (const c of candidates) {
    if (proximoBrl(c.amount, listingPricesLogisticsDec)) {
      return { ...c, pick_reason: "listing_prices_logistics_match" };
    }
  }

  const buyerPays = candidates.find((c) => c.source === "list_cost_buyer_pays");
  if (buyerPays) {
    return { ...buyerPays, pick_reason: "buyer_pays_list_cost" };
  }

  const listMinusBuyer = candidates.find(
    (c) => c.source === "list_cost_minus_buyer_cost" || c.source === "list_cost_free_buyer",
  );
  const promotedCand = candidates.find((c) => c.source === "list_cost_minus_promoted_amount");

  if (listMinusBuyer && promotedCand) {
    return { ...listMinusBuyer, pick_reason: "free_shipping_prefer_list_minus_buyer" };
  }

  if (promotedCand) {
    return { ...promotedCand, pick_reason: "promoted_only_candidate" };
  }
  if (listMinusBuyer) {
    return { ...listMinusBuyer, pick_reason: "list_minus_buyer_only" };
  }

  return { ...candidates[0], pick_reason: "first_candidate" };
}

/** @param {Decimal | null} d @returns {string | null} */
export function decStr2Frete(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}
