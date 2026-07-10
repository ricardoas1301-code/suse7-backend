// ======================================================================
// Resolve medidas do marketplace para measurements_summary (multi-marketplace)
// ======================================================================

import { isMercadoLivreListingMarketplace } from "../../../handlers/ml/_helpers/listingEditor/mercadoLivreListingEditorAdapter.js";
import { resolveMercadoLivreListingMeasurements } from "../../marketplaces/mercadoLivre/resolveMercadoLivreListingMeasurements.js";

function blocoVazio() {
  return {
    width_cm: null,
    height_cm: null,
    length_cm: null,
    weight_kg: null,
  };
}

/**
 * @param {string | null | undefined} marketplace
 * @param {Record<string, unknown>} rawItem
 */
export function resolveListingMarketplaceMeasurements(marketplace, rawItem) {
  if (isMercadoLivreListingMarketplace(marketplace)) {
    return resolveMercadoLivreListingMeasurements(rawItem);
  }

  return {
    shipping: blocoVazio(),
    product_mounted: blocoVazio(),
  };
}
