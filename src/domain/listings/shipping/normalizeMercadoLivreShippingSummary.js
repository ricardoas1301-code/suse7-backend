// ======================================================================
// Normalização de envio/logística — Mercado Livre (Raio-X do Anúncio).
// Helper puro, sem dependência de request.
// ======================================================================

/** @typedef {'raw_ml_shipping' | 'fallback' | 'unknown'} ShippingSourceConfidence */

/** @type {Record<string, string>} */
const LOGISTIC_TYPE_LABELS = {
  fulfillment: "Full",
  xd_drop_off: "Mercado Envios",
  cross_docking: "Mercado Envios Coleta",
  drop_off: "Mercado Envios",
  self_service: "Flex",
};

/** @type {Record<string, string>} */
const MODE_LABELS = {
  me2: "Mercado Envios",
  me1: "Mercado Envios",
  custom: "Personalizado",
};

/** Tags oficiais ML que indicam Flex (Envios Flex). */
const FLEX_TAG_SIGNALS = new Set(["self_service_in", "self_service", "self_service_out", "flex"]);

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizarCodigo(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  return text !== "" ? text : null;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function coletarTagsLista(value) {
  if (!Array.isArray(value)) return [];
  return value.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {unknown} value
 * @returns {boolean | null}
 */
function resolverBoolFrete(value) {
  if (value === true || value === false) return value;
  return null;
}

/**
 * @param {string | null} code
 */
function labelLogisticType(code) {
  if (!code) return "Não informado";
  return LOGISTIC_TYPE_LABELS[code] ?? "Não informado";
}

/**
 * @param {string | null} code
 */
function labelMode(code) {
  if (!code) return "Não informado";
  return MODE_LABELS[code] ?? "Não informado";
}

/**
 * @param {boolean | null} value
 * @returns {"Sim" | "Não" | "—"}
 */
function labelFreteGratis(value) {
  if (value === true) return "Sim";
  if (value === false) return "Não";
  return "—";
}

/**
 * @param {string | null} logisticTypeCode
 * @param {string[]} tagUniverse
 */
function detectarFlex(logisticTypeCode, tagUniverse) {
  if (logisticTypeCode === "self_service") return true;
  return tagUniverse.some((tag) => FLEX_TAG_SIGNALS.has(tag));
}

/**
 * Full somente com logistic_type fulfillment — nunca inferir de mode me2.
 * @param {string | null} logisticTypeCode
 */
function detectarFull(logisticTypeCode) {
  return logisticTypeCode === "fulfillment";
}

/**
 * @param {boolean} isFull
 * @param {boolean} isFlex
 * @param {boolean} hasShippingData
 */
function labelServicoEntregaComposto(isFull, isFlex, hasShippingData) {
  if (!hasShippingData) return "Não informado";
  if (isFull && isFlex) return "Full / Flex";
  if (isFull) return "Full";
  if (isFlex) return "Padrão / Flex";
  return "Padrão";
}

/**
 * @param {boolean} isFlex
 * @param {boolean} hasShippingData
 * @returns {"Sim" | "Não" | "—"}
 */
function labelFlex(isFlex, hasShippingData) {
  if (!hasShippingData) return "—";
  return isFlex ? "Sim" : "Não";
}

/**
 * @returns {{
 *   marketplace: "mercadolivre";
 *   mode_code: string | null;
 *   mode_label: string;
 *   logistic_type_code: string | null;
 *   logistic_type_label: string;
 *   free_shipping: boolean | null;
 *   free_shipping_label: "Sim" | "Não" | "—";
 *   has_flex: boolean | null;
 *   flex_label: "Sim" | "Não" | "—";
 *   is_full: boolean | null;
 *   is_flex: boolean | null;
 *   delivery_service_label: string;
 *   delivery_program_label: string;
 *   source_confidence: ShippingSourceConfidence;
 * }}
 */
export function buildEmptyMercadoLivreShippingSummary() {
  return {
    marketplace: "mercadolivre",
    mode_code: null,
    mode_label: "Não informado",
    logistic_type_code: null,
    logistic_type_label: "Não informado",
    free_shipping: null,
    free_shipping_label: "—",
    has_flex: null,
    flex_label: "—",
    is_full: null,
    is_flex: null,
    delivery_service_label: "Não informado",
    delivery_program_label: "Não informado",
    source_confidence: "unknown",
  };
}

/**
 * Normaliza shipping do payload bruto ML (item completo ou objeto shipping).
 * @param {Record<string, unknown> | null | undefined} rawListingOrShipping
 */
export function normalizeMercadoLivreShippingSummary(rawListingOrShipping) {
  const root =
    rawListingOrShipping && typeof rawListingOrShipping === "object" && !Array.isArray(rawListingOrShipping)
      ? /** @type {Record<string, unknown>} */ (rawListingOrShipping)
      : null;

  const shippingFromRoot =
    root?.shipping && typeof root.shipping === "object" && !Array.isArray(root.shipping)
      ? /** @type {Record<string, unknown>} */ (root.shipping)
      : null;

  const shippingDirect =
    root &&
    (Object.prototype.hasOwnProperty.call(root, "mode") ||
      Object.prototype.hasOwnProperty.call(root, "logistic_type") ||
      Object.prototype.hasOwnProperty.call(root, "free_shipping"))
      ? root
      : null;

  const shipping = shippingFromRoot ?? shippingDirect;

  if (!shipping) {
    return buildEmptyMercadoLivreShippingSummary();
  }

  const modeCode = normalizarCodigo(shipping.mode);
  const logisticTypeCode = normalizarCodigo(shipping.logistic_type);
  const freeShipping = resolverBoolFrete(shipping.free_shipping);
  const shippingTags = coletarTagsLista(shipping.tags);
  const itemTags = shippingFromRoot && root ? coletarTagsLista(root.tags) : [];
  const tagUniverse = [...new Set([...shippingTags, ...itemTags])];

  const hasShippingData =
    modeCode != null || logisticTypeCode != null || freeShipping != null || tagUniverse.length > 0;

  const isFull = detectarFull(logisticTypeCode);
  const isFlex = detectarFlex(logisticTypeCode, tagUniverse);
  const deliveryServiceLabel = labelServicoEntregaComposto(isFull, isFlex, hasShippingData);

  return {
    marketplace: "mercadolivre",
    mode_code: modeCode,
    mode_label: labelMode(modeCode),
    logistic_type_code: logisticTypeCode,
    logistic_type_label: labelLogisticType(logisticTypeCode),
    free_shipping: freeShipping,
    free_shipping_label: labelFreteGratis(freeShipping),
    has_flex: hasShippingData ? isFlex : null,
    flex_label: labelFlex(isFlex, hasShippingData),
    is_full: hasShippingData ? isFull : null,
    is_flex: hasShippingData ? isFlex : null,
    delivery_service_label: deliveryServiceLabel,
    delivery_program_label: deliveryServiceLabel,
    source_confidence: hasShippingData ? "raw_ml_shipping" : "unknown",
  };
}

/**
 * Log DEV seguro (sem token) — ativar com S7_DEBUG_ML_SHIPPING=1.
 * @param {Record<string, unknown> | null | undefined} rawItem
 * @param {string | null | undefined} listingId
 */
export function logMercadoLivreShippingAudit(rawItem, listingId = null) {
  if (process.env.NODE_ENV === "production") return;
  if (process.env.S7_DEBUG_ML_SHIPPING !== "1") return;

  const shipping =
    rawItem?.shipping && typeof rawItem.shipping === "object" && !Array.isArray(rawItem.shipping)
      ? /** @type {Record<string, unknown>} */ (rawItem.shipping)
      : {};

  console.info("[S7_ML_SHIPPING_AUDIT]", {
    listing_id: listingId ?? null,
    mode: shipping.mode ?? null,
    logistic_type: shipping.logistic_type ?? null,
    free_shipping: shipping.free_shipping ?? null,
    shipping_tags: Array.isArray(shipping.tags) ? shipping.tags : [],
    item_tags: Array.isArray(rawItem?.tags) ? rawItem.tags : [],
    normalized: normalizeMercadoLivreShippingSummary(rawItem),
  });
}
