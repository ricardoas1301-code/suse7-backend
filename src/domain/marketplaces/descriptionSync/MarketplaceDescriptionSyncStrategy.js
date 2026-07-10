// ======================================================================
// Strategy Pattern — sincronização de descrição produto → marketplace
// Preparado para Mercado Livre, Shopee, Amazon, Shein (futuro).
// ======================================================================

/** Limite oficial de caracteres da descrição no Mercado Livre (plain_text). */
export const MLB_DESCRIPTION_MAX_LENGTH = 50000;

/**
 * @typedef {Object} DescriptionEligibilityResult
 * @property {boolean} canUpdateDescription
 * @property {string} [reason]
 */

/**
 * @typedef {Object} DescriptionSyncListingContext
 * @property {string} listingId
 * @property {string} externalListingId
 * @property {string | null} marketplaceAccountId
 * @property {string} marketplace
 * @property {Record<string, unknown>} rawJson
 * @property {string | null} [currentDescription]
 * @property {number} [salesCountLocal]
 */

/**
 * @typedef {Object} DescriptionValidationResult
 * @property {boolean} valid
 * @property {string} [reason]
 */

/**
 * @typedef {Object} DescriptionSyncResult
 * @property {boolean} ok
 * @property {string} status
 * @property {string} [errorMessage]
 * @property {Record<string, unknown>} [rawDescription]
 */

/**
 * @typedef {Object} MarketplaceDescriptionSyncStrategy
 * @property {string} marketplaceSlug
 * @property {number} [descriptionMaxLength]
 * @property {(context: DescriptionSyncListingContext) => DescriptionEligibilityResult} canUpdateDescription
 * @property {(description: string) => DescriptionValidationResult} validateDescription
 * @property {(accessToken: string, context: DescriptionSyncListingContext, description: string) => Promise<DescriptionSyncResult>} updateListingDescription
 */
