// ======================================================================
// Estoque virtual por anúncio — contrato interno do Raio-X do Anúncio.
// Não sincroniza estoque no marketplace; apenas resolve configuração SUS7.
// ======================================================================

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function inteiroNaoNegativoOuNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/**
 * @param {{
 *   product_stock?: unknown;
 *   product_min_stock?: unknown;
 *   marketplace_listing_stock?: unknown;
 *   product_virtual_stock_enabled?: unknown;
 *   product_virtual_stock_value?: unknown;
 *   listing_virtual_stock_override_enabled?: unknown;
 *   listing_virtual_stock_value?: unknown;
 *   listing_sync_status?: unknown;
 * }} input
 */
export function normalizeListingVirtualStockSummary(input = {}) {
  const productVirtualEnabled = input.product_virtual_stock_enabled === true;
  const productVirtualValue = productVirtualEnabled
    ? inteiroNaoNegativoOuNull(input.product_virtual_stock_value)
    : null;
  const listingOverrideEnabled = input.listing_virtual_stock_override_enabled === true;
  const listingOverrideValue = listingOverrideEnabled
    ? inteiroNaoNegativoOuNull(input.listing_virtual_stock_value)
    : null;

  let effectiveSource = "none";
  let effectiveValue = null;

  if (listingOverrideEnabled && listingOverrideValue != null) {
    effectiveSource = "listing_override";
    effectiveValue = listingOverrideValue;
  } else if (!listingOverrideEnabled && productVirtualEnabled && productVirtualValue != null) {
    effectiveSource = "product_default";
    effectiveValue = productVirtualValue;
  }

  return {
    product_stock: inteiroNaoNegativoOuNull(input.product_stock),
    product_min_stock: inteiroNaoNegativoOuNull(input.product_min_stock),
    marketplace_listing_stock: inteiroNaoNegativoOuNull(input.marketplace_listing_stock),
    listing_stock: inteiroNaoNegativoOuNull(input.marketplace_listing_stock),

    product_virtual_stock_enabled: productVirtualEnabled,
    product_virtual_stock_value: productVirtualValue,
    product_virtual_stock: productVirtualValue,

    listing_virtual_stock_override_enabled: listingOverrideEnabled,
    listing_virtual_stock_value: listingOverrideEnabled ? listingOverrideValue : null,
    listing_virtual_stock_enabled: listingOverrideEnabled,
    listing_virtual_stock: listingOverrideEnabled ? listingOverrideValue : null,

    effective_virtual_stock_source: effectiveSource,
    effective_virtual_stock_value: effectiveValue,
    listing_sync_status:
      input.listing_sync_status != null && String(input.listing_sync_status).trim() !== ""
        ? String(input.listing_sync_status).trim()
        : null,
  };
}
