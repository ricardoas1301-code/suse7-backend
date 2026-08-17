// ======================================================================
// Completude de catálogo / custos — backend como fonte da verdade.
// Estados: complete | incomplete_required_costs | draft_imported_from_marketplace
// ======================================================================

/**
 * Espelha public.normalize_sku (Postgres): UPPER, trim, colapsar espaços.
 * Usado para lookup em products.normalized_sku.
 * @param {string | null | undefined} sku
 * @returns {string}
 */
export function normalizeSkuForDbLookup(sku) {
  if (sku == null || typeof sku !== "string") return "";
  return sku
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

/**
 * Custos obrigatórios para liberar análise financeira completa nos anúncios.
 * @param {unknown} costPrice
 * @param {unknown} packagingCost
 * @param {unknown} operationalCost
 * @returns {boolean}
 */
export function hasRequiredProductCosts(costPrice, packagingCost, operationalCost) {
  const cp =
    costPrice == null || costPrice === ""
      ? NaN
      : typeof costPrice === "number"
        ? costPrice
        : parseFloat(String(costPrice).trim().replace(",", "."));
  const pk =
    packagingCost == null || packagingCost === ""
      ? NaN
      : typeof packagingCost === "number"
        ? packagingCost
        : parseFloat(String(packagingCost).trim().replace(",", "."));
  const op =
    operationalCost == null || operationalCost === ""
      ? NaN
      : typeof operationalCost === "number"
        ? operationalCost
        : parseFloat(String(operationalCost).trim().replace(",", "."));

  return (
    Number.isFinite(cp) &&
    cp > 0 &&
    Number.isFinite(pk) &&
    pk >= 0 &&
    Number.isFinite(op) &&
    op >= 0
  );
}

/**
 * Projeção PostgREST da negação de `hasRequiredProductCosts`.
 * As comparações são executadas pelo PostgreSQL sobre colunas numeric,
 * sem conversão para float no runtime Node.
 *
 * @returns {string}
 */
export function buildMissingRequiredProductCostsPostgrestOrFilter() {
  return [
    "cost_price.is.null",
    "cost_price.lte.0",
    "packaging_cost.is.null",
    "packaging_cost.lt.0",
    "operational_cost.is.null",
    "operational_cost.lt.0",
  ].join(",");
}

/**
 * Resolve próximo catalog_completeness após salvar custos.
 * @param {{ cost_price?: unknown; packaging_cost?: unknown; operational_cost?: unknown }} costs
 * @param {{ catalog_source?: string | null }} ctx
 * @returns {'complete' | 'incomplete_required_costs' | 'draft_imported_from_marketplace'}
 */
export function resolveCatalogCompleteness(costs, ctx = {}) {
  const { cost_price, packaging_cost, operational_cost } = costs || {};
  if (hasRequiredProductCosts(cost_price, packaging_cost, operational_cost)) {
    return "complete";
  }
  if ((ctx.catalog_source || "").toLowerCase() === "marketplace_import") {
    return "draft_imported_from_marketplace";
  }
  return "incomplete_required_costs";
}
