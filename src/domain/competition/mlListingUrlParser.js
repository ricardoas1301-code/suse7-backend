// ============================================================
// S7 — Concorrência: extrai MLB… de URLs do Mercado Livre.
// Diferencia item_id (anúncio) vs product_id (catálogo /p/MLB…).
// Sem scraping — apenas parsing de URL/path/query.
// ============================================================

import {
  logCompetitionLinkParse,
  logCompetitionLinkParseWarning,
} from "./competitionLinkParseAudit.js";

const ML_HOST_RE = /mercadolivre\.com|mercadolibre\.com/i;

/** Anúncio: MLB + 10–13 dígitos (padrão atual ML Brasil). */
export const MLB_ITEM_DIGITS_MIN = 10;
export const MLB_ITEM_DIGITS_MAX = 13;

const ITEM_ID_RE = /ML([ABCU])[-_]?(\d{8,13})/gi;
const CATALOG_ID_RE = /(ML[ABCU](?:[A-Z])?\d+)/i;
const CATALOG_P_RE = new RegExp(`/p/${CATALOG_ID_RE.source}`, "i");
const CATALOG_UP_RE = new RegExp(`/up/${CATALOG_ID_RE.source}`, "i");

/**
 * @typedef {'item' | 'catalog_product' | 'slug_only' | 'unknown'} MlListingIdType
 */

function formatMlId(siteLetter, digits) {
  return `ML${String(siteLetter).toUpperCase()}${String(digits)}`;
}

export function countMercadoLivreIdDigits(id) {
  const m = String(id || "")
    .trim()
    .toUpperCase()
    .match(/^ML[ABCU](\d+)$/);
  return m ? m[1].length : 0;
}

/** Formato MLB + dígitos com comprimento de anúncio (não catálogo curto). */
export function isValidMercadoLivreItemListingId(id) {
  const s = String(id || "").trim().toUpperCase();
  if (!/^ML[ABCU]\d+$/.test(s)) return false;
  const len = countMercadoLivreIdDigits(s);
  return len >= MLB_ITEM_DIGITS_MIN && len <= MLB_ITEM_DIGITS_MAX;
}

/** MLB + dígitos (qualquer comprimento usado em catálogo /p/). */
export function isValidMercadoLivreCatalogProductId(id) {
  const s = String(id || "").trim().toUpperCase();
  if (!/^ML[ABCU]\d{6,13}$/.test(s)) return false;
  return !isValidMercadoLivreItemListingId(s);
}

function normalizeUrlInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.includes("mercadolivre") || s.includes("mercadolibre")) return `https://${s}`;
  return s;
}

/** Match dentro de segmento /p/MLB… — é catálogo, nunca item. */
function isCatalogPathMatch(text, match) {
  const start = match.index ?? 0;
  const windowStart = Math.max(0, start - 3);
  const slice = String(text).slice(windowStart, start + match[0].length);
  return /\/p\/ML[ABCU]/i.test(slice);
}

/**
 * Extrai candidatos a item_id ignorando /p/MLB… e priorizando IDs mais longos.
 * @param {string} text
 * @returns {string | null}
 */
function bestItemIdInText(text) {
  const src = String(text || "");
  const candidates = [];
  for (const m of src.matchAll(ITEM_ID_RE)) {
    if (isCatalogPathMatch(src, m)) continue;
    const digits = m[2];
    candidates.push({
      id: formatMlId(m[1], digits),
      digits: digits.length,
      index: m.index ?? 0,
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.digits - a.digits || a.index - b.index);
  const best = candidates[0];
  if (isValidMercadoLivreItemListingId(best.id)) return best.id;
  if (best.digits >= MLB_ITEM_DIGITS_MIN) return best.id;
  return null;
}

function catalogIdInText(text) {
  const src = String(text || "");
  const m = src.match(CATALOG_P_RE) || src.match(CATALOG_UP_RE);
  if (!m?.[1]) return null;
  return String(m[1]).toUpperCase();
}

/**
 * @param {string} id
 * @returns {'valid_item' | 'valid_catalog' | 'invalid_format' | 'invalid_length'}
 */
export function validateMercadoLivreListingIdFormat(id) {
  const s = String(id || "").trim().toUpperCase();
  if (!/^ML[ABCU]\d+$/.test(s)) return "invalid_format";
  if (isValidMercadoLivreItemListingId(s)) return "valid_item";
  if (isValidMercadoLivreCatalogProductId(s)) return "valid_catalog";
  return "invalid_length";
}

export function extractSlugQueryFromMercadoLivreUrl(urlInput) {
  const raw = String(urlInput || "").trim();
  if (!raw) return null;

  try {
    const withProto = raw.startsWith("http") ? raw : `https://${raw}`;
    const u = new URL(withProto);
    const path = decodeURIComponent(u.pathname);

    let m = path.match(/ML[ABCU]-?\d{6,}-(.+)/i);
    if (m?.[1]) {
      return m[1].replace(/-/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    }

    m = path.match(/^\/([^/]+)\/p\/ML[ABCU]/i);
    if (m?.[1] && !/^ML[ABCU]/i.test(m[1])) {
      return m[1].replace(/-/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    }

    const segments = path.split("/").filter(Boolean);
    for (const seg of segments) {
      if (/^p$/i.test(seg)) continue;
      if (/^ML[ABCU]/i.test(seg)) continue;
      if (seg.includes("-") && seg.length > 6) {
        return seg.replace(/-/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function detectIdType(url, catalogProductId, itemId) {
  if (itemId) return "item";
  if (catalogProductId) return "catalog_product";
  const path = `${url.pathname}${url.hash}`.toLowerCase();
  if (/\/p\/ML[abcu]/i.test(path)) return "catalog_product";
  if (url.hostname.toLowerCase().startsWith("produto.")) return "item";
  return "unknown";
}

function itemIdFromQueryParams(url) {
  const safeDecode = (value) => {
    try {
      return decodeURIComponent(String(value ?? ""));
    } catch {
      return String(value ?? "");
    }
  };

  const directItem = url.searchParams.get("item_id");
  if (directItem) {
    const fromDirect = bestItemIdInText(directItem);
    if (fromDirect) return { itemId: fromDirect, parseStrategy: "query_item_id" };
  }

  // Mercado Livre catálogo: /p/MLB... com item real em pdp_filters=item_id:MLB...
  const pdpFiltersRaw = url.searchParams.get("pdp_filters");
  if (pdpFiltersRaw) {
    const decoded = safeDecode(pdpFiltersRaw);
    const fromPdp = bestItemIdInText(decoded);
    if (fromPdp) return { itemId: fromPdp, parseStrategy: "query_pdp_filters_item_id" };
  }

  // Guard-rail para casos em que a string encoded chega fora do parser padrão.
  const hrefDecoded = safeDecode(url.href || "");
  const fromHrefPdp = bestItemIdInText(hrefDecoded.match(/pdp_filters=[^&#]*/i)?.[0] ?? "");
  if (fromHrefPdp) return { itemId: fromHrefPdp, parseStrategy: "href_pdp_filters_item_id" };

  // wid/item entram como fallback para confirmar item real quando não veio no pdp_filters.
  for (const key of ["wid", "item"]) {
    const q = url.searchParams.get(key);
    if (!q) continue;
    const fromQ = bestItemIdInText(q);
    if (fromQ) return { itemId: fromQ, parseStrategy: `query_${key}` };
  }

  const idQ = url.searchParams.get("id");
  if (idQ) {
    const fromQ = bestItemIdInText(idQ);
    if (fromQ) return { itemId: fromQ, parseStrategy: "query_id" };
  }
  return { itemId: null, parseStrategy: null };
}

let _parseAuditMuted = false;

function emitParseAudit(rawUrl, result) {
  if (_parseAuditMuted) return;
  if (!result.ok) {
    logCompetitionLinkParse({
      original_url: rawUrl,
      parser_detected_type: result.code ?? "error",
      extracted_item_id: null,
      extracted_catalog_id: null,
      validation_result: "parse_failed",
    });
    return;
  }

  const validation =
    result.itemId != null
      ? validateMercadoLivreListingIdFormat(result.itemId)
      : result.catalogProductId != null
        ? validateMercadoLivreListingIdFormat(result.catalogProductId)
        : result.idType;

  logCompetitionLinkParse({
    original_url: rawUrl,
    parser_detected_type: result.idType,
    extracted_item_id: result.itemId ?? null,
    extracted_catalog_id: result.catalogProductId ?? null,
    validation_result: validation,
    parse_strategy: result.parseStrategy ?? null,
    host_kind: result.hostKind ?? null,
  });

  if (result.catalogProductId && result.itemId === result.catalogProductId) {
    logCompetitionLinkParseWarning({
      original_url: rawUrl,
      parsed_value: result.itemId,
      expected_pattern: "catalog_product_id_without_item_id",
      reason: "catalog_id_must_not_duplicate_as_item_id",
    });
  }
}

/** Alias — mesmo contrato de parseMercadoLivreListingUrl. */
export function parseCompetitionLink(urlInput) {
  return parseMercadoLivreListingUrl(urlInput);
}

export function parseMercadoLivreListingUrl(urlInput, opts = {}) {
  const prevMuted = _parseAuditMuted;
  _parseAuditMuted = opts?.skipAudit === true;
  try {
  const raw = String(urlInput || "").trim();
  if (!raw) {
    const fail = { ok: false, error: "Informe o link do anúncio.", code: "url_empty" };
    emitParseAudit(raw, fail);
    return fail;
  }

  const normalizedUrl = normalizeUrlInput(raw);

  // ID direto colado (MLB1234567890).
  if (!raw.includes("://") && !raw.includes("mercadolivre") && !raw.includes("mercadolibre")) {
    const directUpper = raw.toUpperCase();
    if (/^ML[ABCU]\d+$/.test(directUpper)) {
      const fmt = directUpper;
      const validation = validateMercadoLivreListingIdFormat(fmt);
      if (validation === "valid_item") {
        const ok = {
          ok: true,
          id: fmt,
          itemId: fmt,
          catalogProductId: null,
          idType: "item",
          source: "raw_id",
          parseStrategy: "raw_id_direct",
          hostKind: null,
          pathHint: null,
          normalizedUrl: raw,
          slug: null,
        };
        emitParseAudit(raw, ok);
        return ok;
      }
      if (validation === "valid_catalog") {
        const ok = {
          ok: true,
          id: fmt,
          itemId: null,
          catalogProductId: fmt,
          idType: "catalog_product",
          source: "raw_id",
          parseStrategy: "raw_id_catalog",
          hostKind: null,
          pathHint: null,
          normalizedUrl: raw,
          slug: null,
        };
        emitParseAudit(raw, ok);
        return ok;
      }
      const fail = {
        ok: false,
        error: "ID do Mercado Livre inválido. Use o link completo do anúncio.",
        code: "invalid_id_format",
      };
      logCompetitionLinkParseWarning({
        original_url: raw,
        parsed_value: fmt,
        expected_pattern: `MLB + ${MLB_ITEM_DIGITS_MIN}-${MLB_ITEM_DIGITS_MAX} dígitos (item)`,
        reason: validation,
      });
      emitParseAudit(raw, fail);
      return fail;
    }

    const fromText = bestItemIdInText(raw);
    if (fromText) {
      const ok = {
        ok: true,
        id: fromText,
        itemId: fromText,
        catalogProductId: null,
        idType: "item",
        source: "raw_id",
        parseStrategy: "raw_id_regex",
        hostKind: null,
        pathHint: null,
        normalizedUrl: raw,
        slug: null,
      };
      emitParseAudit(raw, ok);
      return ok;
    }

    const fail = { ok: false, error: "Link inválido. Cole uma URL do Mercado Livre.", code: "url_invalid" };
    emitParseAudit(raw, fail);
    return fail;
  }

  let url;
  try {
    url = new URL(normalizedUrl.startsWith("http") ? normalizedUrl : `https://${normalizedUrl}`);
  } catch {
    const fallback = bestItemIdInText(raw);
    if (fallback) {
      const ok = {
        ok: true,
        id: fallback,
        itemId: fallback,
        catalogProductId: null,
        idType: "item",
        source: "fallback_text",
        parseStrategy: "href_global_regex",
        hostKind: null,
        pathHint: null,
        normalizedUrl: raw,
        slug: extractSlugQueryFromMercadoLivreUrl(raw),
      };
      emitParseAudit(raw, ok);
      return ok;
    }
    const slug = extractSlugQueryFromMercadoLivreUrl(raw);
    if (slug) {
      const ok = {
        ok: true,
        id: null,
        itemId: null,
        catalogProductId: null,
        idType: "slug_only",
        source: "slug_text",
        parseStrategy: "slug_from_invalid_url",
        hostKind: null,
        pathHint: null,
        normalizedUrl: raw,
        slug,
      };
      emitParseAudit(raw, ok);
      return ok;
    }
    const fail = { ok: false, error: "Link inválido. Verifique a URL e tente novamente.", code: "url_invalid" };
    emitParseAudit(raw, fail);
    return fail;
  }

  const host = url.hostname.toLowerCase();
  if (!ML_HOST_RE.test(host)) {
    const fail = { ok: false, error: "Este link não é do Mercado Livre.", code: "not_mercado_livre" };
    emitParseAudit(raw, fail);
    return fail;
  }

  const hostKind = host.startsWith("produto.")
    ? "produto"
    : host.startsWith("articulo.")
      ? "articulo"
      : host.startsWith("m.")
        ? "mobile"
        : "www";

  const href = url.href;
  const pathAndHash = `${url.pathname}${url.hash}`;

  const catalogProductId = catalogIdInText(pathAndHash) || catalogIdInText(href);

  let itemId = null;
  let parseStrategy = "path_regex";

  const fromQuery = itemIdFromQueryParams(url);
  if (fromQuery.itemId) {
    itemId = fromQuery.itemId;
    parseStrategy = fromQuery.parseStrategy;
  }

  if (!itemId) {
    itemId = bestItemIdInText(pathAndHash);
    if (itemId) parseStrategy = hostKind === "produto" || hostKind === "articulo" ? "path_produto_item" : "path_item";
  }

  if (!itemId && hostKind === "mobile") {
    itemId = bestItemIdInText(href);
    if (itemId) parseStrategy = "mobile_path_item";
  }

  // Nunca promover catalogProductId a itemId (bug MLB51850422 vs MLB5464607744).
  if (itemId && catalogProductId && itemId === catalogProductId) {
    logCompetitionLinkParseWarning({
      original_url: raw,
      parsed_value: itemId,
      expected_pattern: "catalog_resolve_or_produto_path_item",
      reason: "catalog_path_id_excluded_from_item_id",
    });
    itemId = null;
    parseStrategy = "catalog_only";
  }

  const slug = extractSlugQueryFromMercadoLivreUrl(href);
  const idType = itemId
    ? "item"
    : catalogProductId
      ? "catalog_product"
      : slug
        ? "slug_only"
        : detectIdType(url, catalogProductId, itemId);

  if (itemId || catalogProductId) {
    const primaryId = itemId || catalogProductId;
    const ok = {
      ok: true,
      id: primaryId,
      itemId,
      catalogProductId,
      idType: itemId ? "item" : "catalog_product",
      source: parseStrategy.startsWith("query") ? parseStrategy : "path",
      parseStrategy,
      hostKind,
      pathHint: url.pathname,
      normalizedUrl: url.href,
      slug,
    };
    emitParseAudit(raw, ok);
    return ok;
  }

  if (slug) {
    const ok = {
      ok: true,
      id: null,
      itemId: null,
      catalogProductId: null,
      idType: "slug_only",
      source: "slug_path",
      parseStrategy: "slug_only",
      hostKind,
      pathHint: url.pathname,
      normalizedUrl: url.href,
      slug,
    };
    emitParseAudit(raw, ok);
    return ok;
  }

  const fail = {
    ok: false,
    error: "Não foi possível identificar o anúncio neste link. Verifique se é um link de produto.",
    code: "item_id_not_found",
    slug: null,
    normalizedUrl: url.href,
  };
  emitParseAudit(raw, fail);
  return fail;
  } finally {
    _parseAuditMuted = prevMuted;
  }
}

/**
 * Corrige listing_id quando permalink aponta para outro anúncio (pós-enrich).
 * @param {Record<string, unknown> | null | undefined} candidate
 * @param {string} originalUrl
 */
export function reconcileCandidateListingIdFromPermalink(candidate, originalUrl) {
  if (!candidate || typeof candidate !== "object") return candidate;
  const current = candidate.competitor_listing_id != null ? String(candidate.competitor_listing_id).trim() : null;
  const perm = candidate.competitor_permalink != null ? String(candidate.competitor_permalink).trim() : null;
  if (!perm) return candidate;

  const parsedPerm = parseMercadoLivreListingUrl(perm, { skipAudit: true });
  if (!parsedPerm.ok || !parsedPerm.itemId) return candidate;
  if (!isValidMercadoLivreItemListingId(parsedPerm.itemId)) return candidate;
  if (current === parsedPerm.itemId) return candidate;

  logCompetitionLinkParseWarning({
    original_url: originalUrl,
    parsed_value: current,
    expected_pattern: parsedPerm.itemId,
    reason: "listing_id_permalink_mismatch_reconciled",
  });

  return { ...candidate, competitor_listing_id: parsedPerm.itemId };
}

/** @deprecated Use parseMercadoLivreListingUrl */
export function extractItemIdFromMercadoLivreUrl(urlInput) {
  const parsed = parseMercadoLivreListingUrl(urlInput);
  if (!parsed.ok) return parsed;
  return { ok: true, itemId: parsed.itemId ?? parsed.id, source: parsed.source };
}

export function safeUrlHostForLog(urlInput) {
  try {
    const raw = String(urlInput || "").trim();
    const withProto = raw.startsWith("http") ? raw : `https://${raw}`;
    return new URL(withProto).hostname;
  } catch {
    return null;
  }
}
