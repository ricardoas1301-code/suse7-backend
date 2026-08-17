// ======================================================================
// Strategy Pattern — sincronização de título produto → marketplace
// Preparado para Mercado Livre, Shopee, Amazon, Shein (futuro).
// ======================================================================

/** Limite oficial de caracteres do título no Mercado Livre (Brasil). */
export const MLB_TITLE_MAX_LENGTH = 60;

/**
 * @typedef {Object} TitleEligibilityResult
 * @property {boolean} canUpdateTitle
 * @property {string} [reason]
 * @property {number} [soldQuantity]
 * @property {string} [soldQuantitySource]
 */

/**
 * @typedef {Object} TitleSyncListingContext
 * @property {string} listingId
 * @property {string} externalListingId
 * @property {string | null} marketplaceAccountId
 * @property {string} marketplace
 * @property {Record<string, unknown>} rawJson
 * @property {string | null} [currentTitle]
 * @property {number} [salesCountLocal]
 */

/**
 * @typedef {Object} TitleValidationResult
 * @property {boolean} valid
 * @property {string} [reason]
 */

/**
 * @typedef {Object} TitleSyncResult
 * @property {boolean} ok
 * @property {string} status
 * @property {string} [errorMessage]
 * @property {Record<string, unknown>} [rawItem]
 */

/**
 * @typedef {Object} MarketplaceTitleSyncStrategy
 * @property {string} marketplaceSlug
 * @property {number} [titleMaxLength]
 * @property {(context: TitleSyncListingContext) => TitleEligibilityResult} canUpdateTitle
 * @property {(title: string) => TitleValidationResult} validateTitle
 * @property {(accessToken: string, context: TitleSyncListingContext, title: string) => Promise<TitleSyncResult>} updateListingTitle
 */
