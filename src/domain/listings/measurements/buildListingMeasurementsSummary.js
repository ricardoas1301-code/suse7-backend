// ======================================================================
// Monta measurements_summary normalizado para o Raio-X do Anúncio
// ======================================================================

const BLOCK_FIELDS = ["width_cm", "height_cm", "length_cm", "weight_kg"];

/**
 * @param {unknown} value
 */
export function numeroMedidaOuNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const normalized = String(value).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} block
 */
function normalizarBlocoMedidas(block) {
  if (!block || typeof block !== "object") {
    return {
      width_cm: null,
      height_cm: null,
      length_cm: null,
      weight_kg: null,
    };
  }
  return {
    width_cm: numeroMedidaOuNull(block.width_cm ?? block.width),
    height_cm: numeroMedidaOuNull(block.height_cm ?? block.height),
    length_cm: numeroMedidaOuNull(block.length_cm ?? block.length),
    weight_kg: numeroMedidaOuNull(block.weight_kg ?? block.weight),
  };
}

/**
 * @param {{
 *   local?: Record<string, unknown> | null;
 *   marketplace?: Record<string, unknown> | null;
 *   product?: Record<string, unknown> | null;
 * }} sources
 */
function mesclarBlocoMedidas(sources) {
  const local = normalizarBlocoMedidas(sources.local);
  const marketplace = normalizarBlocoMedidas(sources.marketplace);
  const product = normalizarBlocoMedidas(sources.product);

  /** @type {Record<string, number | null>} */
  const effective = {};
  /** @type {Record<string, string>} */
  const fieldSources = {};

  for (const field of BLOCK_FIELDS) {
    if (local[field] != null) {
      effective[field] = local[field];
      fieldSources[field] = "local_override";
    } else if (marketplace[field] != null) {
      effective[field] = marketplace[field];
      fieldSources[field] = "marketplace_default";
    } else if (product[field] != null) {
      effective[field] = product[field];
      fieldSources[field] = "product_fallback";
    } else {
      effective[field] = null;
      fieldSources[field] = "none";
    }
  }

  const sourceValues = new Set(Object.values(fieldSources));
  let effectiveSource = "none";
  if (sourceValues.has("local_override")) {
    effectiveSource = sourceValues.size === 1 && sourceValues.has("local_override") ? "local_override" : "mixed";
  } else if (sourceValues.has("marketplace_default")) {
    effectiveSource = "marketplace_default";
  } else if (sourceValues.has("product_fallback")) {
    effectiveSource = "product_fallback";
  }

  return {
    width_cm: effective.width_cm,
    height_cm: effective.height_cm,
    length_cm: effective.length_cm,
    weight_kg: effective.weight_kg,
    field_sources: fieldSources,
    effective_source: effectiveSource,
  };
}

/**
 * @param {{
 *   marketplaceMeasurements?: {
 *     shipping?: Record<string, unknown> | null;
 *     product_mounted?: Record<string, unknown> | null;
 *   } | null;
 *   productMeasurements?: {
 *     shipping?: Record<string, unknown> | null;
 *     product_mounted?: Record<string, unknown> | null;
 *   } | null;
 *   localMeasurements?: {
 *     shipping?: Record<string, unknown> | null;
 *     product_mounted?: Record<string, unknown> | null;
 *   } | null;
 * }} input
 */
export function buildListingMeasurementsSummary(input) {
  const marketplace = input.marketplaceMeasurements ?? {};
  const product = input.productMeasurements ?? {};
  const local = input.localMeasurements ?? {};

  const shipping = mesclarBlocoMedidas({
    local: local.shipping,
    marketplace: marketplace.shipping,
    product: product.shipping,
  });

  const productMounted = mesclarBlocoMedidas({
    local: local.product_mounted,
    marketplace: marketplace.product_mounted,
    product: product.product_mounted,
  });

  const globalSources = new Set([
    shipping.effective_source,
    productMounted.effective_source,
  ]);

  let effectiveSource = "none";
  if (globalSources.has("local_override") || globalSources.has("mixed")) {
    effectiveSource = globalSources.has("mixed") || globalSources.size > 1 ? "mixed" : "local_override";
  } else if (globalSources.has("marketplace_default")) {
    effectiveSource = "marketplace_default";
  } else if (globalSources.has("product_fallback")) {
    effectiveSource = "product_fallback";
  }

  return {
    shipping: {
      width_cm: shipping.width_cm,
      height_cm: shipping.height_cm,
      length_cm: shipping.length_cm,
      weight_kg: shipping.weight_kg,
      field_sources: shipping.field_sources,
      effective_source: shipping.effective_source,
    },
    product_mounted: {
      width_cm: productMounted.width_cm,
      height_cm: productMounted.height_cm,
      length_cm: productMounted.length_cm,
      weight_kg: productMounted.weight_kg,
      field_sources: productMounted.field_sources,
      effective_source: productMounted.effective_source,
    },
    effective_source: effectiveSource,
  };
}
