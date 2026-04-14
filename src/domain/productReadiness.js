// ======================================================
// Readiness do produto (catálogo) — fonte única para API / grid.
// "Pronto" = nome + SKU + custo > 0; demais campos não bloqueiam.
//
// SINCRONIZAÇÃO: suse7-frontend/src/utils/productReadiness.js deve espelhar
// toDec / isNonEmptyTrimmed / a regra de custo > 0 abaixo (sem divergir).
// ======================================================

import Decimal from "decimal.js";

/**
 * Mesma semântica do front: null, "", "0", "0,00", NaN → não positivo.
 * Valores vindos do Postgres/API (numeric/string) ou string pt-BR.
 *
 * @param {unknown} v
 * @returns {Decimal | null}
 */
export function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
export function isCostPositive(v) {
  const d = toDec(v);
  return d != null && d.gt(0);
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
export function isNonEmptyTrimmed(v) {
  return v != null && String(v).trim() !== "";
}

/**
 * @param {Record<string, unknown> | null | undefined} product — product_name, sku, cost_price (colunas DB)
 * @returns {{ is_product_ready: boolean; missing_fields: string[]; product_completeness_score: number }}
 */
export function computeProductReadiness(product) {
  const p = product && typeof product === "object" && !Array.isArray(product) ? product : null;
  const nameOk = isNonEmptyTrimmed(p?.product_name);
  const skuOk = isNonEmptyTrimmed(p?.sku);
  const costOk = isCostPositive(p?.cost_price);

  /** @type {string[]} */
  const missing_fields = [];
  if (!nameOk) missing_fields.push("name");
  if (!skuOk) missing_fields.push("sku");
  if (!costOk) missing_fields.push("cost_price");

  const is_product_ready = missing_fields.length === 0;

  let product_completeness_score = 0;
  if (nameOk) product_completeness_score += 40;
  if (skuOk) product_completeness_score += 30;
  if (costOk) product_completeness_score += 30;
  if (is_product_ready) product_completeness_score = 100;

  return { is_product_ready, missing_fields, product_completeness_score };
}

/**
 * Monta o snapshot de produto a partir da linha de listing (GET /api/ml/listings).
 * @param {Record<string, unknown> | null | undefined} listing
 */
export function buildProductReadinessInputFromListing(listing) {
  const l = listing && typeof listing === "object" && !Array.isArray(listing) ? listing : null;
  const pc =
    l?.product_cost_row && typeof l.product_cost_row === "object" && !Array.isArray(l.product_cost_row)
      ? l.product_cost_row
      : {};
  return {
    product_name: l?.product_name,
    sku: l?.product_sku,
    cost_price: pc.cost_price,
  };
}
