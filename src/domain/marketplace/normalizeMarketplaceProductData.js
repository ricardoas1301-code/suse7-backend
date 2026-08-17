// ======================================================================
// Normalização multi-marketplace — produto Suse7 a partir de listing bruto.
// Strategy/Adapter: ML hoje; Shopee/Amazon/Shein no futuro.
// ======================================================================

import { ML_MARKETPLACE_SLUG, ML_MARKETPLACE_LISTING_ALIASES } from "../../handlers/ml/_helpers/mlMarketplace.js";
import { normalizeMercadoLivreProductData } from "./adapters/mercadoLivreProductDataAdapter.js";

/**
 * @param {string} marketplace
 * @returns {boolean}
 */
export function isSupportedMarketplaceProductImport(marketplace) {
  const m = String(marketplace || "").trim().toLowerCase();
  return m === ML_MARKETPLACE_SLUG || ML_MARKETPLACE_LISTING_ALIASES.includes(m);
}

/**
 * @param {string} marketplace
 * @param {Record<string, unknown>} rawListing
 * @param {Record<string, unknown> | null} [rawDescription]
 * @param {unknown} [rawAttributes] reservado — atributos já vêm em rawListing.attributes
 * @param {{ resolvedSku: string; externalListingId?: string }} context
 */
export function normalizeMarketplaceProductData(
  marketplace,
  rawListing,
  rawDescription = null,
  rawAttributes = null,
  context = /** @type {{ resolvedSku: string; externalListingId?: string }} */ ({ resolvedSku: "" })
) {
  void rawAttributes;
  const m = String(marketplace || ML_MARKETPLACE_SLUG).trim().toLowerCase();
  const sku = String(context?.resolvedSku || "").trim();
  const extId =
    context?.externalListingId != null
      ? String(context.externalListingId).trim()
      : rawListing?.id != null
        ? String(rawListing.id).trim()
        : "";

  if (isSupportedMarketplaceProductImport(m)) {
    return normalizeMercadoLivreProductData(rawListing, rawDescription, sku, extId);
  }

  throw new Error(`normalizeMarketplaceProductData: marketplace não suportado (${marketplace})`);
}
