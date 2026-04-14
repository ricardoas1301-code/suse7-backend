// ======================================================
// Helpers compartilhados — preço/tarifa do anúncio ML (grid + repasse unitário).
// ======================================================

import {
  coalesceMercadoLibreItemForMoneyExtract,
  extractPromotionPrice,
  extractSaleFee,
  extractShippingCost,
} from "./mlItemMoneyExtract.js";

/**
 * Converte valores vindos do DB/payload (number, string pt-BR ou US) em número finito.
 * @param {unknown} v
 * @returns {number | null}
 */
export function mercadoLivreToFiniteGrid(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const raw = String(v).trim();
  if (!raw) return null;
  let s = raw;
  if (s.includes(",") && !s.includes(".")) {
    s = s.replace(",", ".");
  } else if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Prioriza snapshot da API (`raw_json`) sobre colunas Supabase ao mesclar escalares de preço.
 * @param {unknown} rawVal
 * @param {unknown} listingVal
 * @param {unknown} healthVal
 */
function coalesceMlPriceScalar(rawVal, listingVal, healthVal) {
  for (const v of [rawVal, listingVal, healthVal]) {
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return v;
  }
  for (const v of [rawVal, listingVal, healthVal]) {
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return v;
  }
  return undefined;
}

/** @param {unknown} v */
function isUsableSaleFeeDetails(v) {
  if (v == null || v === "") return false;
  if (typeof v === "boolean") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(/** @type {Record<string, unknown>} */ (v)).length > 0;
  return typeof v === "string";
}

/** @param {unknown} v @param {number} max */
function jsonSnippetSafe(v, max = 900) {
  try {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(v);
  }
}

/** @param {...unknown} cands */
function pickUsableSaleFeeDetails(...cands) {
  for (const c of cands) {
    if (isUsableSaleFeeDetails(c)) return c;
  }
  return undefined;
}

/**
 * `sale_fee_details` da linha GET listing_prices persistida em `marketplace_listing_health.raw_json.raw_payloads`.
 * Contém o breakdown do Raio-X (tarifa + linha logística). **Não** misturar no shape do item usado por
 * `extractSaleFee` — lá comissão e logística seriam somadas num único “amount” errado.
 *
 * @param {Record<string, unknown> | null | undefined} health
 */
export function mercadoLivreListingPricesRowSaleFeeDetails(health) {
  if (!health || typeof health !== "object") return undefined;
  const hr = health.raw_json;
  if (!hr || typeof hr !== "object" || Array.isArray(hr)) return undefined;
  const payloads = /** @type {Record<string, unknown>} */ (hr).raw_payloads;
  if (!payloads || typeof payloads !== "object" || Array.isArray(payloads)) return undefined;
  const lpRow = payloads.listing_prices_row;
  if (!lpRow || typeof lpRow !== "object" || Array.isArray(lpRow)) return undefined;
  const sfd = /** @type {Record<string, unknown>} */ (lpRow).sale_fee_details;
  return isUsableSaleFeeDetails(sfd) ? sfd : undefined;
}

/**
 * Diagnóstico do coalesce (terminal) — paths reais e valores extraídos.
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} health
 */
export function mercadoLivreMoneyShapeDiagnostics(listing, health) {
  const fromHealth = mercadoLivreMoneyFieldsFromHealthRaw(health);
  const hr = health?.raw_json;
  const hasHealthRawJson = Boolean(hr && typeof hr === "object" && !Array.isArray(hr));
  /** @type {Record<string, unknown> | null} */
  let excerpt = null;
  if (hasHealthRawJson) {
    const r = /** @type {Record<string, unknown>} */ (hr);
    excerpt =
      r.item_excerpt && typeof r.item_excerpt === "object" && !Array.isArray(r.item_excerpt)
        ? /** @type {Record<string, unknown>} */ (r.item_excerpt)
        : null;
  }
  const hasItemExcerpt = Boolean(excerpt);

  const raw =
    listing.raw_json && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : /** @type {Record<string, unknown>} */ ({});

  /** @type {string | null} */
  let saleFeePath = null;
  let saleFeeSnippet = null;
  if (isUsableSaleFeeDetails(raw.sale_fee_details)) {
    saleFeePath = "listing.raw_json.sale_fee_details";
    saleFeeSnippet = jsonSnippetSafe(raw.sale_fee_details);
  } else if (/** @type {unknown} */ (listing).sale_fee_details != null && isUsableSaleFeeDetails(listing.sale_fee_details)) {
    saleFeePath = "listing.sale_fee_details";
    saleFeeSnippet = jsonSnippetSafe(listing.sale_fee_details);
  } else if (excerpt && isUsableSaleFeeDetails(excerpt.sale_fee_details)) {
    saleFeePath = "health.raw_json.item_excerpt.sale_fee_details";
    saleFeeSnippet = jsonSnippetSafe(excerpt.sale_fee_details);
  } else if (hasHealthRawJson && isUsableSaleFeeDetails(/** @type {Record<string, unknown>} */ (hr).sale_fee_details)) {
    saleFeePath = "health.raw_json.sale_fee_details";
    saleFeeSnippet = jsonSnippetSafe(/** @type {Record<string, unknown>} */ (hr).sale_fee_details);
  }

  /** @type {string | null} */
  let shippingPath = null;
  if (listing.shipping && typeof listing.shipping === "object") shippingPath = "listing.shipping";
  else if (raw.shipping && typeof raw.shipping === "object") shippingPath = "listing.raw_json.shipping";
  else if (fromHealth.shipping && typeof fromHealth.shipping === "object") {
    shippingPath = "health.raw_json.item_excerpt.shipping";
  }

  const preCoalesce = mercadoLivreListingPayloadForMoneyFields(listing, health);
  const payloadFinal = coalesceMercadoLibreItemForMoneyExtract(preCoalesce);
  const feeFull = extractSaleFee(payloadFinal, { listing, health });
  const feeNoDerive = extractSaleFee(payloadFinal, { deriveFromPercent: false, listing, health });
  const ship = extractShippingCost(payloadFinal);
  const promo = extractPromotionPrice(payloadFinal);

  return {
    has_health_raw_json: hasHealthRawJson,
    has_item_excerpt: hasItemExcerpt,
    sale_fee_path_resolved: saleFeePath,
    sale_fee_details_snippet: saleFeeSnippet,
    shipping_path_resolved: shippingPath,
    shipping_excerpt_snippet:
      fromHealth.shipping && typeof fromHealth.shipping === "object"
        ? jsonSnippetSafe(fromHealth.shipping, 400)
        : null,
    promotion_price_resolved: promo,
    original_price_resolved: payloadFinal.original_price ?? null,
    sale_fee_amount_root_after_merge: payloadFinal.sale_fee_amount ?? null,
    extract_sale_fee_with_derive: feeFull,
    extract_sale_fee_no_derive: feeNoDerive,
    shipping_cost_resolved: ship,
  };
}

/**
 * Lê recortes gravados em marketplace_listing_health.raw_json (item_excerpt + duplicatas)
 * quando o listing principal não expõe taxa/frete no nível raiz.
 * @param {Record<string, unknown> | null | undefined} health — linha health do join (incl. raw_json).
 */
export function mercadoLivreMoneyFieldsFromHealthRaw(health) {
  if (!health || typeof health !== "object") return {};
  const out = /** @type {Record<string, unknown>} */ ({});
  const hr = health.raw_json;
  if (!hr || typeof hr !== "object" || Array.isArray(hr)) return out;
  const r = /** @type {Record<string, unknown>} */ (hr);
  const excerpt =
    r.item_excerpt && typeof r.item_excerpt === "object" && !Array.isArray(r.item_excerpt)
      ? /** @type {Record<string, unknown>} */ (r.item_excerpt)
      : null;

  const sfd = excerpt?.sale_fee_details ?? r.sale_fee_details;
  if (sfd != null) out.sale_fee_details = sfd;

  if (excerpt?.sale_fee_amount != null) out.sale_fee_amount = excerpt.sale_fee_amount;
  else if (r.sale_fee_amount != null) out.sale_fee_amount = r.sale_fee_amount;

  const shEx = excerpt?.shipping;
  if (shEx && typeof shEx === "object" && !Array.isArray(shEx)) {
    out.shipping = shEx;
  }

  if (excerpt?.price != null) out.price = excerpt.price;
  if (excerpt?.original_price != null) out.original_price = excerpt.original_price;
  if (excerpt?.base_price != null) out.base_price = excerpt.base_price;
  if (excerpt?.currency_id != null) out.currency_id = excerpt.currency_id;

  return out;
}

/**
 * Mescla colunas persistidas com raw_json do listing + recortes do health (sync_compare / item_excerpt).
 * @param {Record<string, unknown>} listing
 * @param {Record<string, unknown> | null | undefined} [health]
 */
export function mercadoLivreListingPayloadForMoneyFields(listing, health) {
  const raw =
    listing.raw_json && typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : {};
  const fromHealth = mercadoLivreMoneyFieldsFromHealthRaw(health);

  const listingShip = listing.shipping;
  const rawShip = raw.shipping;
  const healthShip = fromHealth.shipping;
  const shipping =
    listingShip && typeof listingShip === "object"
      ? listingShip
      : rawShip && typeof rawShip === "object"
        ? rawShip
        : healthShip && typeof healthShip === "object"
          ? healthShip
          : null;

  const saleFeeDetailsMerged = pickUsableSaleFeeDetails(
    raw.sale_fee_details,
    /** @type {Record<string, unknown>} */ (listing).sale_fee_details,
    fromHealth.sale_fee_details
  );

  const saleFeeAmtMerged = (() => {
    for (const v of [
      raw.sale_fee_amount,
      /** @type {Record<string, unknown>} */ (listing).sale_fee_amount,
      fromHealth.sale_fee_amount,
    ]) {
      const n = typeof v === "number" ? v : v != null && v !== "" ? Number(v) : NaN;
      if (Number.isFinite(n) && n > 0) return v;
    }
    return undefined;
  })();

  return {
    ...raw,
    prices: raw.prices ?? listing.prices,
    price: coalesceMlPriceScalar(raw.price, listing.price, fromHealth.price),
    original_price: coalesceMlPriceScalar(
      raw.original_price,
      listing.original_price,
      fromHealth.original_price
    ),
    base_price: coalesceMlPriceScalar(raw.base_price, listing.base_price, fromHealth.base_price),
    currency_id: listing.currency_id ?? raw.currency_id ?? fromHealth.currency_id,
    sale_fee_details: saleFeeDetailsMerged,
    sale_fee_amount: saleFeeAmtMerged ?? raw.sale_fee_amount ?? /** @type {Record<string, unknown>} */ (listing).sale_fee_amount ?? fromHealth.sale_fee_amount,
    seller_net_amount: listing.seller_net_amount ?? raw.seller_net_amount,
    net_sale_amount: listing.net_sale_amount ?? raw.net_sale_amount,
    shipping: shipping ?? undefined,
  };
}

/**
 * Preço de vitrine: colunas normalizadas (sync) com fallback ML (base/original).
 * @param {Record<string, unknown>} listing
 */
export function mercadoLivrePickListingPriceCandidate(listing) {
  const keys = /** @type {const} */ (["price", "base_price", "original_price"]);
  for (const k of keys) {
    const v = listing?.[k];
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return v;
  }
  for (const k of keys) {
    const v = listing?.[k];
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return v;
  }

  const raw = listing?.raw_json;
  if (raw && typeof raw === "object") {
    const r = /** @type {Record<string, unknown>} */ (raw);
    for (const k of keys) {
      const v = r[k];
      if (v == null || v === "") continue;
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n > 0) return v;
    }
    for (const k of keys) {
      const v = r[k];
      if (v == null || v === "") continue;
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) return v;
    }
  }
  return null;
}
