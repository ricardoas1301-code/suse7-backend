// ======================================================================
// Parser do POST /api/listings/bulk-set-sku
// SKU é identificador textual — nunca Number(), nunca remove zero à esquerda.
// ======================================================================

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function preservarSkuLiteral(raw) {
  if (raw == null) return "";
  return String(raw).trim();
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function tokenAnuncio(raw) {
  return raw != null ? String(raw).trim() : "";
}

/**
 * @param {unknown} body
 * @returns {{
 *   mode: "items" | "legacy";
 *   groups: { skuRaw: string; listingTokens: string[] }[];
 *   allListingTokens: string[];
 * }}
 */
export function parseBulkSetSkuPayload(body) {
  const raw = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
  const items = Array.isArray(raw.items) ? raw.items : null;

  if (items && items.length > 0) {
    /** @type {Map<string, { skuRaw: string; listingTokens: string[] }>} */
    const groups = new Map();
    /** @type {string[]} */
    const allListingTokens = [];
    const seenToken = new Set();

    for (const itemRaw of items) {
      const item = itemRaw && typeof itemRaw === "object" ? /** @type {Record<string, unknown>} */ (itemRaw) : {};
      const skuRaw = preservarSkuLiteral(item.sku ?? item.product_sku ?? item.productSku);
      const listingId = tokenAnuncio(item.listing_id ?? item.listingId);
      if (!listingId) continue;
      if (!seenToken.has(listingId)) {
        seenToken.add(listingId);
        allListingTokens.push(listingId);
      }
      const key = skuRaw;
      let group = groups.get(key);
      if (!group) {
        group = { skuRaw, listingTokens: [] };
        groups.set(key, group);
      }
      if (!group.listingTokens.includes(listingId)) {
        group.listingTokens.push(listingId);
      }
    }

    return { mode: "items", groups: [...groups.values()], allListingTokens };
  }

  const skuRaw = preservarSkuLiteral(raw.sku);
  const listingIdsIn = Array.isArray(raw.listing_ids) ? raw.listing_ids : [];
  const listingTokens = [
    ...new Set(listingIdsIn.map((x) => tokenAnuncio(x)).filter(Boolean)),
  ];
  return {
    mode: "legacy",
    groups: listingTokens.length > 0 ? [{ skuRaw, listingTokens }] : [],
    allListingTokens: listingTokens,
  };
}
