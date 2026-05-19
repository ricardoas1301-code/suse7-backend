import Decimal from "decimal.js";

export const ML_FINANCIAL_SNAPSHOT_VERSION = "ml_financial_v2";

/** Arredondamento da tarifa % × preço alinhado ao painel Mercado Livre (ex.: 27×11,5%→3,10; 73×16,5%→12,04). */
export const ML_MARKETPLACE_FEE_DECIMAL_ROUNDING = Decimal.ROUND_HALF_DOWN;

/**
 * Faixa percentual esperada de tarifa ML por tipo de anúncio (validação de candidatos fracos).
 * @param {string | null | undefined} listingTypeId
 */
export function resolveMercadoLivreExpectedFeePercentByListingType(listingTypeId) {
  const id = String(listingTypeId ?? "")
    .trim()
    .toLowerCase();
  if (id.includes("gold_pro") || id.includes("gold_premium")) {
    return { minPercent: 14, maxPercent: 20, tier: "premium" };
  }
  if (id.includes("gold_special")) {
    return { minPercent: 10, maxPercent: 16, tier: "classic" };
  }
  if (id.includes("gold")) {
    return { minPercent: 11, maxPercent: 18, tier: "gold" };
  }
  if (id.includes("free")) {
    return { minPercent: 0, maxPercent: 15, tier: "free" };
  }
  return { minPercent: 8, maxPercent: 25, tier: "unknown" };
}

/**
 * @param {Decimal} fee
 * @param {Decimal} gross
 */
export function mercadoLivreFeeEffectivePercent(fee, gross) {
  if (gross.isZero()) return null;
  return fee.div(gross).mul(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/**
 * Rejeita tarifas incompatíveis com o tipo de anúncio (ex.: sale_fee×qty → 12,79% em gold_pro).
 *
 * @param {Decimal} feeDec
 * @param {Decimal} grossDec
 * @param {string | null | undefined} listingTypeId
 * @param {{ hintPercent?: number | null }} [opts]
 */
export function validateMercadoLivreFeeCandidate(feeDec, grossDec, listingTypeId, opts = {}) {
  if (!feeDec || !grossDec || grossDec.lte(0) || feeDec.lte(0)) {
    return { valid: false, percent: null, reason: "invalid_amounts" };
  }

  const effective = mercadoLivreFeeEffectivePercent(feeDec, grossDec);
  if (!effective) return { valid: false, percent: null, reason: "zero_gross" };

  const band = resolveMercadoLivreExpectedFeePercentByListingType(listingTypeId);
  const pct = effective.toNumber();

  if (pct < band.minPercent - 0.5) {
    return { valid: false, percent: pct, reason: `below_${band.tier}_min_${band.minPercent}` };
  }
  if (pct > band.maxPercent + 2) {
    return { valid: false, percent: pct, reason: `above_${band.tier}_max_${band.maxPercent}` };
  }

  const hint = opts.hintPercent;
  if (hint != null && hint > 0 && Math.abs(pct - hint) > 4) {
    return { valid: false, percent: pct, reason: "diverges_from_hint_percent" };
  }

  return { valid: true, percent: pct, reason: "ok" };
}

/**
 * Tarifa a partir de percentual × bruto (Decimal).
 * Com qty>1 e unitPrice, arredonda por unidade como o painel ML (ex.: 24,78×16,5%→4,09; ×6→24,54).
 *
 * @param {Decimal} grossDec
 * @param {number | string | Decimal} percent
 * @param {{ qty?: number; unitPriceDec?: Decimal | null }} [opts]
 */
export function mercadoLivreFeeFromPercentOfGross(grossDec, percent, opts = {}) {
  const p = new Decimal(percent);
  if (p.lte(0) || grossDec.lte(0)) return null;

  const qty = opts.qty != null && opts.qty > 1 ? Math.trunc(opts.qty) : 1;
  const unit = opts.unitPriceDec;
  if (qty > 1 && unit != null && unit.gt(0)) {
    const perUnit = unit.mul(p).div(100).toDecimalPlaces(2, ML_MARKETPLACE_FEE_DECIMAL_ROUNDING);
    return perUnit.mul(qty);
  }

  return grossDec.mul(p).div(100).toDecimalPlaces(2, ML_MARKETPLACE_FEE_DECIMAL_ROUNDING);
}

/** @param {unknown} listingTypeId */
export function formatMercadoLivreListingTypeLabel(listingTypeId) {
  if (listingTypeId == null || String(listingTypeId).trim() === "") return null;
  const id = String(listingTypeId).trim().toLowerCase();
  if (id.includes("gold_pro")) return "Premium";
  if (id.includes("gold_special")) return "Clássico";
  if (id.includes("gold_premium")) return "Premium";
  if (id.includes("gold")) return "Ouro";
  if (id.includes("free")) return "Grátis";
  return null;
}
