// ======================================================================
// Identificador seller-facing para UI ("Venda nº" no Mercado Livre = pack_id).
// Identidade técnica (external_order_id) permanece intacta para webhook/scanner/billing.
// ======================================================================

/**
 * @param {{ external_pack_id?: unknown; external_order_id?: unknown } | null | undefined} order
 * @returns {string | null}
 */
export function resolveSellerFacingSaleNumberFromOrder(order) {
  if (!order || typeof order !== "object") return null;
  const pack =
    order.external_pack_id != null && String(order.external_pack_id).trim() !== ""
      ? String(order.external_pack_id).trim()
      : null;
  if (pack) return pack;
  const oid =
    order.external_order_id != null && String(order.external_order_id).trim() !== ""
      ? String(order.external_order_id).trim()
      : null;
  return oid;
}

/**
 * @param {{ external_pack_id?: unknown; external_order_id?: unknown } | null | undefined} order
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
