// ======================================================================
// Normalização de preço de venda — Mercado Livre (Raio-X do Anúncio).
// Helper puro; preço tratado como Decimal/string, sem Number/float.
// ======================================================================

import Decimal from "decimal.js";

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function textoOuNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text !== "" ? text : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function decimalStringOuNull(value) {
  const text = textoOuNull(value);
  if (!text) return null;
  try {
    const dec = new Decimal(text.replace(",", "."));
    if (!dec.isFinite() || dec.lte(0)) return null;
    return dec.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  } catch {
    return null;
  }
}

/**
 * @param {string} decimalString
 */
function formatarBrlDecimalString(decimalString) {
  const fixed = new Decimal(decimalString).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const [inteiroRaw, centavos] = fixed.split(".");
  const inteiro = inteiroRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${inteiro},${centavos}`;
}

/**
 * @param {Record<string, unknown> | null | undefined} rawItemOrListing
 */
export function normalizeMercadoLivrePriceSummary(rawItemOrListing) {
  const root =
    rawItemOrListing && typeof rawItemOrListing === "object" && !Array.isArray(rawItemOrListing)
      ? /** @type {Record<string, unknown>} */ (rawItemOrListing)
      : {};

  const salePrice = decimalStringOuNull(root.price);
  if (!salePrice) {
    return {
      sale_price_brl: null,
      sale_price_label: "—",
      source: "unknown",
      source_confidence: "unknown",
    };
  }

  return {
    sale_price_brl: salePrice,
    sale_price_label: formatarBrlDecimalString(salePrice),
    source: "raw_item_price",
    source_confidence: "raw_ml_payload",
  };
}
