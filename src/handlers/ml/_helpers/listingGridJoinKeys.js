// ======================================================
// Chaves estáveis para casar marketplace_listings ↔
// listing_sales_metrics / marketplace_listing_health
// (slug de marketplace + variantes de external_listing_id).
// ======================================================

import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import { normalizeExternalListingId } from "./mlSalesPersist.js";

/**
 * @param {unknown} marketplace
 * @returns {string}
 */
export function normalizeMarketplaceSlug(marketplace) {
  let s = String(marketplace ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!s || s === "null" || s === "undefined") return ML_MARKETPLACE_SLUG;
  if (s === "mercadolivre") return ML_MARKETPLACE_SLUG;
  return s;
}

/**
 * @param {string} marketplace
 * @param {unknown} externalListingId
 */
export function listingGridJoinKey(marketplace, externalListingId) {
  const mkt = normalizeMarketplaceSlug(marketplace);
  return `${mkt}\t${normalizeExternalListingId(externalListingId)}`;
}

/**
 * Variações de ID para lookup tolerante a diferenças triviais entre tabelas.
 * @param {unknown} externalListingId
 * @returns {string[]}
 */
export function externalListingIdKeyVariants(externalListingId) {
  const raw = String(externalListingId ?? "").trim();
  const variants = new Set();
  if (!raw) return [];
  variants.add(normalizeExternalListingId(raw));
  variants.add(raw);
  if (/^mlb/i.test(raw)) {
    variants.add(raw.toUpperCase());
    variants.add(raw.toLowerCase());
    const digits = raw.replace(/^mlb/i, "").replace(/\D/g, "");
    if (digits) {
      variants.add(digits);
      variants.add(`MLB${digits}`);
      variants.add(`mlb${digits}`);
    }
  } else if (/^\d+$/.test(raw)) {
    variants.add(`MLB${raw}`);
    variants.add(`mlb${raw}`);
  }
  return [...variants].filter(Boolean);
}

/**
 * Regista a mesma linha de métricas/health sob várias chaves compatíveis.
 * @template T
 * @param {Map<string, T>} map
 * @param {unknown} marketplace
 * @param {T} row
 * @param {(r: T) => unknown} pickExternalId
 */
export function putListingGridRowAliases(map, marketplace, row, pickExternalId) {
  const ext = pickExternalId(row);
  /** Usar marketplace da linha relacionada quando a do argumento vier vazia. */
  const rowMkt =
    row && typeof row === "object" && "marketplace" in row
      ? /** @type {{ marketplace?: unknown }} */ (row).marketplace
      : null;
  const mkt = normalizeMarketplaceSlug(marketplace ?? rowMkt);
  for (const v of externalListingIdKeyVariants(ext)) {
    map.set(listingGridJoinKey(mkt, v), row);
  }
}

/**
 * @template T
 * @param {Map<string, T>} map
 * @param {unknown} marketplace
 * @param {unknown} externalListingId
 * @returns {T | undefined}
 */
export function getListingGridRow(map, marketplace, externalListingId) {
  const primary = normalizeMarketplaceSlug(marketplace);
  const mkTry = primary === ML_MARKETPLACE_SLUG ? [primary] : [primary, ML_MARKETPLACE_SLUG];
  for (const mkt of mkTry) {
    for (const v of externalListingIdKeyVariants(externalListingId)) {
      const hit = map.get(listingGridJoinKey(mkt, v));
      if (hit) return hit;
    }
  }
  return undefined;
}
