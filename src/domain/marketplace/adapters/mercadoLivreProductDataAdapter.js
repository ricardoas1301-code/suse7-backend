// ======================================================================
// Adapter ML — normaliza item + descrição → payload de produto Suse7.
// Sem acoplamento direto na UI; consumido por normalizeMarketplaceProductData.
// ======================================================================

import { ML_MARKETPLACE_SLUG } from "../../../handlers/ml/_helpers/mlMarketplace.js";
import { normalizeAdTitles } from "../../../utils/normalizeAdTitles.js";
import { resolveMercadoLivreCommercialSeoKeywords } from "./mercadoLivreSeoKeywords.js";

export const ML_PRODUCT_IMPORT_MAX_IMAGES = 7;

/** @param {Record<string, unknown> | null | undefined} item */
function listingAttributes(item) {
  return Array.isArray(item?.attributes) ? item.attributes : [];
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 * @param {string[]} ids
 */
function pickAttrValue(item, ids) {
  const attrs = listingAttributes(item);
  for (const id of ids) {
    const a = attrs.find((x) => x && typeof x === "object" && String(x.id) === id);
    const vn = a?.value_name;
    if (vn != null && String(vn).trim() !== "") return String(vn).trim();
    const vid = a?.value_id;
    if (vid != null && String(vid).trim() !== "") return String(vid).trim();
  }
  return null;
}

/** @param {unknown} v */
function digitsOrNull(v) {
  if (v == null || v === "") return null;
  const d = String(v).replace(/\D/g, "");
  return d === "" ? null : d;
}

/** @param {unknown} v */
function parseDecimalOrNull(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Peso ML → kg (Raio-X exibe em kg). "8240 g" → 8.24; "1.5 kg" → 1.5.
 * @param {unknown} raw
 */
export function parseMercadoLivreWeightToKg(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().toLowerCase().replace(",", ".");
  const match = s.match(/^([\d.]+)\s*(kg|g|gramas?|quilogramas?)?$/i);
  if (!match) return parseDecimalOrNull(raw);
  const n = parseFloat(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (match[2] || "").toLowerCase();
  if (unit === "g" || unit.startsWith("gram")) {
    return Math.round((n / 1000) * 1000) / 1000;
  }
  if (unit === "kg" || unit.startsWith("quilo")) return n;
  // Embalagem ML sem unidade explícita costuma vir em gramas quando > 30.
  if (n > 30) return Math.round((n / 1000) * 1000) / 1000;
  return n;
}

/** @param {unknown} v */
function parseIntOrNull(v) {
  if (v == null || v === "") return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Estoque disponível no anúncio ML (simples ou soma de variações).
 * @param {Record<string, unknown> | null | undefined} item
 */
export function resolveMercadoLivreAvailableStock(item) {
  if (!item || typeof item !== "object") return null;
  const variations = Array.isArray(item.variations) ? item.variations : [];
  if (variations.length > 0) {
    let sum = 0;
    let any = false;
    for (const v of variations) {
      const q = parseIntOrNull(v?.available_quantity);
      if (q != null && q >= 0) {
        sum += q;
        any = true;
      }
    }
    return any ? sum : null;
  }
  return parseIntOrNull(item.available_quantity);
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 * @returns {{ url: string; sort_order: number }[]}
 */
export function extractMercadoLivrePictureUrls(item) {
  const pics = Array.isArray(item?.pictures) ? item.pictures : [];
  /** @type {{ url: string; sort_order: number }[]} */
  const out = [];
  for (let i = 0; i < pics.length && out.length < ML_PRODUCT_IMPORT_MAX_IMAGES; i += 1) {
    const p = pics[i];
    const u = p?.secure_url || p?.url;
    if (u && String(u).startsWith("http")) {
      out.push({ url: String(u).trim(), sort_order: i });
    }
  }
  return out;
}

/**
 * NCM — atributo fiscal BR no ML.
 * @param {Record<string, unknown> | null | undefined} item
 */
function resolveMercadoLivreNcm(item) {
  const raw = pickAttrValue(item, ["NCM", "TAX_NCM"]);
  if (!raw) return null;
  const d = digitsOrNull(raw);
  return d && d.length >= 8 ? d.slice(0, 8) : digitsOrNull(raw);
}

/**
 * Medidas de envio (embalagem vendedor) — não confundir com montado.
 * @param {Record<string, unknown> | null | undefined} item
 */
function resolveMercadoLivreShippingDimensions(item) {
  return {
    width: parseDecimalOrNull(pickAttrValue(item, ["SELLER_PACKAGE_WIDTH", "PACKAGE_WIDTH", "WIDTH"])),
    height: parseDecimalOrNull(pickAttrValue(item, ["SELLER_PACKAGE_HEIGHT", "PACKAGE_HEIGHT", "HEIGHT"])),
    length: parseDecimalOrNull(pickAttrValue(item, ["SELLER_PACKAGE_LENGTH", "PACKAGE_LENGTH", "LENGTH"])),
    weight: parseMercadoLivreWeightToKg(
      pickAttrValue(item, ["SELLER_PACKAGE_WEIGHT", "PACKAGE_WEIGHT", "WEIGHT"])
    ),
  };
}

/**
 * Medidas do produto montado — só se houver atributos explícitos (sem PACKAGE).
 * @param {Record<string, unknown> | null | undefined} item
 */
function resolveMercadoLivreAssembledDimensions(item) {
  const w = parseDecimalOrNull(pickAttrValue(item, ["ASSEMBLED_WIDTH", "PRODUCT_WIDTH"]));
  const h = parseDecimalOrNull(pickAttrValue(item, ["ASSEMBLED_HEIGHT", "PRODUCT_HEIGHT"]));
  const l = parseDecimalOrNull(pickAttrValue(item, ["ASSEMBLED_LENGTH", "PRODUCT_LENGTH", "PRODUCT_DEPTH"]));
  const wt = parseMercadoLivreWeightToKg(pickAttrValue(item, ["ASSEMBLED_WEIGHT", "PRODUCT_WEIGHT"]));
  if (w == null && h == null && l == null && wt == null) {
    return { assembled_width: null, assembled_height: null, assembled_length: null, assembled_weight: null };
  }
  return {
    assembled_width: w,
    assembled_height: h,
    assembled_length: l,
    assembled_weight: wt,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 * @param {Record<string, unknown> | null | undefined} description
 * @param {string} resolvedSku
 * @param {string} externalListingId
 */
export function normalizeMercadoLivreProductData(item, description, resolvedSku, externalListingId) {
  const title = item?.title != null ? String(item.title).trim() : "";
  const plainDesc =
    description && typeof description === "object" && description.plain_text != null
      ? String(description.plain_text).trim()
      : "";

  const pictures = extractMercadoLivrePictureUrls(item);
  const product_images = pictures.length
    ? pictures.map((p) => ({ url: p.url }))
    : null;

  const shippingDims = resolveMercadoLivreShippingDimensions(item);
  const assembledDims = resolveMercadoLivreAssembledDimensions(item);

  const brand = pickAttrValue(item, ["BRAND", "MANUFACTURER"]);
  const model = pickAttrValue(item, ["MODEL", "MODEL_NAME"]);
  const gtin =
    digitsOrNull(pickAttrValue(item, ["GTIN", "EAN", "BARCODE", "ISBN"])) ??
    digitsOrNull(item?.catalog_product_id);

  const ext = externalListingId != null ? String(externalListingId).trim() : "";

  return {
    marketplace: ML_MARKETPLACE_SLUG,
    source_external_listing_id: ext || null,
    product_name: title || resolvedSku || "Produto importado",
    sku: resolvedSku,
    description: plainDesc || null,
    brand: brand || null,
    model: model || null,
    gtin: gtin || null,
    ncm: resolveMercadoLivreNcm(item),
    seo_keywords: resolveMercadoLivreCommercialSeoKeywords(item, pickAttrValue),
    category_ml_id: item?.category_id != null ? String(item.category_id) : null,
    ad_titles: normalizeAdTitles([{ value: title || resolvedSku }]),
    product_images,
    picture_urls: pictures,
    stock_quantity: resolveMercadoLivreAvailableStock(item),
    stock_source: "marketplace",
    ...shippingDims,
    ...assembledDims,
    listing_status: item?.status != null ? String(item.status) : null,
    listing_sold_quantity: parseIntOrNull(item?.sold_quantity) ?? 0,
    listing_last_updated: item?.last_updated != null ? String(item.last_updated) : null,
    listing_date_created: item?.date_created != null ? String(item.date_created) : null,
  };
}
