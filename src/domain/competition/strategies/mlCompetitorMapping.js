// ============================================================
// S7 — Concorrência: mapeamento de item Mercado Livre → candidato bruto
// Reutilizado pelas estratégias de catálogo e de busca (DRY).
// Apenas leitura/extração de campos públicos; sem persistência.
// ============================================================

import { buildMercadoLivreItemPermalink } from "../mlListingDisplay.js";

function firstValidUrl(...values) {
  for (const raw of values) {
    const url = raw != null ? String(raw).trim() : "";
    if (url) return url;
  }
  return null;
}

export function resolveMlCompetitorPrimaryImage(itemLike, catalogThumbnail = null) {
  return firstValidUrl(pickItemThumbnail(itemLike), catalogThumbnail);
}

/** Melhor thumbnail disponível no corpo do item ML (secure_thumbnail > thumbnail > pictures). */
export function pickItemThumbnail(item) {
  const urls = pickItemPictureUrls(item);
  return urls.length > 0 ? urls[0] : null;
}

/** URLs de imagens do anúncio ML (pictures[] + fallbacks de thumbnail). */
export function pickItemPictureUrls(item) {
  if (!item || typeof item !== "object") return [];
  const urls = [];
  const seen = new Set();
  const push = (raw) => {
    const url = raw != null ? String(raw).trim() : "";
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };
  const pics = Array.isArray(item.pictures) ? item.pictures : [];
  for (const p of pics) {
    if (p && typeof p === "object") {
      push(p.secure_url || p.url);
    } else if (typeof p === "string") {
      push(p);
    }
  }
  push(item.secure_thumbnail);
  push(item.thumbnail);
  return urls;
}

/** seller_id do item, seja no root (item) ou aninhado (resultado de busca tem `seller.id`). */
function pickSellerId(item) {
  if (item?.seller_id != null && String(item.seller_id).trim() !== "") return String(item.seller_id).trim();
  if (item?.seller && typeof item.seller === "object" && item.seller.id != null) {
    return String(item.seller.id).trim();
  }
  return null;
}

/** Nome de loja/nickname (parcial/público): vem em `seller.nickname` na busca pública. */
function pickStoreName(item) {
  const seller = item?.seller && typeof item.seller === "object" ? item.seller : null;
  if (seller?.nickname != null && String(seller.nickname).trim() !== "") return String(seller.nickname).trim();
  if (item?.nickname != null && String(item.nickname).trim() !== "") return String(item.nickname).trim();
  return null;
}

/** Extrai vendas históricas oficiais do vendedor (transactions.completed ou total). */
export function pickSellerTransactionsCompleted(sellerReputation) {
  const rep = sellerReputation && typeof sellerReputation === "object" ? sellerReputation : null;
  const tx = rep?.transactions && typeof rep.transactions === "object" ? rep.transactions : null;
  if (!tx) return null;
  const completed = Number(tx.completed);
  if (Number.isFinite(completed) && completed > 0) return Math.trunc(completed);
  const total = Number(tx.total);
  if (Number.isFinite(total) && total > 0) return Math.trunc(total);
  return null;
}

/** Reputação pública (quando exposta) — `seller.seller_reputation` na busca pública. */
function pickReputation(item) {
  const seller = item?.seller && typeof item.seller === "object" ? item.seller : null;
  const rep = seller?.seller_reputation && typeof seller.seller_reputation === "object" ? seller.seller_reputation : null;
  if (!rep) return null;
  return {
    level_id: rep.level_id ?? null,
    power_seller_status: rep.power_seller_status ?? null,
    transactions_completed: pickSellerTransactionsCompleted(rep),
  };
}

/** Thumbnail do produto de catálogo (search/detail). */
export function pickCatalogProductThumbnail(product) {
  if (!product || typeof product !== "object") return null;
  const pics = Array.isArray(product.pictures) ? product.pictures : [];
  for (const p of pics) {
    if (p && typeof p === "object") {
      if (p.secure_url) return String(p.secure_url);
      if (p.url) return String(p.url);
    }
  }
  return null;
}

/**
 * Linha de GET /products/{id}/items — já traz item_id, preço e seller sem precisar de /items?ids=.
 * @param {Record<string, unknown> | null | undefined} row
 * @param {{ name?: string | null; thumbnail?: string | null }} [productMeta]
 */
export function mlCatalogItemRowToCandidateRaw(row, productMeta = {}) {
  if (!row || typeof row !== "object") return null;
  const listingId =
    row.item_id != null && String(row.item_id).trim() !== ""
      ? String(row.item_id).trim()
      : row.id != null && String(row.id).trim() !== ""
        ? String(row.id).trim()
        : null;
  if (!listingId) return null;
  return {
    competitor_listing_id: listingId,
    competitor_title:
      row.title != null && String(row.title).trim() !== ""
        ? String(row.title)
        : productMeta.name != null
          ? String(productMeta.name)
          : null,
    competitor_store_name:
      row.seller_nickname != null && String(row.seller_nickname).trim() !== ""
        ? String(row.seller_nickname).trim()
        : row.nickname != null && String(row.nickname).trim() !== ""
          ? String(row.nickname).trim()
          : null,
    competitor_seller_id: row.seller_id != null ? String(row.seller_id) : null,
    competitor_price: row.price != null ? row.price : null,
    currency: row.currency_id != null ? String(row.currency_id) : "BRL",
    competitor_permalink:
      row.permalink != null ? String(row.permalink) : buildMercadoLivreItemPermalink(listingId),
    competitor_thumbnail: resolveMlCompetitorPrimaryImage(row, productMeta.thumbnail ?? null),
    shipping: row.shipping && typeof row.shipping === "object" ? row.shipping : null,
    listing_type: row.listing_type_id != null ? String(row.listing_type_id) : null,
    category_id: row.category_id != null ? String(row.category_id).trim() : null,
    listing_updated_at: row.last_updated != null ? String(row.last_updated) : null,
    reputation: null,
    sales_hint: Number.isFinite(Number(row.sold_quantity)) ? Math.trunc(Number(row.sold_quantity)) : null,
  };
}

/**
 * buy_box_winner do GET /products/{id} — fallback quando /items vier vazio ou 404.
 * @param {Record<string, unknown> | null | undefined} detail
 * @param {{ name?: string | null; thumbnail?: string | null }} [productMeta]
 */
export function mlBuyBoxWinnerToCandidateRaw(detail, productMeta = {}) {
  const bb = detail?.buy_box_winner;
  if (!bb || typeof bb !== "object") return null;
  const listingId =
    bb.item_id != null && String(bb.item_id).trim() !== ""
      ? String(bb.item_id).trim()
      : bb.id != null && String(bb.id).trim() !== ""
        ? String(bb.id).trim()
        : null;
  if (!listingId) return null;
  const thumb = productMeta.thumbnail ?? pickCatalogProductThumbnail(detail);
  return {
    competitor_listing_id: listingId,
    competitor_title: detail?.name != null ? String(detail.name) : productMeta.name ?? null,
    competitor_store_name: bb.seller_nickname != null ? String(bb.seller_nickname) : null,
    competitor_seller_id: bb.seller_id != null ? String(bb.seller_id) : null,
    competitor_price: bb.price != null ? bb.price : null,
    currency: bb.currency_id != null ? String(bb.currency_id) : "BRL",
    competitor_permalink:
      bb.permalink != null
        ? String(bb.permalink)
        : detail?.permalink != null
          ? String(detail.permalink)
          : buildMercadoLivreItemPermalink(listingId),
    competitor_thumbnail: thumb,
    shipping: bb.shipping && typeof bb.shipping === "object" ? bb.shipping : null,
    listing_type: bb.listing_type_id != null ? String(bb.listing_type_id) : null,
    reputation: null,
    sales_hint: null,
  };
}

/** IDs de produtos de catálogo alternativos (pickers + children) para tentar /items. */
export function collectRelatedCatalogProductIds(searchProduct, detail) {
  const ids = new Set();
  const root = searchProduct?.id != null ? String(searchProduct.id).trim() : "";
  if (root) ids.add(root);

  const children = Array.isArray(searchProduct?.children_ids) ? searchProduct.children_ids : [];
  for (const c of children) {
    if (c != null && String(c).trim()) ids.add(String(c).trim());
  }
  const detailChildren = Array.isArray(detail?.children_ids) ? detail.children_ids : [];
  for (const c of detailChildren) {
    if (c != null && String(c).trim()) ids.add(String(c).trim());
  }

  const pickers = Array.isArray(detail?.pickers) ? detail.pickers : [];
  for (const picker of pickers) {
    const products = Array.isArray(picker?.products) ? picker.products : [];
    for (const p of products) {
      const pid = p?.product_id != null ? String(p.product_id).trim() : "";
      if (pid) ids.add(pid);
    }
  }
  return [...ids];
}

/**
 * Normaliza um corpo de item ML (de /items, /items?ids= ou /sites/MLB/search) para o
 * candidato bruto consumido por normalizeDiscoveredCompetitor.
 * @param {Record<string, unknown> | null | undefined} item
 * @returns {Record<string, unknown> | null}
 */
export function mlItemBodyToCandidateRaw(item) {
  if (!item || typeof item !== "object") return null;
  const listingId =
    item.id != null && String(item.id).trim() !== ""
      ? String(item.id).trim()
      : item.item_id != null && String(item.item_id).trim() !== ""
        ? String(item.item_id).trim()
        : null;
  if (!listingId) return null;
  return {
    competitor_listing_id: listingId,
    competitor_title: item.title != null ? String(item.title) : null,
    competitor_store_name: pickStoreName(item),
    competitor_seller_id: pickSellerId(item),
    competitor_price: item.price != null ? item.price : null,
    currency: item.currency_id != null ? String(item.currency_id) : null,
    competitor_permalink:
      item.permalink != null ? String(item.permalink) : buildMercadoLivreItemPermalink(listingId),
    competitor_thumbnail: resolveMlCompetitorPrimaryImage(item),
    competitor_pictures: pickItemPictureUrls(item),
    shipping: item.shipping && typeof item.shipping === "object" ? item.shipping : null,
    listing_type: item.listing_type_id != null ? String(item.listing_type_id) : null,
    category_id: item.category_id != null ? String(item.category_id).trim() : null,
    listing_updated_at: item.last_updated != null ? String(item.last_updated) : null,
    status: item.status != null ? String(item.status).trim().toLowerCase() : null,
    reputation: pickReputation(item),
    sales_hint: Number.isFinite(Number(item.sold_quantity)) ? Math.trunc(Number(item.sold_quantity)) : null,
  };
}

/**
 * Extrai marca e GTIN/EAN dos atributos do raw_json do anúncio do seller.
 * Usado para montar a query de busca (nunca o SKU do seller como chave).
 * @param {unknown} rawJson
 * @returns {{ brand: string | null; gtin: string | null }}
 */
export function extractBrandGtinFromRawJson(rawJson) {
  const attrs =
    rawJson && typeof rawJson === "object" && Array.isArray(rawJson.attributes) ? rawJson.attributes : [];
  let brand = null;
  let gtin = null;
  for (const a of attrs) {
    if (!a || typeof a !== "object") continue;
    const id = a.id != null ? String(a.id).toUpperCase() : "";
    const value = a.value_name != null && String(a.value_name).trim() !== "" ? String(a.value_name).trim() : null;
    if (!value) continue;
    if (id === "BRAND" && !brand) brand = value;
    if ((id === "GTIN" || id === "EAN") && !gtin) gtin = value;
  }
  return { brand, gtin };
}

/**
 * Decide se um candidato é o próprio anúncio/seller (para remover da lista).
 * @param {{ ownListingId?: string | null; ownSellerId?: string | null }} ctx
 * @param {{ competitor_listing_id?: string | null; competitor_seller_id?: string | null }} candidate
 */
export function isOwnCandidate(ctx, candidate) {
  const ownListing = ctx?.ownListingId != null ? String(ctx.ownListingId).trim() : "";
  const ownSeller = ctx?.ownSellerId != null ? String(ctx.ownSellerId).trim() : "";
  const candListing = candidate?.competitor_listing_id != null ? String(candidate.competitor_listing_id).trim() : "";
  const candSeller = candidate?.competitor_seller_id != null ? String(candidate.competitor_seller_id).trim() : "";
  if (ownListing && candListing && ownListing === candListing) return true;
  if (ownSeller && candSeller && ownSeller === candSeller) return true;
  return false;
}
