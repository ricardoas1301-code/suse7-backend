// ======================================================================
// SEO comercial — Mercado Livre (sem tags técnicas internas do ML).
// ======================================================================

/** Tags operacionais do ML — não são palavras-chave comerciais do seller. */
export const ML_INTERNAL_LISTING_TAGS = new Set([
  "good_quality_thumbnail",
  "standard_price_by_quantity",
  "user_product_listing",
  "immediate_payment",
  "cart_eligible",
  "loyalty_discount_eligible",
  "brand_verified",
  "cbt_item",
  "cbt_fulfillment_us",
  "test_item",
  "dragged_bids_and_visits",
  "poor_quality_thumbnail",
  "incomplete_technical_specs",
  "extended_warranty_eligible",
]);

const SEO_STOP_WORDS = new Set([
  "de",
  "do",
  "da",
  "dos",
  "das",
  "com",
  "em",
  "para",
  "por",
  "o",
  "a",
  "os",
  "as",
  "e",
  "um",
  "uma",
  "no",
  "na",
  "nos",
  "nas",
]);

/** @param {unknown} tag */
export function isMercadoLivreInternalListingTag(tag) {
  const t = String(tag ?? "")
    .trim()
    .toLowerCase();
  if (!t) return true;
  return ML_INTERNAL_LISTING_TAGS.has(t);
}

/** @param {unknown} text */
function looksLikeInternalTagList(text) {
  const parts = String(text ?? "")
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => isMercadoLivreInternalListingTag(p));
}

/** @param {string} text */
function normalizeSeoText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deriva keywords comerciais em português a partir do título/marca do anúncio.
 * @param {string} title
 * @param {string | null | undefined} brand
 * @returns {string | null}
 */
export function deriveCommercialSeoKeywordsFromListingTitle(title, brand) {
  const cleanTitle = String(title ?? "").trim();
  if (!cleanTitle) return null;

  const words = normalizeSeoText(cleanTitle).split(" ").filter(Boolean);
  if (words.length === 0) return null;

  /** @type {Set<string>} */
  const phrases = new Set();

  for (let start = 0; start < words.length; start += 1) {
    for (let len = 2; len <= Math.min(5, words.length - start); len += 1) {
      const slice = words.slice(start, start + len);
      const meaningful = slice.filter((w) => !SEO_STOP_WORDS.has(w));
      if (meaningful.length < 2) continue;
      const phrase = slice.join(" ");
      if (phrase.length >= 6 && !isMercadoLivreInternalListingTag(phrase)) {
        phrases.add(phrase);
      }
    }
  }

  for (const w of words) {
    if (w.length >= 4 && !SEO_STOP_WORDS.has(w) && !isMercadoLivreInternalListingTag(w)) {
      phrases.add(w);
    }
  }

  const brandNorm = brand ? normalizeSeoText(brand) : "";
  if (brandNorm) {
    phrases.add(brandNorm);
    const firstMeaningful = words.find((w) => w.length >= 3 && !SEO_STOP_WORDS.has(w));
    if (firstMeaningful) {
      phrases.add(`${firstMeaningful} ${brandNorm}`);
    }
  }

  /** Frases do início do título têm prioridade (tipo de produto). */
  const priority = [];
  for (const len of [2, 3, 4, 5]) {
    if (words.length >= len) priority.push(words.slice(0, len).join(" "));
  }

  const rest = [...phrases].filter((p) => !priority.includes(p));
  const picked = [...new Set([...priority, ...rest])]
    .filter((p) => p.length >= 4 && !isMercadoLivreInternalListingTag(p))
    .slice(0, 8);

  return picked.length ? picked.join(", ").slice(0, 500) : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} item
 * @param {(item: Record<string, unknown> | null | undefined, ids: string[]) => string | null} pickAttrValue
 */
export function resolveMercadoLivreCommercialSeoKeywords(item, pickAttrValue) {
  const fromAttr = pickAttrValue(item, [
    "PRODUCT_KEYWORDS",
    "SEARCH_KEYWORDS",
    "KEYWORDS",
    "SEO_KEYWORDS",
  ]);
  if (fromAttr && !looksLikeInternalTagList(fromAttr)) {
    return fromAttr.slice(0, 500);
  }

  const brand = pickAttrValue(item, ["BRAND", "MANUFACTURER"]);
  const title = item?.title != null ? String(item.title).trim() : "";
  return deriveCommercialSeoKeywordsFromListingTitle(title, brand);
}
