// ======================================================================
// Chave estável de anúncio para ranking executivo (P_2.1.4 hotfix 02).
// ======================================================================

import { normalizeSkuForDbLookup } from "../productCatalogCompleteness.js";

/**
 * @param {unknown} raw
 * @returns {string}
 */
function pickTrimmedString(raw) {
  if (raw == null) return "";
  const s = String(raw).trim();
  return s !== "" ? s : "";
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
function asObject(raw) {
  return raw != null && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 * @returns {Record<string, unknown> | null}
 */
function itemRawJson(item) {
  return asObject(item?.raw_json);
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 * @returns {Record<string, unknown> | null}
 */
function itemNestedLine(item) {
  const raw = itemRawJson(item);
  const itemObj =
    raw?.item != null && typeof raw.item === "object" ? /** @type {Record<string, unknown>} */ (raw.item) : null;
  return itemObj;
}

/**
 * @param {string} title
 * @returns {string}
 */
function normalizeTitleKey(title) {
  const s = title.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return "";
  return s.slice(0, 80);
}

/**
 * Ordem oficial P_2.1.4 hotfix 02:
 * external_listing_id → listing_id → item_id → marketplace_listing_id → mlb → sku → product_id → title
 *
 * @param {{
 *   item: Record<string, unknown>;
 *   row?: Record<string, unknown> | null;
 *   productId?: string | null;
 * }} input
 * @returns {{ listing_id: string; source: string }}
 */
export function resolveExecutiveRankingListingId({ item, row = null, productId = null }) {
  const raw = itemRawJson(item);
  const nested = itemNestedLine(item);

  const candidates = [
    { source: "external_listing_id", value: pickTrimmedString(item.external_listing_id) },
    { source: "listing_id_display", value: pickTrimmedString(row?.listing_id_display) },
    { source: "listing_id", value: pickTrimmedString(row?.listing_id ?? raw?.listing_id ?? nested?.id) },
    {
      source: "item_id",
      value: pickTrimmedString(raw?.item_id ?? nested?.id ?? item.external_order_item_id ?? item.id),
    },
    {
      source: "marketplace_listing_id",
      value: pickTrimmedString(raw?.marketplace_listing_id ?? nested?.marketplace_listing_id),
    },
    { source: "mlb", value: pickTrimmedString(raw?.mlb ?? nested?.mlb) },
    {
      source: "sku",
      value: (() => {
        const skuRaw =
          pickTrimmedString(row?.sku_display) ||
          pickTrimmedString(item.sku_snapshot) ||
          pickTrimmedString(raw?.seller_sku ?? nested?.seller_sku);
        const norm = skuRaw ? normalizeSkuForDbLookup(skuRaw) : "";
        return norm || skuRaw;
      })(),
    },
    {
      source: "product_id",
      value: pickTrimmedString(productId ?? row?.product_id ?? item.product_id),
    },
    {
      source: "title",
      value: (() => {
        const title =
          pickTrimmedString(row?.product_display_title) ||
          pickTrimmedString(item.title_snapshot) ||
          pickTrimmedString(raw?.title ?? nested?.title);
        const norm = normalizeTitleKey(title);
        return norm ? `title:${norm}` : "";
      })(),
    },
  ];

  for (const c of candidates) {
    if (c.value) {
      return { listing_id: c.value, source: c.source };
    }
  }

  const lineId = pickTrimmedString(item.id);
  if (lineId) {
    return { listing_id: `line:${lineId}`, source: "sales_order_item_id" };
  }

  return { listing_id: "", source: "none" };
}
