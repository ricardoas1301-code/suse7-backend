// ======================================================================
// Atributos comerciais por anúncio — Central de Saúde da Precificação.
// SSOT cache: marketplace_listings.raw_json + marketplace_listing_health.
// Promoções: normalizeOfficialSellerPromotionsFromApi (persistido) + resolvePromotionState.
// ======================================================================

import { normalizeMercadoLivreListingType } from "../../../handlers/ml/_helpers/marketplaces/mercadoLivreListingGrid.js";
import { resolvePromotionState } from "../../../handlers/ml/_helpers/mercadoLivrePromotionResolve.js";
import { normalizeOfficialSellerPromotionsFromApi } from "../mercadoLivreOfficialSellerPromotions.js";

/**
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 */
function extrairLinhasPromocaoPersistidas(listing, health) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  const rawListing =
    listing.raw_json != null && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : null;

  const itemPromotions = rawListing?._suse7_item_promotions;
  if (Array.isArray(itemPromotions)) {
    for (const row of itemPromotions) {
      if (row && typeof row === "object") rows.push(/** @type {Record<string, unknown>} */ (row));
    }
  }

  const healthRaw =
    health?.raw_json != null && typeof health.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (health.raw_json)
      : null;
  const payloads =
    healthRaw?.raw_payloads != null &&
    typeof healthRaw.raw_payloads === "object" &&
    !Array.isArray(healthRaw.raw_payloads)
      ? /** @type {Record<string, unknown>} */ (healthRaw.raw_payloads)
      : null;
  const sellerPromotionFromSalePrice = payloads?.seller_promotion_from_sale_price;
  if (
    sellerPromotionFromSalePrice != null &&
    typeof sellerPromotionFromSalePrice === "object" &&
    !Array.isArray(sellerPromotionFromSalePrice)
  ) {
    rows.push(/** @type {Record<string, unknown>} */ (sellerPromotionFromSalePrice));
  }

  return rows;
}

/**
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 */
function listarPromocoesNormalizadasPersistidas(listing, health) {
  const rawRows = extrairLinhasPromocaoPersistidas(listing, health);
  if (rawRows.length === 0) return [];
  return normalizeOfficialSellerPromotionsFromApi(rawRows, { source: "persisted" }).promotions;
}

/**
 * @param {Record<string, unknown>} listing
 * @returns {"classic" | "premium" | "unknown"}
 */
export function resolverChaveTipoAnuncio(listing) {
  const tipo = normalizeMercadoLivreListingType(
    listing.listing_type_id != null ? String(listing.listing_type_id) : null,
  );
  if (tipo.label === "Clássico") return "classic";
  if (tipo.label === "Premium") return "premium";
  return "unknown";
}

/**
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 */
export function anuncioTemFreteGratis(listing, health) {
  const rawListing =
    listing.raw_json != null && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : null;
  const shippingListing =
    rawListing?.shipping != null && typeof rawListing.shipping === "object"
      ? /** @type {Record<string, unknown>} */ (rawListing.shipping)
      : null;
  if (shippingListing?.free_shipping === true) return true;

  const healthRaw =
    health?.raw_json != null && typeof health.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (health.raw_json)
      : null;
  const shippingHealth =
    healthRaw?.shipping != null && typeof healthRaw.shipping === "object"
      ? /** @type {Record<string, unknown>} */ (healthRaw.shipping)
      : null;
  return shippingHealth?.free_shipping === true;
}

/**
 * Bucket exclusivo — prioridade: ativa > programada > disponível > sem promoção.
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 * @returns {"active_promotion" | "scheduled_promotion" | "available_promotion" | "no_promotion"}
 */
export function resolverChavePromocaoAnuncio(listing, health) {
  const promotions = listarPromocoesNormalizadasPersistidas(listing, health);

  if (
    promotions.some(
      (promo) =>
        promo.promotion_active === true ||
        promo.ml_effective_state === "active" ||
        promo.status === "active",
    )
  ) {
    return "active_promotion";
  }

  const promoState = resolvePromotionState({ listing, health });
  if (promoState.promotion_active === true) return "active_promotion";

  if (
    promotions.some(
      (promo) =>
        promo.ml_effective_state === "scheduled" ||
        promo.raw_status === "pending" ||
        promo.status === "scheduled",
    )
  ) {
    return "scheduled_promotion";
  }

  if (
    promotions.some(
      (promo) =>
        promo.ml_effective_state === "participate" ||
        promo.status === "candidate" ||
        promo.raw_status === "candidate",
    )
  ) {
    return "available_promotion";
  }

  return "no_promotion";
}

/**
 * @param {Record<string, unknown>} snapshotBase
 * @param {{ listing: Record<string, unknown>; health: Record<string, unknown> | null | undefined }} input
 */
export function enriquecerSnapshotPrecificacaoAnuncio(snapshotBase, input) {
  const { listing, health } = input;
  const promotionBucketKey = resolverChavePromocaoAnuncio(listing, health);
  const listingTypeKey = resolverChaveTipoAnuncio(listing);

  return {
    ...snapshotBase,
    listing_type_key: listingTypeKey,
    free_shipping: anuncioTemFreteGratis(listing, health),
    promotion_bucket_key: promotionBucketKey,
    has_active_promotion: promotionBucketKey === "active_promotion",
  };
}
