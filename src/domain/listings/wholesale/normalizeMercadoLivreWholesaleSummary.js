// ======================================================================
// Normalização de atacado — Mercado Livre (Raio-X do Anúncio).
// Helper puro; preço tratado como Decimal/string, sem Number/float.
// ======================================================================

import Decimal from "decimal.js";

const LABEL_SEM_ATACADO = "Não vende no atacado";

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function textoOuNull(value) {
  if (value == null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const row = /** @type {Record<string, unknown>} */ (value);
    return textoOuNull(row.amount ?? row.value ?? row.price ?? row.id ?? row.name);
  }
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
 * @param {unknown} value
 * @returns {string | null}
 */
function quantidadeStringOuNull(value) {
  const text = textoOuNull(value);
  if (!text) return null;
  const onlyDigits = text.match(/\d+/)?.[0] ?? "";
  if (!onlyDigits) return null;
  const normalized = onlyDigits.replace(/^0+(?=\d)/, "");
  if (normalized === "" || normalized === "0" || normalized === "1") return null;
  return normalized;
}

/**
 * @param {string} value
 */
function quantidadeMenorQue(a, b) {
  if (a.length !== b.length) return a.length < b.length;
  return a < b;
}

/**
 * @param {string} value
 */
function quantidadeMaiorQueUm(value) {
  if (value.length !== 1) return true;
  return value > "1";
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
 * @param {Record<string, unknown>} priceRow
 * @returns {string | null}
 */
function extrairQuantidadeMinima(priceRow) {
  const conditions =
    priceRow.conditions && typeof priceRow.conditions === "object" && !Array.isArray(priceRow.conditions)
      ? /** @type {Record<string, unknown>} */ (priceRow.conditions)
      : null;
  const direct =
    quantidadeStringOuNull(conditions?.min_purchase_unit) ??
    quantidadeStringOuNull(priceRow.min_purchase_unit) ??
    quantidadeStringOuNull(priceRow.min_quantity) ??
    quantidadeStringOuNull(priceRow.minimum_quantity) ??
    quantidadeStringOuNull(priceRow.quantity);
  if (direct) return direct;

  const conditionsArray = Array.isArray(priceRow.conditions) ? priceRow.conditions : [];
  for (const conditionRaw of conditionsArray) {
    if (!conditionRaw || typeof conditionRaw !== "object") continue;
    const condition = /** @type {Record<string, unknown>} */ (conditionRaw);
    const id = String(condition.name ?? condition.type ?? condition.id ?? "").toUpperCase();
    if (!id.includes("MIN_QUANTITY") && !id.includes("QUANTITY")) continue;
    const rawValue =
      condition.value ??
      condition.value_id ??
      condition.value_name ??
      (Array.isArray(condition.values) ? condition.values[0] : null);
    const quantity = quantidadeStringOuNull(rawValue);
    if (quantity) return quantity;
  }

  return null;
}

/**
 * @param {Record<string, unknown>} priceRow
 */
function isTierAtacadoB2b(priceRow) {
  if (String(priceRow.type ?? "").toLowerCase() !== "standard") return false;

  const conditions =
    priceRow.conditions && typeof priceRow.conditions === "object" && !Array.isArray(priceRow.conditions)
      ? /** @type {Record<string, unknown>} */ (priceRow.conditions)
      : null;
  const restrictions = Array.isArray(conditions?.context_restrictions)
    ? conditions.context_restrictions.map((item) => String(item).trim().toLowerCase())
    : [];
  if (!restrictions.includes("channel_marketplace")) return false;
  if (!restrictions.includes("user_type_business")) return false;

  const minQuantity = extrairQuantidadeMinima(priceRow);
  if (!minQuantity || !quantidadeMaiorQueUm(minQuantity)) return false;

  const currency = textoOuNull(priceRow.currency_id);
  if (currency && currency.toUpperCase() !== "BRL") return false;

  return extrairPrecoUnitario(priceRow) != null;
}

/**
 * @param {Record<string, unknown>} priceRow
 * @returns {string | null}
 */
function extrairPrecoUnitario(priceRow) {
  return (
    decimalStringOuNull(priceRow.unit_price) ??
    decimalStringOuNull(priceRow.unit_amount) ??
    decimalStringOuNull(priceRow.amount) ??
    decimalStringOuNull(priceRow.price) ??
    decimalStringOuNull(priceRow.value) ??
    decimalStringOuNull(priceRow.price_amount)
  );
}

/**
 * @param {unknown[]} rows
 */
function escolherFaixaAtacado(rows) {
  /** @type {{ min_quantity: string; unit_price_brl: string } | null} */
  let best = null;
  let tiersCount = 0;

  for (const rowRaw of rows) {
    if (!rowRaw || typeof rowRaw !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (rowRaw);
    if (!isTierAtacadoB2b(row)) continue;
    const minQuantity = extrairQuantidadeMinima(row);
    const unitPrice = extrairPrecoUnitario(row);
    if (!minQuantity || !unitPrice) continue;
    tiersCount += 1;

    if (
      best == null ||
      quantidadeMenorQue(minQuantity, best.min_quantity) ||
      (minQuantity === best.min_quantity && new Decimal(unitPrice).lt(best.unit_price_brl))
    ) {
      best = { min_quantity: minQuantity, unit_price_brl: unitPrice };
    }
  }

  return best ? { ...best, tiers_count: tiersCount } : null;
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function extrairArrayPayload(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const root = /** @type {Record<string, unknown>} */ (value);
  for (const key of ["prices", "results", "data", "price_tiers", "quantity_discounts", "wholesale_prices", "items"]) {
    if (Array.isArray(root[key])) return /** @type {unknown[]} */ (root[key]);
  }
  if (root.data && typeof root.data === "object") return extrairArrayPayload(root.data);
  return [];
}

/**
 * @param {Record<string, unknown> | null | undefined} rawListing
 */
export function normalizeMercadoLivreWholesaleSummary(rawListing) {
  const root =
    rawListing && typeof rawListing === "object" && !Array.isArray(rawListing)
      ? /** @type {Record<string, unknown>} */ (rawListing)
      : {};

  const pricesResult =
    root.item_prices_show_all &&
    typeof root.item_prices_show_all === "object" &&
    !Array.isArray(root.item_prices_show_all)
      ? /** @type {Record<string, unknown>} */ (root.item_prices_show_all)
      : null;

  if (pricesResult && pricesResult.ok === false) {
    return {
      enabled: false,
      min_quantity: null,
      unit_price_brl: null,
      unit_price_label: LABEL_SEM_ATACADO,
      tiers_count: 0,
      label: LABEL_SEM_ATACADO,
      source: "api_error",
      source_confidence: "unknown",
      debug_reason: textoOuNull(pricesResult.error_code) ?? "api_error",
    };
  }

  const rows = extrairArrayPayload(pricesResult?.data ?? root);
  const found = escolherFaixaAtacado(rows);

  if (!found) {
    return {
      enabled: false,
      min_quantity: null,
      unit_price_brl: null,
      unit_price_label: LABEL_SEM_ATACADO,
      tiers_count: 0,
      label: LABEL_SEM_ATACADO,
      source: pricesResult?.ok === true ? "item_without_quantity_price" : "unknown",
      source_confidence: pricesResult?.ok === true ? "api_verified" : "unknown",
      debug_reason: pricesResult?.ok === true ? "no_b2b_quantity_tier" : "missing_prices_payload",
    };
  }

  const unitPriceLabel = formatarBrlDecimalString(found.unit_price_brl);
  return {
    enabled: true,
    min_quantity: found.min_quantity,
    unit_price_brl: found.unit_price_brl,
    unit_price_label: unitPriceLabel,
    tiers_count: found.tiers_count,
    label: unitPriceLabel,
    source: "item_prices_show_all",
    source_confidence: "api_verified",
  };
}
