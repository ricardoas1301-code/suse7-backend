// ======================================================================
// Montagem de linhas da UI /vendas a partir de sales_order_items + pedido
// + marketplace_listings + products (sem cálculo financeiro sensível no FE).
// ======================================================================

import { computeProductReadiness } from "../../domain/productReadiness.js";
import { hasRequiredProductCosts, normalizeSkuForDbLookup } from "../../domain/productCatalogCompleteness.js";
import { resolveSaleOperationalStatusLabel, attachFreshMercadoLivreShipmentSnapshot } from "../../domain/sales/saleDetailGeneral.js";
import { buildSaleDetailFinancialBreakdown } from "./saleDetailFinancial.js";
import { finalizeSaleDetailFinancialWithContingency } from "../../domain/sales/saleDetailContingencyMargin.js";
import { getValidMLToken } from "../ml/_helpers/mlToken.js";
import { extractMlLineThumbnail } from "../ml/_helpers/mlSalesPersist.js";

/** @param {unknown} v */
export function toNum(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} v */
export function toMoneyString(v) {
  const n = toNum(v);
  if (n == null) return null;
  return n.toFixed(2);
}

/**
 * @param {string[]} ids
 * @param {number} [chunkSize]
 */
export function chunkIds(ids, chunkSize = 120) {
  const uniq = [...new Set((ids || []).filter(Boolean).map((x) => String(x)))];
  const out = [];
  for (let i = 0; i < uniq.length; i += chunkSize) {
    out.push(uniq.slice(i, i + chunkSize));
  }
  return out;
}

/** @param {string} q */
export function escapeForPostgrestOrIlike(q) {
  return String(q ?? "")
    .trim()
    .replace(/\*/g, "")
    .replace(/,/g, " ");
}

/** Espaços colapsados — base da busca “palavra a palavra”. */
export function normalizeSearchQuery(q) {
  return String(q ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

/** Tokens (palavras) após normalizar; vazio se só espaços. */
export function splitSearchTokens(normalizedQ) {
  const s = normalizeSearchQuery(normalizedQ);
  if (!s) return [];
  return s.split(" ").filter(Boolean);
}

/**
 * Expressão para `.or(...)` em `sales_order_items` (PostgREST).
 * Uma palavra: qualquer coluna de texto/ID pode casar.
 * Várias palavras: cada palavra deve casar em alguma coluna da **mesma linha** (AND entre palavras).
 * Opcionalmente inclui `sales_order_id.in.(...)` (pedidos achados pela RPC de pedido).
 *
 * @param {string[]} tokens
 * @param {string[]} orderIds
 * @returns {string | null}
 */
export function buildVendasSalesItemQOrFilter(tokens, orderIds) {
  const cleaned = (tokens || []).map((t) => escapeForPostgrestOrIlike(String(t).trim())).filter(Boolean);
  if (cleaned.length === 0) return null;
  const oid = (orderIds || []).filter(Boolean).map(String).slice(0, 200);
  const inPart = oid.length > 0 ? `,sales_order_id.in.(${oid.join(",")})` : "";

  if (cleaned.length === 1) {
    const p = `*${cleaned[0]}*`;
    const fields = `title_snapshot.ilike.${p},sku_snapshot.ilike.${p},external_listing_id.ilike.${p},external_order_item_id.ilike.${p},external_order_id.ilike.${p}`;
    return `${fields}${inPart}`;
  }
  const tokenGroups = cleaned.map((tok) => {
    const p = `*${tok}*`;
    return `or(title_snapshot.ilike.${p},sku_snapshot.ilike.${p},external_listing_id.ilike.${p},external_order_item_id.ilike.${p},external_order_id.ilike.${p})`;
  }).join(",");
  return `and=(${tokenGroups})${inPart}`;
}

/**
 * IDs de `sales_orders` onde o texto casa com código ML, pack, conteúdo do
 * `raw_json` (rastreio, dados do comprador no payload) ou nome em
 * `marketplace_customers`. Usa RPC `s7_vendas_search_order_ids_v1`; se a
 * função não existir, faz fallback só em `external_order_id`.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} qTrim
 * @param {number} [limit]
 * @returns {Promise<string[]>}
 */
export async function fetchVendasSearchOrderIds(supabase, userId, qTrim, limit = 800) {
  const q = normalizeSearchQuery(String(qTrim ?? ""));
  if (!q) return [];
  const lim = Math.min(2000, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 800));

  const { data, error } = await supabase.rpc("s7_vendas_search_order_ids_v1", {
    p_user_id: userId,
    p_q: q,
    p_limit: lim,
  });
  if (!error && Array.isArray(data)) {
    return data.map((r) => (r && r.id != null ? String(r.id) : null)).filter(Boolean);
  }
  if (error) {
    console.warn("[S7][vendas] s7_vendas_search_order_ids_v1", {
      message: error?.message,
      code: error?.code,
      details: error?.details,
    });
  }

  const safe = escapeForPostgrestOrIlike(q);
  if (!safe) return [];
  const { data: rows, error: e2 } = await supabase
    .from("sales_orders")
    .select("id")
    .eq("user_id", userId)
    .ilike("external_order_id", `%${safe}%`)
    .order("date_created_marketplace", { ascending: false, nullsFirst: false })
    .limit(lim);
  if (e2) {
    console.warn("[S7][vendas] search_orders_fallback", { message: e2?.message });
    return [];
  }
  return (rows || []).map((r) => (r?.id != null ? String(r.id) : null)).filter(Boolean);
}

/**
 * Pedidos que têm pelo menos um item cuja linha casa com o texto (título, SKU,
 * IDs de venda/anúncio/linha).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} qTrim
 * @param {number} [rowLimit]
 * @returns {Promise<string[]>}
 */
export async function fetchOrderIdsFromItemTextSearch(supabase, userId, qTrim, rowLimit = 1200) {
  const q = normalizeSearchQuery(String(qTrim ?? ""));
  if (!q) return [];
  const tokens = splitSearchTokens(q);
  if (tokens.length === 0) return [];
  const lim = Math.min(3000, Math.max(50, Number.isFinite(rowLimit) ? Math.floor(rowLimit) : 1200));

  const orExpr = buildVendasSalesItemQOrFilter(tokens, []);
  if (!orExpr) return [];

  const { data, error } = await supabase.from("sales_order_items").select("sales_order_id").eq("user_id", userId).or(orExpr).limit(lim);
  if (error) {
    console.warn("[S7][vendas] item_text_search_order_ids", { message: error?.message });
    return [];
  }
  const out = new Set();
  for (const r of data || []) {
    if (r?.sales_order_id != null) out.add(String(r.sales_order_id));
  }
  return [...out];
}

/**
 * @param {unknown} slug
 * @returns {string | null}
 */
export function marketplaceLabel(slug) {
  const s = String(slug ?? "").trim().toLowerCase();
  if (s === "mercado_livre" || s === "mercadolivre") return "Mercado Livre";
  return s ? String(slug).trim() : null;
}

/** @param {unknown} v */
function pickTrim(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * Evita mixed content e URLs protocol-relative em thumbs ML/CDN.
 * @param {unknown} url
 * @returns {string | null}
 */
export function normalizeSalesUiImageUrl(url) {
  const u = pickTrim(url);
  if (!u) return null;
  if (u.startsWith("//")) return `https:${u}`;
  if (/^http:\/\//i.test(u)) {
    const lower = u.toLowerCase();
    if (
      lower.includes("mercadolivre") ||
      lower.includes("mercadolibre") ||
      lower.includes("mlstatic") ||
      lower.includes("mlcdn")
    ) {
      return `https://${u.slice(7)}`;
    }
  }
  return u;
}

/**
 * Nome amigável para coluna Comprador (backend resolve; nickname só fallback).
 * Ordem: buyer_full_name → buyer.first+last → customer_full_name → marketplace_customers → nickname.
 *
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {Record<string, unknown> | null | undefined} customerRecord — marketplace_customers (opcional)
 */
export function resolveBuyerDisplayName(orderRaw, customerRecord) {
  const b = orderRaw?.buyer && typeof orderRaw.buyer === "object" ? /** @type {Record<string, unknown>} */ (orderRaw.buyer) : null;

  const fullNameDirect =
    pickTrim(orderRaw?.buyer_full_name) ||
    pickTrim(orderRaw?.customer_full_name) ||
    pickTrim(b?.full_name) ||
    pickTrim(b?.name);

  const fn = pickTrim(b?.first_name);
  const ln = pickTrim(b?.last_name);
  const composed = fn || ln ? [fn, ln].filter(Boolean).join(" ").trim() : null;

  const fromCustomer = customerRecord ? pickTrim(customerRecord.name) : null;

  const nick = pickTrim(b?.nickname);

  return fullNameDirect || composed || fromCustomer || nick || null;
}

/**
 * Primeira URL http(s) usável a partir de campo estilo ML (string | { secure_url, url }).
 * @param {unknown} v
 * @returns {string | null}
 */
function pickMlHttpPictureField(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? null : s;
  }
  if (typeof v === "object" && v !== null) {
    const o = /** @type {Record<string, unknown>} */ (v);
    if (typeof o.secure_url === "string" && o.secure_url.trim()) return o.secure_url.trim();
    if (typeof o.url === "string" && o.url.trim()) return o.url.trim();
  }
  return null;
}

/**
 * Avatar comprador a partir do snapshot do pedido ML (payload /orders + enriquecimento opcional GET /users/:id).
 * @param {Record<string, unknown> | null | undefined} orderRaw
 */
export function extractBuyerThumbFromOrderRaw(orderRaw) {
  const b = orderRaw?.buyer && typeof orderRaw.buyer === "object" ? /** @type {Record<string, unknown>} */ (orderRaw.buyer) : null;
  if (!b) return null;
  const candidates = [
    pickMlHttpPictureField(b.thumbnail),
    pickMlHttpPictureField(b.picture),
    typeof b.secure_thumbnail === "string" && b.secure_thumbnail.trim() ? b.secure_thumbnail.trim() : null,
    typeof b.photo === "string" && b.photo.trim() ? b.photo.trim() : null,
    typeof b.avatar_url === "string" && b.avatar_url.trim() ? b.avatar_url.trim() : null,
    typeof b.image === "string" && b.image.trim() ? b.image.trim() : null,
  ];
  for (const raw of candidates) {
    const n = normalizeSalesUiImageUrl(raw);
    if (n) return n;
  }
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @returns {{ name: string | null; thumb: string | null }}
 */
export function extractBuyerFromOrderRaw(orderRaw) {
  return {
    name: resolveBuyerDisplayName(orderRaw, null),
    thumb: extractBuyerThumbFromOrderRaw(orderRaw),
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {string | null | undefined} externalOrderItemId
 */
export function titleFromOrderItemsArray(orderRaw, externalOrderItemId) {
  if (!externalOrderItemId) return null;
  const want = String(externalOrderItemId).trim();
  if (!want) return null;
  const arr = orderRaw?.order_items;
  if (!Array.isArray(arr)) return null;
  for (const line of arr) {
    if (!line || typeof line !== "object") continue;
    const lid =
      line.id != null
        ? String(line.id).trim()
        : line.order_item_id != null
          ? String(line.order_item_id).trim()
          : "";
    if (lid && lid === want) {
      const item = line.item && typeof line.item === "object" ? line.item : null;
      const t =
        item?.title != null
          ? String(item.title).trim()
          : line.title != null
            ? String(line.title).trim()
            : "";
      return t || null;
    }
  }
  return null;
}

/**
 * Linha do pedido ML em order.raw_json.order_items (snapshot histórico da venda).
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {string | null | undefined} externalOrderItemId
 * @returns {Record<string, unknown> | null}
 */
export function findMercadoLivreOrderLine(orderRaw, externalOrderItemId, externalListingId = null) {
  if (!orderRaw || typeof orderRaw !== "object") return null;
  const want = externalOrderItemId != null ? String(externalOrderItemId).trim() : "";
  const wantListing = externalListingId != null ? String(externalListingId).trim() : "";
  const arr = orderRaw.order_items;
  if (!Array.isArray(arr)) return null;

  if (want) {
    for (const line of arr) {
      if (!line || typeof line !== "object") continue;
      const lid =
        line.id != null
          ? String(line.id).trim()
          : line.order_item_id != null
            ? String(line.order_item_id).trim()
            : "";
      if (lid && lid === want) return /** @type {Record<string, unknown>} */ (line);
    }
  }

  if (wantListing) {
    for (const line of arr) {
      if (!line || typeof line !== "object") continue;
      const itemObj = line.item && typeof line.item === "object" ? /** @type {Record<string, unknown>} */ (line.item) : null;
      const listingRef =
        itemObj?.id != null
          ? String(itemObj.id).trim()
          : line.item_id != null
            ? String(line.item_id).trim()
            : "";
      if (listingRef && listingRef === wantListing) return /** @type {Record<string, unknown>} */ (line);
    }
  }

  if (arr.length === 1 && arr[0] && typeof arr[0] === "object") {
    return /** @type {Record<string, unknown>} */ (arr[0]);
  }

  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} lineRaw
 */
export function titleFromLineRawJson(lineRaw) {
  if (!lineRaw || typeof lineRaw !== "object") return null;
  const item = lineRaw.item && typeof lineRaw.item === "object" ? lineRaw.item : null;
  const t =
    item?.title != null
      ? String(item.title).trim()
      : lineRaw.title != null
        ? String(lineRaw.title).trim()
        : "";
  return t || null;
}

/**
 * @param {unknown} pics
 */
export function firstMlPictureUrl(pics) {
  if (!Array.isArray(pics) || pics.length === 0) return null;
  const p0 = pics[0];
  if (typeof p0 === "string" && p0.trim()) return normalizeSalesUiImageUrl(p0.trim());
  if (p0 && typeof p0 === "object" && p0.secure_url) return normalizeSalesUiImageUrl(String(p0.secure_url));
  if (p0 && typeof p0 === "object" && p0.url) return normalizeSalesUiImageUrl(String(p0.url));
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} listingRaw
 */
export function thumbFromListingRaw(listingRaw) {
  if (!listingRaw || typeof listingRaw !== "object") return null;
  const th = listingRaw.thumbnail;
  if (th && typeof th === "string" && th.trim()) return normalizeSalesUiImageUrl(th.trim());
  if (th && typeof th === "object" && th.secure_url) return normalizeSalesUiImageUrl(String(th.secure_url));
  const pics = listingRaw.pictures;
  return firstMlPictureUrl(pics);
}

/**
 * @param {Record<string, unknown> | null | undefined} listing
 */
export function thumbFromListingRecord(listing) {
  if (!listing || typeof listing !== "object") return null;
  const directThumb = listing.thumbnail;
  if (typeof directThumb === "string" && directThumb.trim()) return normalizeSalesUiImageUrl(directThumb.trim());
  if (directThumb && typeof directThumb === "object" && directThumb.secure_url) {
    return normalizeSalesUiImageUrl(String(directThumb.secure_url));
  }
  for (const key of ["thumbnail_url", "secure_thumbnail", "picture_url"]) {
    const u = listing[key];
    if (typeof u === "string" && u.trim()) return normalizeSalesUiImageUrl(u.trim());
  }
  const directPics = listing.pictures;
  const p = firstMlPictureUrl(directPics);
  if (p) return p;
  return thumbFromListingRaw(
    listing.raw_json && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : null,
  );
}

/**
 * @param {Record<string, unknown>} item
 */
export function thumbFromSalesItem(item) {
  const snap = item.thumbnail_snapshot;
  if (typeof snap === "string" && snap.trim()) return normalizeSalesUiImageUrl(snap.trim());
  const direct = item.thumbnail;
  if (typeof direct === "string" && direct.trim()) return normalizeSalesUiImageUrl(direct.trim());
  return thumbFromSalesItemRawJsonOnly(item);
}

/**
 * Fotos apenas em sales_order_items.raw_json (sem thumbnail_snapshot / coluna thumbnail).
 * @param {Record<string, unknown>} item
 */
export function thumbFromSalesItemRawJsonOnly(item) {
  if (!item || typeof item !== "object") return null;
  const raw = item.raw_json && typeof item.raw_json === "object" ? /** @type {Record<string, unknown>} */ (item.raw_json) : null;
  if (!raw) return null;
  const fromLine = extractMlLineThumbnail(/** @type {Record<string, unknown>} */ (raw));
  if (fromLine) return normalizeSalesUiImageUrl(fromLine);
  const itemObj = raw.item && typeof raw.item === "object" ? raw.item : null;
  const rawThumb = itemObj?.thumbnail ?? raw.thumbnail;
  if (typeof rawThumb === "string" && rawThumb.trim()) return normalizeSalesUiImageUrl(rawThumb.trim());
  if (rawThumb && typeof rawThumb === "object" && rawThumb.secure_url) {
    return normalizeSalesUiImageUrl(String(rawThumb.secure_url));
  }
  const rawPics = itemObj?.pictures ?? raw.pictures;
  return firstMlPictureUrl(rawPics);
}

/**
 * Thumbnail da linha correspondente em order.raw_json.order_items (ML).
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {string | null | undefined} externalOrderItemId
 */
export function thumbFromOrderItemsLine(orderRaw, externalOrderItemId) {
  if (!orderRaw || !externalOrderItemId) return null;
  const want = String(externalOrderItemId).trim();
  if (!want) return null;
  const arr = orderRaw.order_items;
  if (!Array.isArray(arr)) return null;
  for (const line of arr) {
    if (!line || typeof line !== "object") continue;
    const lid =
      line.id != null
        ? String(line.id).trim()
        : line.order_item_id != null
          ? String(line.order_item_id).trim()
          : "";
    if (lid && lid === want) {
      return normalizeSalesUiImageUrl(extractMlLineThumbnail(/** @type {Record<string, unknown>} */ (line)));
    }
  }
  return null;
}

/**
 * URL de imagem do produto na listagem /vendas (backend resolve; FE só renderiza).
 * Ordem: thumbnail_snapshot → listing → coluna thumbnail do item → raw_json da linha → pedido → produto interno.
 *
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} listing
 * @param {Record<string, unknown> | null | undefined} product
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {string | null | undefined} externalOrderItemId
 */
export function resolveProductImageUrl(item, listing, product, orderRaw, externalOrderItemId) {
  const snap = normalizeSalesUiImageUrl(pickTrim(item?.thumbnail_snapshot));
  if (snap) return snap;
  const fromListing = thumbFromListingRecord(listing ?? null);
  if (fromListing) return fromListing;
  const itemThumbCol = normalizeSalesUiImageUrl(pickTrim(item?.thumbnail));
  if (itemThumbCol) return itemThumbCol;
  const fromItemRaw = thumbFromSalesItemRawJsonOnly(item);
  if (fromItemRaw) return fromItemRaw;
  const fromOrder = thumbFromOrderItemsLine(orderRaw ?? null, externalOrderItemId);
  if (fromOrder) return fromOrder;
  const fromProdLinks = thumbFromProductImageLinksHttps(product ?? null);
  if (fromProdLinks) return fromProdLinks;
  return thumbFromProductImages(product?.product_images);
}

/**
 * Mesma base das grids Anúncios/Precificações para “completar cadastro” (custos + readiness mínimo).
 * Só true quando há produto interno com id — alinhado ao QuickProductCostsModal (precisa productId).
 *
 * @param {Record<string, unknown> | null | undefined} product — linha products
 * @param {Record<string, unknown> | null | undefined} listing
 */
export function computeNeedsProductCompletion(product, listing) {
  const pid =
    product?.id != null && String(product.id).trim() !== ""
      ? String(product.id).trim()
      : listing?.product_id != null && String(listing.product_id).trim() !== ""
        ? String(listing.product_id).trim()
        : null;
  if (!pid) return false;
  if (!product || typeof product !== "object") return true;
  const { is_product_ready } = computeProductReadiness(product);
  if (!is_product_ready) return true;
  if (!hasRequiredProductCosts(product.cost_price, product.packaging_cost, product.operational_cost)) return true;
  return false;
}

/**
 * @param {unknown} productImages
 */
export function thumbFromProductImages(productImages) {
  if (!productImages) return null;
  if (Array.isArray(productImages) && productImages.length > 0) {
    const x = productImages[0];
    if (x && typeof x === "object") {
      if (x.url) return normalizeSalesUiImageUrl(String(x.url).trim());
      if (x.storage_path) return null;
    }
  }
  return null;
}

/**
 * Primeira URL http(s) em product_image_links (ordem sort_order; só links “gerais”).
 * @param {Record<string, unknown> | null | undefined} product
 */
function thumbFromProductImageLinksHttps(product) {
  const links = product?.product_image_links;
  if (!Array.isArray(links) || links.length === 0) return null;
  const general = links.filter((l) => l && (l.variant_key == null || l.variant_key === ""));
  const sorted = [...general].sort((a, b) => (Number(a?.sort_order) || 0) - (Number(b?.sort_order) || 0));
  for (const l of sorted) {
    const u = l?.url != null ? String(l.url).trim() : "";
    if (/^https?:\/\//i.test(u)) return normalizeSalesUiImageUrl(u);
  }
  return null;
}

/**
 * Prioridade de rótulo (contrato S7):
 * 1 product_name
 * 2 listing.title
 * 3 title_snapshot
 * 4 raw_json pedido order_items[].item.title
 * 5 raw_json linha item.title
 * 6 seller_sku / sku_snapshot / sku
 * 7 external ids
 * 8 fallback literal
 *
 * @param {{
 *   productName: string | null;
 *   listingTitle: string | null;
 *   titleSnapshot: string | null;
 *   orderItemsTitle: string | null;
 *   lineItemTitle: string | null;
 *   skuLabel: string | null;
 *   externalOrderItemId: string | null;
 *   externalItemId: string | null;
 * }} p
 */
export function pickProductDisplayTitle(p) {
  const chain = [
    p.productName,
    p.listingTitle,
    p.titleSnapshot,
    p.orderItemsTitle,
    p.lineItemTitle,
    p.skuLabel,
    p.externalOrderItemId,
    p.externalItemId,
  ];
  for (const c of chain) {
    if (c != null && String(c).trim() !== "") return String(c).trim();
  }
  return "Produto não identificado";
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null} order
 * @param {Record<string, unknown> | null} listing
 * @param {Record<string, unknown> | null} product
 */
export function resolveSkuDisplay(item, listing, product) {
  const fromProd = product?.sku != null ? String(product.sku).trim() : "";
  if (fromProd) return fromProd;
  const ls = listing?.seller_sku != null ? String(listing.seller_sku).trim() : "";
  if (ls) return ls;
  const snap = item.sku_snapshot != null ? String(item.sku_snapshot).trim() : "";
  if (snap) return snap;
  const skuCol = item.sku != null ? String(item.sku).trim() : "";
  if (skuCol) return skuCol;
  return "";
}

/**
 * Custo cadastro (produto) × quantidade, quando houver custo unitário.
 * @param {Record<string, unknown> | null} product
 * @param {number} qty
 */
export function productCostLineTotalBrl(product, qty) {
  if (!product) return null;
  const unit = toNum(product.cost_price);
  if (unit == null) return null;
  const q = Number.isFinite(qty) && qty > 0 ? qty : 1;
  return unit * q;
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 */
function resolveContingencySnapshot(item, order) {
  const itemRaw =
    item?.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;
  const itemFin =
    itemRaw?._s7_financial && typeof itemRaw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (itemRaw._s7_financial)
      : null;
  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (order.raw_json)
      : null;
  const orderFin =
    orderRaw?._s7_financial && typeof orderRaw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (orderRaw._s7_financial)
      : null;
  const snap =
    (itemFin?.contingency_margin_snapshot &&
    typeof itemFin.contingency_margin_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (itemFin.contingency_margin_snapshot)
      : null) ??
    (orderFin?.contingency_margin_snapshot &&
    typeof orderFin.contingency_margin_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (orderFin.contingency_margin_snapshot)
      : null);

  /** @type {Array<Record<string, unknown>>} */
  const lines = [];
  if (snap?.ml_ads_brl != null && String(snap.ml_ads_brl).trim() !== "") {
    lines.push({
      key: "ml_ads",
      label: "ML Ads",
      amount_brl: String(snap.ml_ads_brl),
      percent: snap.ml_ads_percent != null ? String(snap.ml_ads_percent) : null,
    });
  }
  const reserveAmount = snap?.reserve_brl ?? snap?.safety_reserve_brl ?? snap?.reserve_amount_brl ?? null;
  const reservePercent = snap?.reserve_percent ?? snap?.safety_reserve_percent ?? null;
  if (reserveAmount != null && String(reserveAmount).trim() !== "") {
    lines.push({
      key: "safety_reserve",
      label: "Reserva perdas e devolucoes",
      amount_brl: String(reserveAmount),
      percent: reservePercent != null ? String(reservePercent) : null,
    });
  }
  if (lines.findIndex((line) => String(line.key) === "ml_ads") === -1) {
    const adsSnap =
      itemFin?.ads_snapshot && typeof itemFin.ads_snapshot === "object"
        ? /** @type {Record<string, unknown>} */ (itemFin.ads_snapshot)
        : null;
    const adsAmount = adsSnap?.amount_brl ?? adsSnap?.ml_ads_brl ?? null;
    if (adsAmount != null && String(adsAmount).trim() !== "") {
      lines.push({
        key: "ml_ads",
        label: "ML Ads",
        amount_brl: String(adsAmount),
        percent: adsSnap?.percent != null ? String(adsSnap.percent) : null,
      });
    }
  }
  if (lines.findIndex((line) => String(line.key) === "safety_reserve") === -1) {
    const operationalSnap =
      itemFin?.operational_cost_snapshot && typeof itemFin.operational_cost_snapshot === "object"
        ? /** @type {Record<string, unknown>} */ (itemFin.operational_cost_snapshot)
        : null;
    const reserveAmount =
      operationalSnap?.reserve_brl ?? operationalSnap?.operational_costs_brl ?? null;
    const reservePercent = operationalSnap?.reserve_percent ?? null;
    if (reserveAmount != null && String(reserveAmount).trim() !== "") {
      lines.push({
        key: "safety_reserve",
        label: "Reserva perdas e devolucoes",
        amount_brl: String(reserveAmount),
        percent: reservePercent != null ? String(reservePercent) : null,
      });
    }
  }
  if (lines.length === 0) return null;
  return lines;
}

/**
 * @param {Record<string, unknown>} item
 */
function resolveFinancialSnapshotMetadata(item) {
  const raw =
    item?.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;
  const fin =
    raw?._s7_financial && typeof raw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (raw._s7_financial)
      : null;
  if (!fin) {
    return {
      snapshot_origin: null,
      snapshot_quality: null,
      estimated: null,
    };
  }
  const estimatedRaw = fin.estimated;
  return {
    snapshot_origin: fin.snapshot_origin != null ? String(fin.snapshot_origin) : null,
    snapshot_quality: fin.snapshot_quality != null ? String(fin.snapshot_quality) : null,
    estimated: typeof estimatedRaw === "boolean" ? estimatedRaw : null,
  };
}

/**
 * Fonte financeira unica para a linha da lista /vendas:
 * - receita de marketplace + custos internos vindos do snapshot historico quando existir;
 * - sem recalculo com configuracao viva de contingencia.
 *
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} listing
 */
function buildVendasListFinancials(item, order, listing) {
  let financials = buildSaleDetailFinancialBreakdown(item, null, order ?? null, listing ?? null, {});
  const snapshotMeta = resolveFinancialSnapshotMetadata(item);
  const contingencyLines = resolveContingencySnapshot(item, order);
  if (contingencyLines) {
    financials = {
      ...financials,
      commercial_adjustment_lines: contingencyLines,
      pricing_variables_source: "historical_financial_snapshot",
      snapshot_origin: snapshotMeta.snapshot_origin,
      snapshot_quality: snapshotMeta.snapshot_quality,
      estimated: snapshotMeta.estimated,
    };
  } else {
    financials = {
      ...financials,
      commercial_adjustment_lines: [],
      pricing_variables_source: "snapshot_missing_no_live_recalculation",
      snapshot_origin: snapshotMeta.snapshot_origin,
      snapshot_quality: snapshotMeta.snapshot_quality,
      estimated: snapshotMeta.estimated,
    };
  }
  return finalizeSaleDetailFinancialWithContingency(financials);
}

/**
 * @param {{
 *   item: Record<string, unknown>;
 *   order: Record<string, unknown> | null | undefined;
 *   listing: Record<string, unknown> | null | undefined;
 *   product: Record<string, unknown> | null | undefined;
 *   account: Record<string, unknown> | null | undefined;
 *   customer?: Record<string, unknown> | null | undefined;
 *   sellerCompany?: Record<string, unknown> | null | undefined;
 * }} ctx
 */
export function buildVendasListRow(ctx) {
  const { item, order, listing, product, account, customer, sellerCompany } = ctx;
  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (order.raw_json)
      : null;
  const itemRaw =
    item.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;

  const buyerDisplayName = resolveBuyerDisplayName(orderRaw, customer ?? null);
  const buyerThumb = extractBuyerThumbFromOrderRaw(orderRaw);
  const extItem =
    item.external_order_item_id != null
      ? String(item.external_order_item_id).trim()
      : item.external_item_id != null
        ? String(item.external_item_id).trim()
        : "";

  const orderItemsTitle = titleFromOrderItemsArray(orderRaw, extItem || null);
  const lineItemTitle = titleFromLineRawJson(
    item.raw_json && typeof item.raw_json === "object" ? /** @type {Record<string, unknown>} */ (item.raw_json) : null,
  );

  const productName =
    product?.product_name != null && String(product.product_name).trim() !== ""
      ? String(product.product_name).trim()
      : null;
  const listingTitle =
    listing?.title != null && String(listing.title).trim() !== "" ? String(listing.title).trim() : null;
  const titleSnapshot =
    item.title_snapshot != null && String(item.title_snapshot).trim() !== "" ? String(item.title_snapshot).trim() : null;

  const skuLabel = resolveSkuDisplay(item, listing, product);

  const product_display_title = pickProductDisplayTitle({
    productName,
    listingTitle,
    titleSnapshot,
    orderItemsTitle,
    lineItemTitle,
    skuLabel: skuLabel || null,
    externalOrderItemId: extItem || null,
    externalItemId:
      item.external_item_id != null && String(item.external_item_id).trim() !== ""
        ? String(item.external_item_id).trim()
        : null,
  });

  const qty = Number.parseInt(String(item.quantity ?? "1"), 10) || 1;
  const financials = buildVendasListFinancials(item, order, listing);

  const sale_status_label =
    resolveSaleOperationalStatusLabel(
      orderRaw,
      {
        order_status: order?.order_status ?? null,
        order_substatus: order?.order_substatus ?? null,
      },
      itemRaw,
    ) ?? null;

  let product_image_url = resolveProductImageUrl(item, listing, product ?? null, orderRaw, extItem || null);
  product_image_url = normalizeSalesUiImageUrl(product_image_url);

  const account_logo_url = normalizeSalesUiImageUrl(
    pickTrim(sellerCompany?.logo_url) ||
      pickTrim(sellerCompany?.avatar_url) ||
      pickTrim(account?.logo_url) ||
      pickTrim(account?.avatar_url) ||
      pickTrim(account?.company_logo_url) ||
      pickTrim(account?.ml_picture_url) ||
      null,
  );

  const marketplace = item.marketplace != null ? String(item.marketplace) : "";
  const marketplace_account_id =
    item.marketplace_account_id != null && String(item.marketplace_account_id).trim() !== ""
      ? String(item.marketplace_account_id).trim()
      : order?.marketplace_account_id != null && String(order.marketplace_account_id).trim() !== ""
        ? String(order.marketplace_account_id).trim()
        : null;

  const account_alias =
    account?.account_alias != null && String(account.account_alias).trim() !== ""
      ? String(account.account_alias).trim()
      : account?.ml_nickname != null && String(account.ml_nickname).trim() !== ""
        ? String(account.ml_nickname).trim()
        : null;

  const saleDate =
    order?.date_created_marketplace ??
    order?.paid_at ??
    order?.date_closed_marketplace ??
    item.created_at ??
    null;

  const sale_display_code =
    order?.external_order_id != null && String(order.external_order_id).trim() !== ""
      ? String(order.external_order_id).trim()
      : item.external_order_id != null && String(item.external_order_id).trim() !== ""
        ? String(item.external_order_id).trim()
        : null;

  const listing_id_display =
    listing?.external_listing_id != null && String(listing.external_listing_id).trim() !== ""
      ? String(listing.external_listing_id).trim()
      : item.external_listing_id != null && String(item.external_listing_id).trim() !== ""
        ? String(item.external_listing_id).trim()
        : "";

  const needs_product_completion = computeNeedsProductCompletion(product ?? null, listing ?? null);

  return {
    item_id: String(item.id),
    sale_item_id: String(item.id),
    sales_order_id: item.sales_order_id != null ? String(item.sales_order_id) : null,
    external_order_id: sale_display_code,
    external_order_item_id: extItem || null,
    order_internal_id: order?.id != null ? String(order.id) : null,
    marketplace,
    marketplace_label: marketplaceLabel(marketplace),
    marketplace_account_id,
    seller_company_id:
      item.seller_company_id != null && String(item.seller_company_id).trim() !== ""
        ? String(item.seller_company_id)
        : order?.seller_company_id != null && String(order.seller_company_id).trim() !== ""
          ? String(order.seller_company_id)
          : null,
    account_alias,
    ml_account_alias: account_alias,
    account_logo_url,
    order_status: order?.order_status != null ? String(order.order_status) : null,
    sale_status_label,
    /** ISO da venda no marketplace — usar para ordenação (mesma prioridade do backend). */
    date_created_marketplace: order?.date_created_marketplace ?? null,
    /** created_at do pedido interno (fallback de estabilidade). */
    order_created_at: order?.created_at ?? null,
    /** created_at da linha em sales_order_items. */
    item_created_at: item.created_at ?? null,
    created_at: item.created_at ?? order?.created_at ?? null,
    approved_at: order?.paid_at ?? null,
    sale_date: saleDate,
    sale_display_code,
    buyer_display_name: buyerDisplayName,
    buyer_thumbnail_url: buyerThumb,
    listing_id_display,
    sku_display: skuLabel,
    product_display_title,
    product_image_url,
    product_thumbnail_url: product_image_url,
    listing_thumbnail_url: normalizeSalesUiImageUrl(thumbFromListingRecord(listing ?? null)),
    product_images: product?.product_images ?? null,
    product_image_links: product?.product_image_links ?? null,
    product_id: product?.id != null ? String(product.id) : listing?.product_id != null ? String(listing.product_id) : null,
    needs_product_completion,
    quantity: qty,
    product_cost_only_brl:
      financials?.product_cost_only_brl != null ? String(financials.product_cost_only_brl) : null,
    financials,
    raw_json: item.raw_json ?? null,
    order_raw_json: order?.raw_json ?? null,
  };
}

/**
 * Alinha sale_status_label da lista com o Raio-X: snapshot de envio ML atualizado por pedido (mesma rotina do GET /api/sales/detail).
 * @param {string} userId
 * @param {Record<string, unknown>[]} items
 * @param {Map<string, Record<string, unknown>>} ordersById
 * @param {Record<string, unknown>[]} rows
 */
export async function enrichVendasListRowsOperationalStatus(userId, items, ordersById, rows) {
  if (!Array.isArray(items) || !Array.isArray(rows) || rows.length === 0) return rows;

  const itemById = new Map();
  for (const it of items) {
    if (it?.id != null) itemById.set(String(it.id), it);
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const orderForGeneralById = new Map();
  /** @type {Map<string, Promise<Record<string, unknown>>>} */
  const refreshByOrderId = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;

    const itemKey =
      row.item_id != null
        ? String(row.item_id)
        : row.sale_item_id != null
          ? String(row.sale_item_id)
          : "";
    const item = (itemKey && itemById.get(itemKey)) || items[i] || null;
    if (!item || typeof item !== "object") continue;

    const orderId = item.sales_order_id != null ? String(item.sales_order_id) : "";
    if (!orderId) continue;

    const order = ordersById.get(orderId);
    if (!order || typeof order !== "object") continue;

    const marketplace = String(item.marketplace ?? order.marketplace ?? "")
      .trim()
      .toLowerCase();
    if (marketplace !== "mercado_livre" && marketplace !== "mercadolivre") continue;

    const marketplaceAccountId =
      item.marketplace_account_id != null && String(item.marketplace_account_id).trim() !== ""
        ? String(item.marketplace_account_id).trim()
        : order.marketplace_account_id != null && String(order.marketplace_account_id).trim() !== ""
          ? String(order.marketplace_account_id).trim()
          : "";

    if (!marketplaceAccountId) continue;

    let orderForGeneral = orderForGeneralById.get(orderId);
    if (!orderForGeneral) {
      if (!refreshByOrderId.has(orderId)) {
        refreshByOrderId.set(
          orderId,
          (async () => {
            try {
              const token = await getValidMLToken(userId, { marketplaceAccountId });
              return await attachFreshMercadoLivreShipmentSnapshot(order, token, marketplaceAccountId);
            } catch {
              return order;
            }
          })(),
        );
      }
      orderForGeneral = await refreshByOrderId.get(orderId);
      orderForGeneralById.set(orderId, orderForGeneral);
    }

    const orderRaw =
      orderForGeneral?.raw_json && typeof orderForGeneral.raw_json === "object"
        ? /** @type {Record<string, unknown>} */ (orderForGeneral.raw_json)
        : null;
    const itemRaw =
      item.raw_json && typeof item.raw_json === "object"
        ? /** @type {Record<string, unknown>} */ (item.raw_json)
        : null;

    row.sale_status_label =
      resolveSaleOperationalStatusLabel(
        orderRaw,
        {
          order_status: order.order_status != null ? String(order.order_status) : null,
          order_substatus:
            order.order_substatus != null ? String(order.order_substatus) : null,
        },
        itemRaw,
      ) ?? null;
  }

  return rows;
}
