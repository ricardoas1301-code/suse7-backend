import {
  buildMercadoLivreListingEditorPayload,
  isMercadoLivreListingMarketplace,
} from "./mercadoLivreListingEditorAdapter.js";

/**
 * @param {string | null | undefined} marketplace
 */
export function resolveListingEditorAdapter(marketplace) {
  if (isMercadoLivreListingMarketplace(marketplace)) {
    return {
      marketplace: "mercado_livre",
      buildDetailPayload: buildMercadoLivreListingEditorPayload,
    };
  }
  return null;
}

