// ======================================================================
// Política de imagens do anúncio — Strategy/Adapter por marketplace
// ======================================================================

import { ML_MARKETPLACE_SLUG } from "../../../handlers/ml/_helpers/mlMarketplace.js";
import {
  extractCategoryPictureLimits,
  fetchMercadoLivreCategoryJson,
} from "../../marketplaces/mercadoLivre/mercadoLivreCategoryPictures.js";

/**
 * @param {unknown} value
 */
function textoOuNull(value) {
  return value != null && String(value).trim() !== "" ? String(value).trim() : null;
}

/**
 * @typedef {Object} ListingImagesPolicy
 * @property {string} marketplace
 * @property {number | null} maxPicturesPerItem
 * @property {number | null} maxPicturesPerVariation
 * @property {number | null} displayMaxPictures
 * @property {string | null} categoryName
 * @property {string | null} source
 * @property {"high" | "none"} confidence
 * @property {boolean} hasVariations
 */

/**
 * @param {{
 *   marketplace?: string | null;
 *   categoryId?: string | null;
 *   categoryName?: string | null;
 *   listingType?: string | null;
 *   hasVariations?: boolean;
 *   accessToken?: string | null;
 *   categoryCache?: Map<string, Record<string, unknown> | null>;
 * }} input
 * @returns {Promise<ListingImagesPolicy>}
 */
export async function resolveListingImagesPolicy(input) {
  const marketplace = String(input.marketplace ?? "")
    .trim()
    .toLowerCase();
  const categoryId = textoOuNull(input.categoryId);
  const categoryName = textoOuNull(input.categoryName);
  const hasVariations = input.hasVariations === true;
  const accessToken = textoOuNull(input.accessToken);
  const categoryCache = input.categoryCache;

  /** @type {ListingImagesPolicy} */
  const base = {
    marketplace,
    maxPicturesPerItem: null,
    maxPicturesPerVariation: null,
    displayMaxPictures: null,
    categoryName,
    source: null,
    confidence: "none",
    hasVariations,
  };

  if (marketplace === ML_MARKETPLACE_SLUG && categoryId && accessToken) {
    const categoryJson = await fetchMercadoLivreCategoryJson(accessToken, categoryId, categoryCache);
    if (categoryJson) {
      const limits = extractCategoryPictureLimits(categoryJson);
      const displayMaxPictures = hasVariations
        ? limits.max_pictures_per_item_var ?? limits.max_pictures_per_item
        : limits.max_pictures_per_item;

      if (displayMaxPictures != null) {
        return {
          ...base,
          maxPicturesPerItem: limits.max_pictures_per_item,
          maxPicturesPerVariation: limits.max_pictures_per_item_var,
          displayMaxPictures,
          categoryName: limits.category_name ?? categoryName,
          source: "category_settings",
          confidence: "high",
        };
      }
    }
  }

  return base;
}
