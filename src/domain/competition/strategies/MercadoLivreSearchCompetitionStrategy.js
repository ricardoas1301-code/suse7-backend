// ============================================================
// S7 — Concorrência: busca por PALAVRA-CHAVE (Mercado Livre / Fluxo B)
//
// Modo AMPLO (busca comercial paginada — estilo comprador):
//   GET /products/search?q={termo}&offset={n}&limit=20  → até 5 páginas
//   Para cada produto de catálogo: GET /products/{id}/items + fallback buy_box_winner
//   Ordenação leve por relevância (material/tipo) — sem descartar por score.
//
// Modo LEGADO (fallback automático do engine, sem paginação):
//   Tentativas progressivas (GTIN → título → reduzidas) com teto de produtos.
//
// CRÍTICO: /sites/$SITE/search foi DESCONTINUADO (403).
// CRÍTICO: multiget /items?ids= não é obrigatório — rows de /products/{id}/items bastam.
// ============================================================

import { CompetitionDiscoveryStrategy } from "../CompetitionDiscoveryStrategy.js";
import {
  searchCatalogProducts,
  fetchCatalogProduct,
  fetchCatalogProductItemsSafe,
  fetchItem,
} from "../../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import { normalizeDiscoveredCompetitor } from "../competitionNormalizer.js";
import {
  mlItemBodyToCandidateRaw,
  mlCatalogItemRowToCandidateRaw,
  mlBuyBoxWinnerToCandidateRaw,
  pickCatalogProductThumbnail,
  collectRelatedCatalogProductIds,
  isOwnCandidate,
} from "./mlCompetitorMapping.js";
import { resolveMlCompetitorEffectivePrice } from "../mlCompetitorEffectivePrice.js";
import { sortCandidatesByRelevance, scoreCandidateRelevance } from "./mlCompetitorRelevance.js";
import {
  logSalesRawCatalogItemRow,
  logSalesRawCatalogSearch,
  logSalesRawMl,
} from "../competitionSalesMlAudit.js";

const ML_SITE_ID = "MLB";
const CATALOG_PAGE_SIZE = 20;
const MAX_CATALOG_PAGES = 5;
const MAX_CATALOG_OFFSET = (MAX_CATALOG_PAGES - 1) * CATALOG_PAGE_SIZE;
const MAX_PRODUCTS_LEGACY = 8;
const MAX_RELATED_PRODUCTS = 4;
const ITEMS_FETCH_CONCURRENCY = 6;

const STOPWORDS = new Set([
  "de", "da", "do", "das", "dos", "com", "sem", "para", "pra", "e", "em",
  "a", "o", "as", "os", "no", "na", "nos", "nas", "por", "ao", "à", "the",
]);
const GENERIC_TERMS = new Set([
  "moderna", "moderno", "luxo", "premium", "top", "kit", "novo", "nova",
  "original", "promocao", "promocional", "oferta", "super", "mega", "ultra",
]);

function significantWords(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function buildPrimaryQuery(context) {
  const explicit = context?.query != null ? String(context.query).trim() : "";
  if (explicit) return explicit;
  const gtin = context?.listing?.gtin != null ? String(context.listing.gtin).trim() : "";
  if (gtin) return gtin;
  const title = context?.listing?.title != null ? String(context.listing.title).trim() : "";
  if (title) return title;
  return context?.product?.product_name != null ? String(context.product.product_name).trim() : "";
}

function buildAttempts(context) {
  const explicit = context?.query != null ? String(context.query).trim() : "";
  const gtin = context?.listing?.gtin != null ? String(context.listing.gtin).trim() : "";
  const title = context?.listing?.title != null ? String(context.listing.title).trim() : "";
  const name = context?.product?.product_name != null ? String(context.product.product_name).trim() : "";
  const primary = explicit || title || name;
  const textBase = explicit || title || name;

  const out = [];
  const seen = new Set();
  const push = (attempt) => {
    const key = `${attempt.productIdentifier || ""}::${(attempt.q || "").toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(attempt);
  };

  if (gtin && !explicit) push({ q: null, productIdentifier: gtin, label: "gtin" });
  if (primary) push({ q: primary, productIdentifier: null, label: "primary" });

  const words = significantWords(textBase);
  if (words.length > 4) push({ q: words.slice(0, 4).join(" "), productIdentifier: null, label: "reduced4" });
  if (words.length > 2) push({ q: words.slice(0, 3).join(" "), productIdentifier: null, label: "reduced3" });
  const meaningful = words.filter((w) => !GENERIC_TERMS.has(w));
  if (meaningful.length >= 2) push({ q: meaningful.slice(0, 2).join(" "), productIdentifier: null, label: "core2" });

  return out;
}

function productMetaFromSearchRow(p) {
  return {
    name: p?.name != null ? String(p.name) : null,
    thumbnail: pickCatalogProductThumbnail(p),
    id: p?.id != null ? String(p.id) : null,
  };
}

function isBroadSearchMode(context) {
  if (context?.broadSearch === true) return true;
  if (context?.searchOnly === true) return true;
  const off = Number(context?.catalogOffset);
  return Number.isFinite(off) && off >= 0;
}

function acceptRaw(context, rawCand, sourceStrategy, seen, discardReasons) {
  if (!rawCand) {
    discardReasons.push({ reason: "null_raw" });
    return null;
  }
  const id = rawCand.competitor_listing_id != null ? String(rawCand.competitor_listing_id).trim() : "";
  if (!id) {
    discardReasons.push({ reason: "missing_listing_id" });
    return null;
  }
  if (isOwnCandidate(context, rawCand)) {
    discardReasons.push({ reason: "own_listing", listing_id: id });
    return null;
  }
  if (seen.has(id)) return null;
  seen.add(id);
  return normalizeDiscoveredCompetitor(rawCand, sourceStrategy);
}

async function enrichFromItemDetail(accessToken, rawCand) {
  if (!rawCand?.competitor_listing_id) return rawCand;
  try {
    const item = await fetchItem(accessToken, String(rawCand.competitor_listing_id));
    const detailed = mlItemBodyToCandidateRaw(item);
    if (!detailed) return rawCand;
    const price = await resolveMlCompetitorEffectivePrice({
      itemId: rawCand.competitor_listing_id,
      accessToken,
      itemBody: item,
      fallbackPrice: detailed.competitor_price ?? rawCand.competitor_price ?? null,
      fallbackCurrency: detailed.currency ?? rawCand.currency ?? "BRL",
      fallbackSource: "items_fallback",
    });
    return {
      ...rawCand,
      competitor_title: detailed.competitor_title ?? rawCand.competitor_title,
      competitor_store_name: detailed.competitor_store_name ?? rawCand.competitor_store_name,
      competitor_thumbnail: detailed.competitor_thumbnail ?? rawCand.competitor_thumbnail,
      competitor_permalink: detailed.competitor_permalink ?? rawCand.competitor_permalink,
      shipping: detailed.shipping ?? rawCand.shipping,
      listing_type: detailed.listing_type ?? rawCand.listing_type,
      sales_hint: detailed.sales_hint ?? rawCand.sales_hint,
      competitor_price: price.effective_price ?? detailed.competitor_price ?? rawCand.competitor_price,
      currency: price.currency_id ?? detailed.currency ?? rawCand.currency,
      reputation: detailed.reputation ?? rawCand.reputation,
    };
  } catch {
    return rawCand;
  }
}

async function collectFromCatalogProduct(accessToken, searchProduct, limit, attemptLog, { enrich = false } = {}) {
  const meta = productMetaFromSearchRow(searchProduct);
  const productId = meta.id;
  if (!productId) return { raws: [] };

  if (!Array.isArray(attemptLog.itemsCalls)) attemptLog.itemsCalls = [];

  const raws = [];
  const seenListing = new Set();
  const pushRaw = (raw, source) => {
    const id = raw?.competitor_listing_id != null ? String(raw.competitor_listing_id) : "";
    if (!id || seenListing.has(id)) return;
    seenListing.add(id);
    raws.push({ raw, source });
  };

  const itemsRes = await fetchCatalogProductItemsSafe(accessToken, productId, { limit });
  attemptLog.itemsCalls.push({
    endpoint: `/products/${productId}/items`,
    status: itemsRes.status,
    count: itemsRes.results.length,
  });
  if (itemsRes.results.length > 0) {
    const sample = itemsRes.results[0];
    logSalesRawCatalogItemRow(
      sample?.item_id ?? sample?.id ?? null,
      productId,
      sample,
      itemsRes.status
    );
  }
  for (const row of itemsRes.results) {
    pushRaw(mlCatalogItemRowToCandidateRaw(row, meta), "catalog_items_row");
  }

  if (raws.length < limit) {
    let detail = null;
    try {
      detail = await fetchCatalogProduct(accessToken, productId);
      attemptLog.detailStatus = 200;
    } catch (e) {
      attemptLog.detailStatus = e?.status ?? null;
      attemptLog.detailError = String(e?.message ?? e).slice(0, 120);
    }

    if (detail) {
      pushRaw(mlBuyBoxWinnerToCandidateRaw(detail, meta), "buy_box_winner");

      const relatedIds = collectRelatedCatalogProductIds(searchProduct, detail).filter((id) => id !== productId);
      for (const relId of relatedIds.slice(0, MAX_RELATED_PRODUCTS)) {
        if (raws.length >= limit) break;
        const relRes = await fetchCatalogProductItemsSafe(accessToken, relId, { limit });
        attemptLog.itemsCalls.push({
          endpoint: `/products/${relId}/items`,
          status: relRes.status,
          count: relRes.results.length,
          related: true,
        });
        for (const row of relRes.results) {
          pushRaw(mlCatalogItemRowToCandidateRaw(row, meta), "related_catalog_items");
        }
      }
    }
  }

  if (enrich) {
    for (let i = 0; i < raws.length; i++) {
      raws[i].raw = await enrichFromItemDetail(accessToken, raws[i].raw);
    }
  }

  return { raws };
}

/** Executa coleta em paralelo com limite de concorrência. */
async function mapPool(items, concurrency, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const part = await Promise.all(chunk.map(fn));
    out.push(...part);
  }
  return out;
}

/**
 * Busca ampla paginada — percorre páginas de catálogo até preencher `limit` candidatos únicos.
 */
async function discoverBroad(context) {
  const { accessToken } = context;
  const limit = Number(context.limit) > 0 ? Math.min(Number(context.limit), 50) : 20;
  const startCatalogOffset = Number.isFinite(Number(context.catalogOffset))
    ? Math.min(Math.max(Number(context.catalogOffset), 0), MAX_CATALOG_OFFSET)
    : 0;
  const query = buildPrimaryQuery(context);
  const debug = context?.debug && typeof context.debug === "object" ? context.debug : null;
  const excludeSet = new Set(
    (Array.isArray(context.excludeListingIds) ? context.excludeListingIds : [])
      .map((id) => String(id).trim())
      .filter(Boolean)
  );

  const attemptDebug = {
    mode: "broad",
    label: "broad_paginated",
    query,
    page: Math.floor(startCatalogOffset / CATALOG_PAGE_SIZE),
    limit,
    offset: startCatalogOffset,
    endpoint: "/products/search",
    searchStatus: null,
    productsCount: 0,
    productIds: [],
    itemIdsCount: 0,
    detailsCount: 0,
    normalizedCount: 0,
    discardReasons: [],
    itemsCalls: [],
    catalogPaging: null,
    pagesScanned: 0,
    scanEndOffset: startCatalogOffset,
  };
  if (debug) {
    debug.mode = "broad";
    debug.page = attemptDebug.page;
    debug.offset = startCatalogOffset;
    debug.limit = limit;
    if (Array.isArray(debug.attempts)) debug.attempts.push(attemptDebug);
  }

  if (!query) {
    console.info("[COMPETITION] Broad search skipped (no query)");
    return [];
  }

  if (debug && Array.isArray(debug.search_queries_attempted)) {
    debug.search_queries_attempted.push(query);
  }

  const seen = new Set([...excludeSet]);
  const discardReasons = [];
  const normalizedPool = [];
  const allRaws = [];
  let scanOffset = startCatalogOffset;
  let catalogPaging = { total: 0, offset: startCatalogOffset, limit: CATALOG_PAGE_SIZE };
  let catalogExhausted = false;

  while (normalizedPool.length < limit && scanOffset <= MAX_CATALOG_OFFSET) {
    let products = [];
    try {
      const r = await searchCatalogProducts(accessToken, {
        siteId: ML_SITE_ID,
        q: query,
        status: "active",
        limit: CATALOG_PAGE_SIZE,
        offset: scanOffset,
      });
      products = Array.isArray(r?.results) ? r.results : [];
      catalogPaging = r?.paging && typeof r.paging === "object" ? r.paging : catalogPaging;
      attemptDebug.searchStatus = 200;
      logSalesRawCatalogSearch(query, 200, products);
    } catch (e) {
      attemptDebug.searchStatus = e?.status ?? null;
      attemptDebug.searchError = String(e?.message ?? e).slice(0, 200);
      if (debug) debug.last_error = `products/search: ${String(e?.message ?? e)}`.slice(0, 200);
      console.warn("[COMPETITION] Broad products/search failed", {
        query,
        page: Math.floor(scanOffset / CATALOG_PAGE_SIZE),
        offset: scanOffset,
        status: attemptDebug.searchStatus,
      });
      catalogExhausted = true;
      break;
    }

    attemptDebug.pagesScanned += 1;
    attemptDebug.productsCount += products.length;
    for (const p of products) {
      const id = p?.id != null ? String(p.id) : null;
      if (id) attemptDebug.productIds.push(id);
    }
    attemptDebug.catalogPaging = catalogPaging;

    console.info("[COMPETITION] Broad products/search", {
      query,
      page: Math.floor(scanOffset / CATALOG_PAGE_SIZE),
      offset: scanOffset,
      status: 200,
      products: products.length,
      catalog_total: catalogPaging.total ?? null,
      pool_so_far: normalizedPool.length,
    });

    if (!products.length) {
      catalogExhausted = true;
      scanOffset += CATALOG_PAGE_SIZE;
      break;
    }

    const collected = await mapPool(products, ITEMS_FETCH_CONCURRENCY, async (p) => {
      return collectFromCatalogProduct(accessToken, p, 30, attemptDebug, { enrich: false });
    });

    for (const batch of collected) {
      for (const entry of batch.raws) {
        allRaws.push(entry);
        const cand = acceptRaw(context, entry.raw, "ml_broad_search", seen, discardReasons);
        if (cand) normalizedPool.push(cand);
      }
    }

    scanOffset += CATALOG_PAGE_SIZE;
    attemptDebug.scanEndOffset = scanOffset;

    const catalogTotal = catalogPaging.total != null ? Number(catalogPaging.total) : null;
    if (catalogTotal != null && scanOffset >= catalogTotal) {
      catalogExhausted = true;
    }
    if (scanOffset > MAX_CATALOG_OFFSET) {
      catalogExhausted = true;
    }
    if (normalizedPool.length >= limit) break;
    if (catalogExhausted) break;
  }

  attemptDebug.itemIdsCount = allRaws.length;
  if (debug) debug.raw_results_count = allRaws.length;

  console.info("[COMPETITION] Broad item rows collected", {
    query,
    start_offset: startCatalogOffset,
    end_offset: scanOffset,
    pages_scanned: attemptDebug.pagesScanned,
    item_rows: allRaws.length,
    pool: normalizedPool.length,
    items_calls: attemptDebug.itemsCalls.length,
  });

  if (!normalizedPool.length && !allRaws.length) {
    if (debug) {
      debug.productsCount = attemptDebug.productsCount;
      debug.productIds = attemptDebug.productIds;
      debug.catalogPaging = catalogPaging;
      debug.paging = {
        offset: startCatalogOffset,
        limit,
        page: Math.floor(startCatalogOffset / CATALOG_PAGE_SIZE),
        pageSize: CATALOG_PAGE_SIZE,
        hasMore: false,
        nextOffset: null,
        maxOffset: MAX_CATALOG_OFFSET,
        maxPages: MAX_CATALOG_PAGES,
      };
    }
    return [];
  }

  const forScoring = await mapPool(normalizedPool.slice(0, 30), 6, async (cand) => {
    try {
      const listingId = String(cand.competitor_listing_id);
      const item = await fetchItem(accessToken, listingId);
      logSalesRawMl({ item_id: listingId, endpoint: `GET /items/${listingId}`, status: 200, body: item });
      const detailed = mlItemBodyToCandidateRaw(item);
      if (!detailed) return cand;
      const price = await resolveMlCompetitorEffectivePrice({
        itemId: listingId,
        accessToken,
        itemBody: item,
        fallbackPrice: detailed.competitor_price ?? cand.competitor_price ?? null,
        fallbackCurrency: detailed.currency ?? cand.currency ?? "BRL",
        fallbackSource: "items_fallback",
      });
      return {
        ...cand,
        competitor_title: detailed.competitor_title ?? cand.competitor_title,
        competitor_store_name: detailed.competitor_store_name ?? cand.competitor_store_name,
        competitor_thumbnail: detailed.competitor_thumbnail ?? cand.competitor_thumbnail,
        competitor_permalink: detailed.competitor_permalink ?? cand.competitor_permalink,
        competitor_price: price.effective_price ?? detailed.competitor_price ?? cand.competitor_price,
        currency: price.currency_id ?? detailed.currency ?? cand.currency,
        sales_hint: detailed.sales_hint ?? cand.sales_hint,
        shipping: detailed.shipping ?? cand.shipping,
        listing_type: detailed.listing_type ?? cand.listing_type,
        reputation: detailed.reputation ?? cand.reputation,
      };
    } catch (e) {
      logSalesRawMl({
        item_id: String(cand.competitor_listing_id || ""),
        endpoint: `GET /items/${cand.competitor_listing_id}`,
        status: e?.status ?? null,
        body: e?.body ?? null,
        error: e?.message ?? null,
      });
      return cand;
    }
  });
  const scoringPool = [...forScoring, ...normalizedPool.slice(30)];
  attemptDebug.detailsCount = forScoring.length;

  const sorted = sortCandidatesByRelevance(query, scoringPool);
  const pageResults = sorted.slice(0, limit);

  const hasMoreCatalog =
    !catalogExhausted &&
    scanOffset <= MAX_CATALOG_OFFSET &&
    (catalogPaging.total == null || scanOffset < Number(catalogPaging.total));

  attemptDebug.normalizedCount = pageResults.length;
  attemptDebug.discardReasons = discardReasons.slice(0, 30);
  attemptDebug.discardedCount = discardReasons.length;

  if (debug) {
    debug.productsCount = attemptDebug.productsCount;
    debug.productIds = attemptDebug.productIds;
    debug.catalogPaging = catalogPaging;
    debug.itemIdsCount = allRaws.length;
    debug.normalizedCount = pageResults.length;
    debug.normalized_results_count = pageResults.length;
    debug.discardReasons = discardReasons.slice(0, 20);
    debug.discardedCount = discardReasons.length;
    debug.paging = {
      offset: startCatalogOffset,
      limit,
      page: Math.floor(startCatalogOffset / CATALOG_PAGE_SIZE),
      pageSize: CATALOG_PAGE_SIZE,
      hasMore: hasMoreCatalog,
      nextOffset: hasMoreCatalog ? scanOffset : null,
      maxOffset: MAX_CATALOG_OFFSET,
      maxPages: MAX_CATALOG_PAGES,
      pagesScanned: attemptDebug.pagesScanned,
      scanEndOffset: scanOffset,
    };
    debug.relevance_sample = pageResults.slice(0, 5).map((c) => ({
      listing_id: c.competitor_listing_id,
      score: scoreCandidateRelevance(query, c),
      title: (c.competitor_title || "").slice(0, 80),
    }));
  }

  console.info("[COMPETITION] Broad normalize", {
    query,
    start_offset: startCatalogOffset,
    end_offset: scanOffset,
    pages_scanned: attemptDebug.pagesScanned,
    before: allRaws.length,
    pool: normalizedPool.length,
    after: pageResults.length,
    discarded: discardReasons.length,
    excluded: excludeSet.size,
    has_more: hasMoreCatalog,
  });

  return pageResults;
}

/** Modo legado — tentativas progressivas, sem paginação (fallback do engine). */
async function discoverLegacy(context) {
  const { accessToken } = context;
  const limit = Number(context.limit) > 0 ? Number(context.limit) : 20;
  const debug = context?.debug && typeof context.debug === "object" ? context.debug : null;
  const attempts = buildAttempts(context);
  if (!attempts.length) {
    console.info("[COMPETITION] Search skipped (no query)");
    return [];
  }

  for (const attempt of attempts) {
    const tag = attempt.productIdentifier ? `gtin:${attempt.productIdentifier}` : attempt.q;
    if (debug && Array.isArray(debug.search_queries_attempted)) {
      debug.search_queries_attempted.push(tag);
    }

    const attemptDebug = {
      mode: "legacy",
      label: attempt.label,
      query: attempt.q,
      productIdentifier: attempt.productIdentifier,
      endpoint: "/products/search",
      searchStatus: null,
      productsCount: 0,
      productIds: [],
      itemIdsCount: 0,
      normalizedCount: 0,
      discardReasons: [],
      itemsCalls: [],
    };
    if (debug && Array.isArray(debug.attempts)) debug.attempts.push(attemptDebug);

    let products = [];
    try {
      const r = await searchCatalogProducts(accessToken, {
        siteId: ML_SITE_ID,
        q: attempt.q,
        productIdentifier: attempt.productIdentifier,
        status: "active",
        limit,
      });
      products = Array.isArray(r?.results) ? r.results : [];
      attemptDebug.searchStatus = 200;
      logSalesRawCatalogSearch(attempt.query, 200, products);
    } catch (e) {
      attemptDebug.searchStatus = e?.status ?? null;
      if (debug) debug.last_error = `products/search: ${String(e?.message ?? e)}`.slice(0, 200);
      continue;
    }

    attemptDebug.productsCount = products.length;
    attemptDebug.productIds = products.map((p) => (p?.id != null ? String(p.id) : null)).filter(Boolean);

    if (!products.length) continue;

    const allRaws = [];
    for (const p of products.slice(0, MAX_PRODUCTS_LEGACY)) {
      const { raws } = await collectFromCatalogProduct(accessToken, p, limit, attemptDebug, { enrich: true });
      for (const entry of raws) allRaws.push(entry);
      if (allRaws.length >= limit) break;
    }

    attemptDebug.itemIdsCount = allRaws.length;
    if (!allRaws.length) continue;

    const seen = new Set();
    const discardReasons = [];
    const normalized = [];
    const queryForSort = attempt.q || buildPrimaryQuery(context);

    for (const { raw } of allRaws) {
      const cand = acceptRaw(context, raw, "ml_search", seen, discardReasons);
      if (cand) normalized.push(cand);
      if (normalized.length >= limit) break;
    }

    const sorted = sortCandidatesByRelevance(queryForSort, normalized);
    attemptDebug.normalizedCount = sorted.length;
    attemptDebug.discardReasons = discardReasons.slice(0, 20);

    if (sorted.length > 0) return sorted;
  }

  if (debug) {
    debug.normalized_results_count = 0;
    if (!debug.warning) debug.warning = "no_candidates_found";
  }
  return [];
}

export class MercadoLivreSearchCompetitionStrategy extends CompetitionDiscoveryStrategy {
  get marketplace() {
    return "mercado_livre";
  }

  get sourceStrategy() {
    return "ml_broad_search";
  }

  supports(context) {
    const gtin = context?.listing?.gtin != null ? String(context.listing.gtin).trim() : "";
    return Boolean(buildPrimaryQuery(context) || gtin);
  }

  async discover(context) {
    if (isBroadSearchMode(context)) {
      return discoverBroad(context);
    }
    return discoverLegacy(context);
  }
}
