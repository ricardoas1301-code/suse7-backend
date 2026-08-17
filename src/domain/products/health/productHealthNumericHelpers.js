// ======================================================================
// Helpers numéricos — Central de Saúde dos Produtos (Decimal, sem float).
// ======================================================================

import Decimal from "decimal.js";

/** @param {unknown} raw */
export function toDecimalOrNull(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  try {
    const dec = new Decimal(String(raw).trim().replace(",", "."));
    return dec.isFinite() ? dec : null;
  } catch {
    return null;
  }
}

/** @param {unknown} raw */
export function toDecimalOrZero(raw) {
  return toDecimalOrNull(raw) ?? new Decimal(0);
}

/**
 * @param {Decimal} value
 * @param {number} [places]
 */
export function formatDecimalFixed(value, places = 2) {
  return value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
}

/**
 * @param {Decimal} numerator
 * @param {Decimal} denominator
 * @param {number} [places]
 */
export function formatPercentFromRatio(numerator, denominator, places = 2) {
  if (denominator == null || !denominator.gt(0)) return "0.00";
  return numerator.div(denominator).mul(100).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
}

/**
 * @param {unknown} rawQty
 */
export function isStockQuantityKnown(rawQty) {
  if (rawQty == null) return false;
  const normalized = String(rawQty).trim();
  if (normalized === "") return false;
  const n = Number(normalized.replace(",", "."));
  return Number.isFinite(n);
}

/**
 * @param {unknown} rawQty
 * @returns {number | null}
 */
export function readKnownStockQuantity(rawQty) {
  if (!isStockQuantityKnown(rawQty)) return null;
  const n = Number(String(rawQty).trim().replace(",", "."));
  return Math.max(0, Math.trunc(n));
}

/**
 * @param {unknown} rawQty
 */
export function readStockQuantity(rawQty) {
  return readKnownStockQuantity(rawQty) ?? 0;
}

/**
 * Custo unitário oficial do produto (custo + operacional + embalagem).
 *
 * @param {{
 *   cost_price?: unknown;
 *   operational_cost?: unknown;
 *   packaging_cost?: unknown;
 * }} productRow
 */
export function resolverCustoUnitarioOficialProduto(productRow) {
  const cost = toDecimalOrNull(productRow?.cost_price);
  const operational = toDecimalOrNull(productRow?.operational_cost) ?? new Decimal(0);
  const packaging = toDecimalOrNull(productRow?.packaging_cost) ?? new Decimal(0);
  if (cost == null) return null;
  return cost.plus(operational).plus(packaging);
}

/**
 * @param {unknown} status
 */
export function normalizarStatusAnuncioAtivo(status) {
  const raw = String(status ?? "")
    .trim()
    .toLowerCase();
  return raw === "active";
}
