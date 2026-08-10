// ======================================================================
// Identidade canônica de order_items Mercado Livre → sales_order_items.
// ======================================================================

/**
 * @param {unknown} raw
 */
function pickTrimmedString(raw) {
  if (raw == null) return "";
  const s = String(raw).trim();
  return s;
}

/**
 * @param {Record<string, unknown>} line
 */
export function extractMercadoLivreListingIdFromLine(line) {
  const itemObj = line?.item && typeof line.item === "object" ? /** @type {Record<string, unknown>} */ (line.item) : {};
  const bundleFirst =
    Array.isArray(line.bundle_items) && line.bundle_items[0] && typeof line.bundle_items[0] === "object"
      ? /** @type {Record<string, unknown>} */ (line.bundle_items[0]).item
      : null;
  const raw =
    itemObj.id ??
    line.item_id ??
    line.listing_id ??
    (bundleFirst && typeof bundleFirst === "object" ? bundleFirst.id : null);
  return pickTrimmedString(raw);
}

/**
 * @param {Record<string, unknown>} line
 */
function extractMercadoLivreVariationIdFromLine(line) {
  const itemObj = line?.item && typeof line.item === "object" ? /** @type {Record<string, unknown>} */ (line.item) : {};
  return pickTrimmedString(itemObj.variation_id ?? line.variation_id);
}

/**
 * @param {Record<string, unknown>} line
 */
function extractMercadoLivreSellerSkuFromLine(line) {
  const itemObj = line?.item && typeof line.item === "object" ? /** @type {Record<string, unknown>} */ (line.item) : {};
  return pickTrimmedString(
    itemObj.seller_custom_field ?? itemObj.seller_sku ?? line.seller_sku ?? line.seller_custom_field,
  );
}

/**
 * Chave estável para contagem de ocorrência (não usa valores financeiros).
 * @param {Record<string, unknown>} line
 */
export function buildMercadoLivreOrderItemOccurrenceKey(line) {
  const listingId = extractMercadoLivreListingIdFromLine(line) || "_";
  const variationId = extractMercadoLivreVariationIdFromLine(line) || "0";
  const sku = extractMercadoLivreSellerSkuFromLine(line) || "_";
  return `${listingId}|${variationId}|${sku}`;
}

/**
 * @param {Record<string, unknown>[] | undefined} linesInOrder
 * @param {number} lineIndex
 * @param {string} occurrenceKey
 */
function resolveOccurrenceIndex(linesInOrder, lineIndex, occurrenceKey) {
  const lines = Array.isArray(linesInOrder) ? linesInOrder : [];
  let occurrence = 0;
  for (let i = 0; i < lineIndex && i < lines.length; i += 1) {
    const other = lines[i];
    if (!other || typeof other !== "object") continue;
    if (buildMercadoLivreOrderItemOccurrenceKey(/** @type {Record<string, unknown>} */ (other)) === occurrenceKey) {
      occurrence += 1;
    }
  }
  return occurrence;
}

/**
 * @param {Record<string, unknown>} line
 * @param {{
 *   externalOrderId: string;
 *   lineIndex: number;
 *   linesInOrder: Record<string, unknown>[];
 * }} context
 * @returns {import("./marketplaceOrderItemIdentity.js").MarketplaceOrderItemIdentity}
 */
export function resolveMercadoLivreOrderItemIdentity(line, context) {
  const externalOrderId = pickTrimmedString(context?.externalOrderId);
  if (!externalOrderId) {
    throw new Error("resolveMercadoLivreOrderItemIdentity requer externalOrderId.");
  }

  const officialLineId = pickTrimmedString(line?.id ?? line?.order_item_id);
  const listingId = extractMercadoLivreListingIdFromLine(line);

  if (officialLineId) {
    return {
      external_order_item_id: officialLineId,
      identity_source: "official_line_id",
    };
  }

  const variationId = extractMercadoLivreVariationIdFromLine(line) || "0";
  const sku = extractMercadoLivreSellerSkuFromLine(line) || "_";
  const occurrenceKey = buildMercadoLivreOrderItemOccurrenceKey(line);
  const occurrence = resolveOccurrenceIndex(context.linesInOrder, context.lineIndex, occurrenceKey);

  const listingPart = listingId || "_";
  const syntheticId = `ml:${externalOrderId}:${listingPart}:${variationId}:${sku}:${occurrence}`;

  return {
    external_order_item_id: syntheticId,
    identity_source: "synthetic",
  };
}
