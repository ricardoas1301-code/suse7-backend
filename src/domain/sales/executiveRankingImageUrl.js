// ======================================================================
// Thumbnail para rankings executivos (sync — listing, produto, snapshot).
// marketplace_listings: imagens em raw_json (sem coluna thumbnail em vários ambientes).
// ======================================================================

import { thumbFromListingRecord } from "../../handlers/sales/_vendasSalesRows.js";

const MARKETPLACE_LISTINGS_SELECT_VARIANTS = [
  "id,external_listing_id,raw_json",
  "id,external_listing_id,pictures,raw_json",
  "id,external_listing_id,thumbnail,pictures,raw_json",
];

/** @param {unknown} error */
function isPostgrestMissingColumnError(error) {
  const msg = String(/** @type {{ message?: string }} */ (error)?.message ?? "").toLowerCase();
  return (
    String(/** @type {{ code?: string }} */ (error)?.code ?? "") === "42703" ||
    msg.includes("column") ||
    msg.includes("schema cache")
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {"external_listing_id" | "id"} matchColumn
 * @param {string[]} ids
 */
async function fetchMarketplaceListingRowsForEnrich(supabase, userId, matchColumn, ids) {
  if (!ids.length) return [];

  /** @type {unknown} */
  let lastError = null;

  for (const select of MARKETPLACE_LISTINGS_SELECT_VARIANTS) {
    const { data, error } = await supabase
      .from("marketplace_listings")
      .select(select)
      .eq("user_id", userId)
      .in(matchColumn, ids);

    if (!error) return data || [];

    lastError = error;
    if (!isPostgrestMissingColumnError(error)) {
      console.warn("[S7_EXEC_SUMMARY_THUMB_ENRICH]", {
        phase: matchColumn,
        message: /** @type {{ message?: string }} */ (error).message,
        select,
      });
      return [];
    }
  }

  console.warn("[S7_EXEC_SUMMARY_THUMB_ENRICH]", {
    phase: matchColumn,
    message: lastError != null ? String(/** @type {{ message?: string }} */ (lastError).message) : "select_failed",
  });
  return [];
}

/** @param {unknown} value */
function pickHttpUrl(value) {
  if (value == null) return "";
  const s = String(value).trim();
  if (!s) return "";
  if (s.startsWith("//")) return `https:${s}`;
  if (/^http:\/\//i.test(s) && /mercadolivre|mercadolibre|mlstatic|mlcdn/i.test(s)) {
    return `https://${s.slice(7)}`;
  }
  return s.startsWith("http") ? s : "";
}

/** @param {unknown} pics */
function firstPictureUrl(pics) {
  let arr = pics;
  if (typeof pics === "string" && pics.trim()) {
    try {
      arr = JSON.parse(pics);
    } catch {
      if (pics.trim().startsWith("http")) return pickHttpUrl(pics.trim());
      return "";
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return "";
  const p0 = arr[0];
  if (typeof p0 === "string") return pickHttpUrl(p0);
  if (p0 && typeof p0 === "object") {
    const o = /** @type {Record<string, unknown>} */ (p0);
    return pickHttpUrl(o.secure_url ?? o.url ?? o.source ?? null);
  }
  return "";
}

/** @param {unknown} images */
function firstProductImageUrl(images) {
  let arr = images;
  if (typeof images === "string" && images.trim()) {
    const s = images.trim();
    if (s.startsWith("http")) return pickHttpUrl(s);
    try {
      arr = JSON.parse(s);
    } catch {
      return "";
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return "";
  const p0 = arr[0];
  if (typeof p0 === "string") return pickHttpUrl(p0);
  if (p0 && typeof p0 === "object") {
    const o = /** @type {Record<string, unknown>} */ (p0);
    return pickHttpUrl(o.url ?? o.secure_url ?? o.public_url ?? o.src ?? null);
  }
  return "";
}

/**
 * @param {Record<string, unknown> | null | undefined} listing
 */
function resolveFromListing(listing) {
  return thumbFromListingRecord(listing) || "";
}

/**
 * @param {Record<string, unknown> | null | undefined} product
 */
function resolveFromProduct(product) {
  if (!product || typeof product !== "object") return "";
  const fromImages = firstProductImageUrl(product.product_images);
  if (fromImages) return fromImages;
  const links = product.product_image_links;
  if (Array.isArray(links) && links.length > 0) {
    for (const link of links) {
      if (typeof link === "string") {
        const u = pickHttpUrl(link);
        if (u) return u;
      }
      if (link && typeof link === "object") {
        const o = /** @type {Record<string, unknown>} */ (link);
        const u = pickHttpUrl(o.url ?? o.public_url ?? o.secure_url ?? null);
        if (u) return u;
      }
    }
  }
  return "";
}

/**
 * @param {{
 *   item?: Record<string, unknown> | null;
 *   row?: Record<string, unknown> | null;
 *   listing?: Record<string, unknown> | null;
 *   product?: Record<string, unknown> | null;
 * }} sources
 * @returns {string | null}
 */
export function resolveExecutiveRankingImageUrl({ item, row, listing, product }) {
  const rowCandidates = [
    row?.product_thumbnail_url,
    row?.listing_thumbnail_url,
    row?.marketplace_thumbnail_url,
    row?.product_image_url,
    row?.thumbnail_url,
    row?.image_url,
  ];
  for (const c of rowCandidates) {
    const u = pickHttpUrl(c);
    if (u) return u;
  }

  const listingUrl = resolveFromListing(listing ?? null);
  if (listingUrl) return listingUrl;

  const productUrl = resolveFromProduct(product ?? null);
  if (productUrl) return productUrl;

  const snapshot = pickHttpUrl(item?.thumbnail_snapshot);
  if (snapshot) return snapshot;

  return null;
}

/**
 * Melhor URL já hidratada na linha de venda (mesma prioridade da listagem /vendas).
 * @param {Record<string, unknown> | null | undefined} item
 * @param {Record<string, unknown> | null | undefined} row
 * @param {Record<string, unknown> | null | undefined} [listing]
 * @param {Record<string, unknown> | null | undefined} [product]
 * @returns {string | null}
 */
export function pickHydratedRowImageUrl(item, row, listing = null, product = null) {
  const fromExec = resolveExecutiveRankingImageUrl({ item, row, listing, product });
  if (fromExec) return fromExec;

  const rowCandidates = [
    row?.listing_thumbnail_url,
    row?.product_thumbnail_url,
    row?.product_image_url,
    row?.thumbnail_url,
  ];
  for (const c of rowCandidates) {
    const u = pickHttpUrl(c);
    if (u) return u;
  }

  const listingUrl = resolveFromListing(listing ?? null);
  if (listingUrl) return listingUrl;

  return null;
}

/**
 * Preenche image_url em linhas de ranking que ainda não têm thumb.
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>[]} rows
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function enrichExecutiveListingRankingRows(supabase, userId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  /** @param {string} id */
  function isLikelyExternalListingId(id) {
    const s = String(id).trim();
    if (!s) return false;
    if (/^(title:|line:|sku:|pid:)/i.test(s)) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) return true;
    if (/^[A-Z]{2,6}\d{5,}$/i.test(s)) return true;
    return s.length >= 8 && !/\s/.test(s);
  }

  function isUuidLike(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(id).trim(),
    );
  }

  /** @type {Set<string>} */
  const externalKeys = new Set();
  /** @type {Set<string>} */
  const uuidKeys = new Set();

  for (const row of rows) {
    if (pickHttpUrl(row?.image_url)) continue;
    const ext =
      row?.external_listing_id != null ? String(row.external_listing_id).trim() : "";
    const lid = row?.listing_id != null ? String(row.listing_id).trim() : "";
    if (ext) externalKeys.add(ext);
    if (lid && isLikelyExternalListingId(lid)) externalKeys.add(lid);
    if (lid && isUuidLike(lid)) uuidKeys.add(lid);
    if (ext && isUuidLike(ext)) uuidKeys.add(ext);
  }

  if (externalKeys.size === 0 && uuidKeys.size === 0) return rows;

  /** @type {Map<string, string>} */
  const thumbByKey = new Map();

  const ingest = (catalogRow) => {
    const url = thumbFromListingRecord(catalogRow) || "";
    if (!url) return;
    const ext =
      catalogRow?.external_listing_id != null ? String(catalogRow.external_listing_id).trim() : "";
    const id = catalogRow?.id != null ? String(catalogRow.id).trim() : "";
    if (ext) thumbByKey.set(ext, url);
    if (id) thumbByKey.set(id, url);
  };

  const chunkSize = 150;
  const externalList = [...externalKeys];
  for (let i = 0; i < externalList.length; i += chunkSize) {
    const chunk = externalList.slice(i, i + chunkSize);
    const data = await fetchMarketplaceListingRowsForEnrich(
      supabase,
      userId,
      "external_listing_id",
      chunk,
    );
    for (const row of data) ingest(row);
  }

  const uuidList = [...uuidKeys].filter((id) => !thumbByKey.has(id));
  for (let i = 0; i < uuidList.length; i += chunkSize) {
    const chunk = uuidList.slice(i, i + chunkSize);
    const data = await fetchMarketplaceListingRowsForEnrich(supabase, userId, "id", chunk);
    for (const row of data) ingest(row);
  }

  return rows.map((row) => {
    const existing = pickHttpUrl(row?.image_url);
    if (existing) return row;

    const ext = row?.external_listing_id != null ? String(row.external_listing_id).trim() : "";
    const lid = row?.listing_id != null ? String(row.listing_id).trim() : "";
    const thumb = (ext && thumbByKey.get(ext)) || (lid && thumbByKey.get(lid)) || "";
    if (!thumb) return row;
    return {
      ...row,
      image_url: thumb,
      listing_thumbnail_url: thumb,
      product_thumbnail_url: thumb,
    };
  });
}
