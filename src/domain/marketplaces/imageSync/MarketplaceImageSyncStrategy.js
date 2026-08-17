// ======================================================================
// Strategy Pattern — sincronização de imagens produto → marketplace
// Preparado para Mercado Livre, Shopee, Amazon, Shein (futuro).
// ======================================================================

/** @typedef {{ maxPictures: number; source: string; hasVariations?: boolean }} ImageLimitResult */

/** @typedef {{ id: string; url: string; sortOrder: number; marketplacePictureId?: string | null }} ProductImageSyncAsset */

/** @typedef {{ id: string; secure_url?: string | null; url?: string | null }} MarketplacePicture */

/**
 * @typedef {Object} ImageSyncListingContext
 * @property {string} listingId
 * @property {string} externalListingId
 * @property {string | null} marketplaceAccountId
 * @property {string} marketplace
 * @property {Record<string, unknown>} rawJson
 * @property {boolean} hasVariations
 */

/**
 * @typedef {Object} ImageSyncResult
 * @property {boolean} ok
 * @property {string} status
 * @property {number} [picturesCount]
 * @property {string} [errorCode]
 * @property {string} [errorMessage]
 * @property {string[]} [marketplacePictureIds]
 */

/**
 * @typedef {Object} MarketplaceImageSyncStrategy
 * @property {string} marketplaceSlug
 * @property {(context: ImageSyncListingContext, accessToken: string | null) => Promise<ImageLimitResult>} getImageLimitForListing
 * @property {(accessToken: string, assets: ProductImageSyncAsset[]) => Promise<MarketplacePicture[]>} uploadOrResolveImages
 * @property {(accessToken: string, context: ImageSyncListingContext, pictures: MarketplacePicture[]) => Promise<ImageSyncResult>} replaceListingPictures
 * @property {(accessToken: string, context: ImageSyncListingContext) => Promise<{ picturesCount: number | null }>} refreshListingPictures
 */

/** Limite fallback documentado para MLB quando categoria não retorna settings. */
export const MLB_PICTURE_LIMIT_FALLBACK = 10;

/** Banco central de imagens do produto no SUS7 (aba Imagens). */
export const PRODUCT_IMAGE_BANK_MAX = 14;
