// ======================================================================
// Mercado Livre — Strategy de sincronização de imagens do produto → anúncio
// ======================================================================

import { ML_MARKETPLACE_SLUG } from "../../../handlers/ml/_helpers/mlMarketplace.js";
import {
  fetchMercadoLivreCategoryPath,
  putMercadoLibreItemPartial,
} from "../../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import {
  extractCategoryPictureLimits,
  fetchMercadoLivreCategoryJson,
} from "../mercadoLivre/mercadoLivreCategoryPictures.js";
import { MLB_PICTURE_LIMIT_FALLBACK } from "./MarketplaceImageSyncStrategy.js";

const ML_API = "https://api.mercadolibre.com";

/**
 * @param {unknown} value
 */
function textoOuNull(value) {
  return value != null && String(value).trim() !== "" ? String(value).trim() : null;
}

/**
 * @param {Record<string, unknown>} rawJson
 */
function listingHasVariations(rawJson) {
  const vars = rawJson?.variations;
  return Array.isArray(vars) && vars.length > 0;
}

/**
 * @param {string} accessToken
 * @param {string} sourceUrl
 */
async function postMercadoLivrePictureFromSource(accessToken, sourceUrl) {
  const source = textoOuNull(sourceUrl);
  if (!source) {
    throw new Error("URL da imagem inválida para upload no Mercado Livre.");
  }
  const res = await fetch(`${ML_API}/pictures`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ source }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      json?.message != null
        ? String(json.message)
        : json?.error != null
          ? String(json.error)
          : `ML pictures HTTP ${res.status}`;
    const err = new Error(msg);
    /** @type {Error & { status?: number; body?: unknown }} */ (err).status = res.status;
    /** @type {Error & { status?: number; body?: unknown }} */ (err).body = json;
    throw err;
  }
  const pictureId = json?.id != null ? String(json.id).trim() : "";
  if (!pictureId) {
    throw new Error("Mercado Livre não retornou picture_id após upload.");
  }
  return {
    id: pictureId,
    secure_url: textoOuNull(json.secure_url) ?? textoOuNull(json.url),
    url: textoOuNull(json.url),
  };
}

/** @type {import("./MarketplaceImageSyncStrategy.js").MarketplaceImageSyncStrategy} */
export const MercadoLivreImageSyncStrategy = {
  marketplaceSlug: ML_MARKETPLACE_SLUG,

  async getImageLimitForListing(context, accessToken) {
    const rawJson = context.rawJson && typeof context.rawJson === "object" ? context.rawJson : {};
    const hasVariations = context.hasVariations || listingHasVariations(rawJson);
    const categoryId = textoOuNull(rawJson.category_id);

    if (accessToken && categoryId) {
      const categoryJson = await fetchMercadoLivreCategoryJson(accessToken, categoryId);
      const limits = categoryJson ? extractCategoryPictureLimits(categoryJson) : null;
      const fromCategory = limits
        ? hasVariations
          ? limits.max_pictures_per_item_var ?? limits.max_pictures_per_item
          : limits.max_pictures_per_item
        : null;
      if (fromCategory != null) {
        return {
          maxPictures: fromCategory,
          source: hasVariations ? "category.max_pictures_per_item_var" : "category.max_pictures_per_item",
          hasVariations,
        };
      }
      // path fetch is optional diagnostic only
      void fetchMercadoLivreCategoryPath(accessToken, categoryId);
    }

    return {
      maxPictures: MLB_PICTURE_LIMIT_FALLBACK,
      source: "fallback.mlb_default_10",
      hasVariations,
    };
  },

  async uploadOrResolveImages(accessToken, assets) {
    /** @type {import("./MarketplaceImageSyncStrategy.js").MarketplacePicture[]} */
    const out = [];
    for (const asset of assets) {
      const cached = textoOuNull(asset.marketplacePictureId);
      if (cached) {
        out.push({ id: cached, secure_url: asset.url, url: asset.url });
        continue;
      }
      const uploaded = await postMercadoLivrePictureFromSource(accessToken, asset.url);
      out.push({
        id: uploaded.id,
        secure_url: uploaded.secure_url,
        url: uploaded.url,
      });
    }
    return out;
  },

  async replaceListingPictures(accessToken, context, pictures) {
    const externalId = textoOuNull(context.externalListingId);
    if (!externalId) {
      return {
        ok: false,
        status: "failed",
        errorCode: "missing_external_listing_id",
        errorMessage: "Anúncio sem ID externo do marketplace.",
      };
    }

    try {
      const payload = {
        pictures: pictures.map((p) => ({ id: p.id })),
      };
      const updated = await putMercadoLibreItemPartial(accessToken, externalId, payload);
      const count = Array.isArray(updated?.pictures) ? updated.pictures.length : pictures.length;
      return {
        ok: true,
        status: "synced",
        picturesCount: count,
        marketplacePictureIds: pictures.map((p) => p.id),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        error && typeof error === "object" && "status" in error ? Number(error.status) : null;
      let errorCode = "marketplace_update_failed";
      if (statusCode === 401 || statusCode === 403) errorCode = "invalid_token";
      if (message.toLowerCase().includes("not modifiable")) errorCode = "listing_not_editable";
      return {
        ok: false,
        status: "failed",
        errorCode,
        errorMessage: message,
      };
    }
  },

  async refreshListingPictures(accessToken, context) {
    const externalId = textoOuNull(context.externalListingId);
    if (!externalId || !accessToken) return { picturesCount: null };
    try {
      const url = `${ML_API}/items/${encodeURIComponent(externalId)}?attributes=pictures`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || typeof json !== "object") return { picturesCount: null };
      const pics = Array.isArray(json.pictures) ? json.pictures : [];
      return { picturesCount: pics.length };
    } catch {
      return { picturesCount: null };
    }
  },
};
