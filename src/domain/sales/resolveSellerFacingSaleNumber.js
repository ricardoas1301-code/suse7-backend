// ======================================================================
// Identificador seller-facing para UI ("Venda nº" no Mercado Livre = pack_id).
// Identidade técnica (external_order_id) permanece intacta para webhook/scanner/billing.
// ======================================================================

/**
 * Extrai pack_id do raw snapshot do pedido (histórico sem coluna preenchida).
 * @param {Record<string, unknown> | null | undefined} order
 * @returns {string | null}
 */
function packIdFromOrderRaw(order) {
  const raw =
    order?.raw_json && typeof order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (order.raw_json)
      : null;
  if (!raw) return null;
  const pack = raw.pack_id ?? raw.packId ?? null;
  if (pack == null || String(pack).trim() === "") return null;
  return String(pack).trim();
}

/**
 * Número de negócio apresentado pelo marketplace (determinístico).
 * Precedência: external_pack_id (coluna) → pack_id no raw → external_order_id.
 * @param {{ external_pack_id?: unknown; external_order_id?: unknown; raw_json?: unknown } | null | undefined} order
 * @returns {string | null}
 */
export function resolveSellerFacingSaleNumberFromOrder(order) {
  if (!order || typeof order !== "object") return null;
  const packCol =
    order.external_pack_id != null && String(order.external_pack_id).trim() !== ""
      ? String(order.external_pack_id).trim()
      : null;
  if (packCol) return packCol;
  const packRaw = packIdFromOrderRaw(order);
  if (packRaw) return packRaw;
  const oid =
    order.external_order_id != null && String(order.external_order_id).trim() !== ""
      ? String(order.external_order_id).trim()
      : null;
  return oid;
}

/**
 * @param {{ external_pack_id?: unknown; external_order_id?: unknown; raw_json?: unknown } | null | undefined} order
 * @param {{ external_order_id?: unknown } | null | undefined} [item]
 * @returns {string | null}
 */
export function resolveTechnicalOrderId(order, item = null) {
  const fromOrder =
    order?.external_order_id != null && String(order.external_order_id).trim() !== ""
      ? String(order.external_order_id).trim()
      : null;
  if (fromOrder) return fromOrder;
  if (item?.external_order_id != null && String(item.external_order_id).trim() !== "") {
    return String(item.external_order_id).trim();
  }
  return null;
}

/**
 * @param {{ external_pack_id?: unknown; external_order_id?: unknown; raw_json?: unknown } | null | undefined} order
 * @param {{ external_order_id?: unknown } | null | undefined} [item]
 * @returns {{ sale_display_code: string | null; technical_order_id: string | null; pack_id: string | null }}
 */
export function resolveSaleDisplayIdentifiers(order, item = null) {
  const technical_order_id = resolveTechnicalOrderId(order, item);
  const sale_display_code = resolveSellerFacingSaleNumberFromOrder(order) ?? technical_order_id;
  const pack_id =
    order?.external_pack_id != null && String(order.external_pack_id).trim() !== ""
      ? String(order.external_pack_id).trim()
      : packIdFromOrderRaw(order);
  return { sale_display_code, technical_order_id, pack_id };
}
