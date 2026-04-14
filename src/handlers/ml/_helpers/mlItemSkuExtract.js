// ======================================================================
// Extração de SKU do vendedor a partir do payload ML (item / variações).
// Módulo separado para evitar import circular entre persist e product link.
// ======================================================================

/** marketplace_listings.attention_reason — ML não enviou SKU; seller informa no Suse7. */
export const ATTENTION_REASON_SKU_PENDING_ML = "sku_pending_ml";

/**
 * SKU do vendedor: campo livre, atributo SELLER_SKU no item ou nas variações.
 * Alinhado à grid (mercadoLivreListingGrid.extractSku) para vínculo produto ≠ importação.
 * @param {Record<string, unknown> | null | undefined} item
 * @returns {string | null}
 */
export function extractSellerSku(item) {
  if (!item || typeof item !== "object") return null;
  if (item.seller_custom_field != null && String(item.seller_custom_field).trim() !== "") {
    return String(item.seller_custom_field).trim();
  }
  if (item.seller_sku != null && String(item.seller_sku).trim() !== "") {
    return String(item.seller_sku).trim();
  }
  const attrs = item.attributes;
  if (Array.isArray(attrs)) {
    const sku = attrs.find((a) => a?.id === "SELLER_SKU" || String(a?.name || "").toUpperCase() === "SKU");
    if (sku?.value_name != null && String(sku.value_name).trim() !== "") return String(sku.value_name).trim();
  }
  const vars = item.variations;
  if (Array.isArray(vars)) {
    for (const v of vars) {
      if (!v || typeof v !== "object") continue;
      const o = /** @type {Record<string, unknown>} */ (v);
      if (o.seller_custom_field != null && String(o.seller_custom_field).trim() !== "") {
        return String(o.seller_custom_field).trim();
      }
      if (o.seller_sku != null && String(o.seller_sku).trim() !== "") {
        return String(o.seller_sku).trim();
      }
      const va = o.attributes;
      if (Array.isArray(va)) {
        const sku = va.find((a) => a?.id === "SELLER_SKU" || String(a?.name || "").toUpperCase() === "SKU");
        if (sku?.value_name != null && String(sku.value_name).trim() !== "") return String(sku.value_name).trim();
      }
    }
  }
  return null;
}
