// ======================================================================
// Valores monetários — Decimal.js (sem float em regra de negócio)
// ======================================================================

import Decimal from "decimal.js";

/**
 * @param {unknown} raw
 * @returns {Decimal}
 */
export function toDecimal(raw) {
  if (raw == null || raw === "") return new Decimal(0);
  try {
    return new Decimal(String(raw));
  } catch {
    return new Decimal(0);
  }
}

/**
 * String com 2 casas para API / Postgres numeric.
 * @param {Decimal} d
 */
export function decimalToScale2String(d) {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * @param {unknown} raw
 */
export function isPositiveMoney(raw) {
  return toDecimal(raw).gt(0);
}

/**
 * @param {unknown} raw
 */
export function isZeroMoney(raw) {
  return toDecimal(raw).isZero();
}
