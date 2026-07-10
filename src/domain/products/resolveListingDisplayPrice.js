// ======================================================================
// Preço praticado do anúncio — mesma regra de GET /api/products/listings
// display_price_brl = preço que o seller pratica hoje (coluna price / promo).
// ======================================================================

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numeroOuNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {number | null} value
 * @returns {string | null}
 */
function formatPriceBrlString(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return value.toFixed(2);
}

/**
 * @param {Record<string, unknown>} listingRow
 * @param {Record<string, unknown> | null | undefined} healthRow
 */
export function resolveListingDisplayPriceFields(listingRow, healthRow = null) {
  const price = numeroOuNull(listingRow?.price);
  const orig = numeroOuNull(listingRow?.original_price);
  const base = numeroOuNull(listingRow?.base_price);

  const onPromo = (() => {
    const pricing =
      healthRow?.raw_json && typeof healthRow.raw_json === "object"
        ? /** @type {Record<string, unknown>} */ (healthRow.raw_json).suse7_pricing_resolution
        : null;
    if (pricing && typeof pricing === "object") {
      const p = /** @type {Record<string, unknown>} */ (pricing);
      return p.promotion_active === true || p.has_valid_promotion === true;
    }
    const promoPrice = numeroOuNull(healthRow?.promotion_price);
    if (promoPrice != null && price != null && promoPrice < price) return true;
    return (
      (orig != null && price != null && orig > price + 0.004) ||
      (base != null && price != null && base > price + 0.004)
    );
  })();

  const displayPrice = price;
  const regularPrice =
    onPromo && orig != null && Number.isFinite(orig)
      ? orig
      : onPromo && base != null && Number.isFinite(base)
        ? base
        : null;

  return {
    display_price_brl: formatPriceBrlString(displayPrice),
    regular_price_brl: formatPriceBrlString(regularPrice),
    is_promotion_active: Boolean(onPromo),
  };
}
