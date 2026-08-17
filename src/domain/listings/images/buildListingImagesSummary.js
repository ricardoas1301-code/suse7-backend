// ======================================================================
// Monta images_summary normalizado para o Raio-X do Anúncio
// ======================================================================

import { aplicarOrdemLocalNasImagensListing, textoOuNull } from "./listingPictureKeys.js";

/**
 * @param {{
 *   pictures?: unknown;
 *   policy?: import("./resolveListingImagesPolicy.js").ListingImagesPolicy | null;
 *   categoryId?: string | null;
 *   categoryName?: string | null;
 *   primaryPictureSettings?: {
 *     primary_picture_id?: string | null;
 *     primary_picture_url?: string | null;
 *     ordered_picture_keys?: unknown;
 *   } | null;
 * }} input
 */
export function buildListingImagesSummary(input) {
  const policy = input.policy ?? null;
  const categoryId = textoOuNull(input.categoryId);
  const categoryName = textoOuNull(input.categoryName) ?? policy?.categoryName ?? null;
  const applied = aplicarOrdemLocalNasImagensListing(input.pictures, input.primaryPictureSettings ?? null);

  return {
    category_id: categoryId,
    category_name: categoryName,
    max_pictures_per_item: policy?.maxPicturesPerItem ?? null,
    max_pictures_per_item_var: policy?.maxPicturesPerVariation ?? null,
    pictures_count: applied.pictures.length,
    pictures: applied.pictures,
    ordered_picture_keys: applied.ordered_picture_keys,
    primary_picture_id: textoOuNull(input.primaryPictureSettings?.primary_picture_id),
    primary_picture_url: textoOuNull(input.primaryPictureSettings?.primary_picture_url),
    effective_primary_picture_id: applied.effective_primary_picture_id,
    effective_primary_picture_url: applied.effective_primary_picture_url,
    effective_primary_picture_key: applied.effective_primary_picture_key,
    effective_primary_source: applied.effective_primary_source,
    images_policy: {
      maxPictures: policy?.displayMaxPictures ?? null,
      maxPicturesPerItem: policy?.maxPicturesPerItem ?? null,
      maxPicturesPerVariation: policy?.maxPicturesPerVariation ?? null,
      source: policy?.source ?? null,
      confidence: policy?.confidence ?? "none",
      marketplace: policy?.marketplace ?? null,
      hasVariations: policy?.hasVariations === true,
    },
  };
}
