// ============================================================
// S7 — Concorrência: resolver único de link → candidato saudável
// Fallback progressivo: item API → enrich → discovery (busca por nome).
// ============================================================

import {
  fetchItem,
  fetchCatalogProduct,
  fetchCatalogProductItemsSafe,
  searchCatalogProducts,
} from "../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import {
  normalizeDiscoveredCompetitor,
  discoveredCandidateToSaveNormalized,
  enrichExtrasFromDiscoveredCandidate,
} from "./competitionNormalizer.js";
import {
  mlItemBodyToCandidateRaw,
  mlCatalogItemRowToCandidateRaw,
  mlBuyBoxWinnerToCandidateRaw,
  pickCatalogProductThumbnail,
  pickItemThumbnail,
  isOwnCandidate,
} from "./strategies/mlCompetitorMapping.js";
import {
  parseMercadoLivreListingUrl,
  extractSlugQueryFromMercadoLivreUrl,
  reconcileCandidateListingIdFromPermalink,
} from "./mlListingUrlParser.js";
import { logCompetitionLinkParseWarning } from "./competitionLinkParseAudit.js";
import {
  titleFromMercadoLivrePermalink,
  buildMercadoLivreItemPermalink,
  extractCatalogProductIdFromPermalink,
} from "./mlListingDisplay.js";
import {
  enrichCompetitorListing,
  mergeCompetitorRawFields,
  fetchMercadoLivreSellerPublicProfile,
} from "./competitionListingEnricher.js";
import {
  buildLinkDiscoveryQueries,
  discoverHealthyCandidateForLink,
} from "./competitionLinkDiscoveryFallback.js";
import { completePartialCompetitorViaDiscovery } from "./competitionLinkDiscoveryCompletion.js";
import {
  assessLinkCandidateHealth,
  isPreviewResolvableCandidate,
  listEnrichDesiredMissingFields,
  listMissingCriticalMetaFields,
} from "./competitionEnrichHelpers.js";
import {
  createLinkDebugTrace,
  pushLinkDebugStep,
  logS7LinkDebug01Parse,
  logS7LinkDebug02ItemFetch,
  logS7LinkDebug03SellerFetch,
  logS7LinkDebug06Final,
  buildResolveLinkFailureDebug,
} from "./competitionLinkDebug.js";

const SOURCE_STRATEGY = "ml_link";

function finalizeLinkCandidate(candidate, rawUrl) {
  return reconcileCandidateListingIdFromPermalink(candidate, rawUrl);
}
const INCOMPLETE_MESSAGE =
  "Não foi possível obter os dados completos desse concorrente. Tente outro link ou atualize novamente.";
const SLUG_AMBIGUOUS_MESSAGE =
  "Encontramos vários anúncios parecidos. Use a aba Buscar por nome para escolher o concorrente certo.";
const UNRESOLVED_MESSAGE = "Não foi possível identificar o anúncio neste link.";

function normalizeListingIdForAnchor(value) {
  const raw = value != null ? String(value).trim() : "";
  if (!raw) return null;
  return raw.toUpperCase().replace(/-/g, "");
}

function isSameAnchoredListing(candidateListingId, anchoredItemId) {
  const cand = normalizeListingIdForAnchor(candidateListingId);
  const anchor = normalizeListingIdForAnchor(anchoredItemId);
  return Boolean(cand && anchor && cand === anchor);
}

function logAnchorGuard({ anchoredItemId, candidateListingId, swapBlocked, reason }) {
  if (!anchoredItemId) return;
  console.info("[S7_COMPETITION_LINK_ANCHOR_GUARD]", {
    anchored_item_id: anchoredItemId,
    candidate_listing_id: candidateListingId ?? null,
    swap_blocked: Boolean(swapBlocked),
    reason: reason || null,
  });
}

function buildMinimalCandidateFromLink(listingId, url) {
  const urlTrim = String(url || "").trim();
  const permalink = urlTrim.startsWith("http") ? urlTrim : buildMercadoLivreItemPermalink(listingId);
  const titleFromSlug = titleFromMercadoLivrePermalink(permalink);
  return {
    competitor_listing_id: listingId,
    competitor_title: titleFromSlug,
    competitor_store_name: null,
    competitor_seller_id: null,
    competitor_price: null,
    currency: "BRL",
    competitor_permalink: permalink,
    competitor_thumbnail: null,
    shipping: null,
    listing_type: null,
    reputation: null,
    sales_hint: null,
  };
}

function discoveredShapeFromNormalized(normalized, enrichExtras, sourceStrategy) {
  const n = normalized && typeof normalized === "object" ? normalized : {};
  const e = enrichExtras && typeof enrichExtras === "object" ? enrichExtras : {};
  return normalizeDiscoveredCompetitor(
    {
      competitor_listing_id: n.competitor_listing_id,
      competitor_title: n.competitor_title,
      competitor_store_name: n.competitor_store_name,
      competitor_seller_id: n.competitor_seller_id,
      competitor_price: n.last_seen_price,
      currency: n.last_seen_currency ?? "BRL",
      competitor_permalink: n.competitor_permalink,
      competitor_thumbnail: n.competitor_thumbnail,
      shipping: e.shipping ?? null,
      listing_type: e.listing_type ?? null,
      reputation: e.reputation ?? null,
      sales_hint: e.sales_hint ?? null,
    },
    sourceStrategy ?? SOURCE_STRATEGY
  );
}

async function tryDiscoveryCompletionForCandidate({
  accessToken,
  userId,
  product,
  listingRow,
  context,
  candidate,
  sourceStrategy,
  rawUrl,
}) {
  const partialNorm = discoveredCandidateToSaveNormalized(candidate);
  const partialExtras = enrichExtrasFromDiscoveredCandidate(candidate);
  const completion = await completePartialCompetitorViaDiscovery({
    accessToken,
    userId,
    product,
    listingRow,
    ownSellerId: context.ownSellerId ?? null,
    ownListingId: context.ownListingId ?? null,
    normalized: partialNorm,
    enrichExtras: partialExtras,
    rawUrl,
  });
  if (!completion.matched) {
    return { candidate, sourceStrategy, completed: false };
  }
  const mergedCandidate = discoveredShapeFromNormalized(
    completion.normalized,
    completion.enrichExtras,
    sourceStrategy
  );
  return { candidate: mergedCandidate, sourceStrategy, completed: true };
}

function candidateNeedsDiscoveryBoost(candidate) {
  const metaMissing = listMissingCriticalMetaFields(enrichExtrasFromDiscoveredCandidate(candidate));
  const thumbMissing = !candidate?.competitor_thumbnail;
  return metaMissing.length > 0 || thumbMissing;
}

function mergeThumbnailIntoCandidate(candidate, rawOrCandidate) {
  if (!candidate || candidate.competitor_thumbnail) return candidate;
  const src = rawOrCandidate && typeof rawOrCandidate === "object" ? rawOrCandidate : null;
  if (!src) return candidate;
  const thumb =
    src.competitor_thumbnail ??
    pickItemThumbnail(src) ??
    (src.thumbnail != null ? String(src.thumbnail) : null) ??
    (src.secure_thumbnail != null ? String(src.secure_thumbnail) : null);
  if (!thumb) return candidate;
  return { ...candidate, competitor_thumbnail: thumb };
}

function resolveCatalogProductIdForAnchoredImage({
  explicitCatalogProductId = null,
  candidatePermalink = null,
  rawUrl = null,
}) {
  if (explicitCatalogProductId != null && String(explicitCatalogProductId).trim() !== "") {
    return String(explicitCatalogProductId).trim();
  }
  const fromCandidate = extractCatalogProductIdFromPermalink(candidatePermalink);
  if (fromCandidate) return fromCandidate;
  const fromRawUrl = extractCatalogProductIdFromPermalink(rawUrl);
  if (fromRawUrl) return fromRawUrl;
  return null;
}

function logAnchoredImageFallbackTrace({
  anchoredItemId,
  catalogProductId,
  imageSourceBefore,
  imageSourceAfter,
  thumbnailBefore,
  thumbnailAfter,
  fallbackAttempted,
  fallbackMatchedItem,
  fallbackSkippedReason,
}) {
  if (!anchoredItemId) return;
  console.info("[S7_COMPETITION_LINK_IMAGE_FALLBACK_TRACE]", {
    anchored_item_id: anchoredItemId,
    catalog_product_id: catalogProductId ?? null,
    image_source_before: imageSourceBefore ?? null,
    image_source_after: imageSourceAfter ?? null,
    thumbnail_before: thumbnailBefore ?? null,
    thumbnail_after: thumbnailAfter ?? null,
    fallback_attempted: Boolean(fallbackAttempted),
    fallback_matched_item: Boolean(fallbackMatchedItem),
    fallback_skipped_reason: fallbackSkippedReason ?? null,
  });
}

async function enrichAnchoredThumbnailDeterministic({
  accessToken,
  candidate,
  anchoredItemId,
  catalogProductId,
  rawUrl,
  debug,
}) {
  const c = candidate && typeof candidate === "object" ? candidate : null;
  const anchored = anchoredItemId != null ? String(anchoredItemId).trim() : "";
  if (!c || !anchored) return candidate;

  const imageSourceBefore = c.competitor_thumbnail ? "existing_thumbnail" : "none";
  const thumbnailBefore = c.competitor_thumbnail ?? null;
  let imageSourceAfter = imageSourceBefore;
  let thumbnailAfter = thumbnailBefore;
  let fallbackAttempted = false;
  let fallbackMatchedItem = false;
  let fallbackSkippedReason = null;
  let next = c;

  if (c.competitor_thumbnail) {
    fallbackSkippedReason = "thumbnail_already_present";
    logAnchoredImageFallbackTrace({
      anchoredItemId: anchored,
      catalogProductId,
      imageSourceBefore,
      imageSourceAfter,
      thumbnailBefore,
      thumbnailAfter,
      fallbackAttempted,
      fallbackMatchedItem,
      fallbackSkippedReason,
    });
    return next;
  }

  const resolvedCatalogProductId = resolveCatalogProductIdForAnchoredImage({
    explicitCatalogProductId: catalogProductId,
    candidatePermalink: c.competitor_permalink ?? null,
    rawUrl,
  });
  if (!resolvedCatalogProductId) {
    fallbackSkippedReason = "image_fallback_skipped:no_catalog_product_id";
    logAnchoredImageFallbackTrace({
      anchoredItemId: anchored,
      catalogProductId: null,
      imageSourceBefore,
      imageSourceAfter,
      thumbnailBefore,
      thumbnailAfter,
      fallbackAttempted,
      fallbackMatchedItem,
      fallbackSkippedReason,
    });
    return next;
  }

  fallbackAttempted = true;
  const itemsRes = await fetchCatalogProductItemsSafe(accessToken, resolvedCatalogProductId, { limit: 50 });
  pushAttempt(debug, {
    endpoint: `/products/${resolvedCatalogProductId}/items`,
    status: itemsRes?.status ?? null,
    fallback: "anchored_image_deterministic_catalog_items",
    anchored_item_id: anchored,
  });

  const row = Array.isArray(itemsRes?.results)
    ? itemsRes.results.find((r) => String(r?.item_id ?? "").trim() === anchored)
    : null;
  if (!row) {
    fallbackSkippedReason = "image_fallback_skipped:anchored_item_not_in_catalog_items";
    logAnchoredImageFallbackTrace({
      anchoredItemId: anchored,
      catalogProductId: resolvedCatalogProductId,
      imageSourceBefore,
      imageSourceAfter,
      thumbnailBefore,
      thumbnailAfter,
      fallbackAttempted,
      fallbackMatchedItem,
      fallbackSkippedReason,
    });
    return next;
  }

  fallbackMatchedItem = true;
  let thumb =
    (row?.secure_thumbnail != null && String(row.secure_thumbnail).trim() !== ""
      ? String(row.secure_thumbnail).trim()
      : null) ||
    (row?.thumbnail != null && String(row.thumbnail).trim() !== ""
      ? String(row.thumbnail).trim()
      : null);

  if (!thumb) {
    const itemRes = await tryFetchItem(accessToken, anchored);
    pushAttempt(debug, {
      endpoint: `/items/${anchored}`,
      status: itemRes?.status ?? null,
      fallback: "anchored_image_deterministic_item",
      anchored_item_id: anchored,
    });
    if (itemRes?.ok && itemRes?.item) {
      thumb =
        itemRes.item?.thumbnail != null && String(itemRes.item.thumbnail).trim() !== ""
          ? String(itemRes.item.thumbnail).trim()
          : itemRes.item?.secure_thumbnail != null && String(itemRes.item.secure_thumbnail).trim() !== ""
            ? String(itemRes.item.secure_thumbnail).trim()
            : pickItemThumbnail(itemRes.item);
    }
  }

  if (!thumb) {
    try {
      const detail = await fetchCatalogProduct(accessToken, resolvedCatalogProductId);
      pushAttempt(debug, {
        endpoint: `/products/${resolvedCatalogProductId}`,
        status: 200,
        fallback: "anchored_image_deterministic_catalog_detail",
        anchored_item_id: anchored,
      });
      thumb = pickCatalogProductThumbnail(detail);
      if (thumb) {
        imageSourceAfter = "anchored_catalog_detail_match";
      }
    } catch (e) {
      pushAttempt(debug, {
        endpoint: `/products/${resolvedCatalogProductId}`,
        status: e?.status ?? null,
        fallback: "anchored_image_deterministic_catalog_detail",
        anchored_item_id: anchored,
      });
    }
  } else {
    imageSourceAfter = "anchored_item_match";
  }

  if (!thumb) {
    fallbackSkippedReason = "image_fallback_skipped:anchored_match_without_image";
    logAnchoredImageFallbackTrace({
      anchoredItemId: anchored,
      catalogProductId: resolvedCatalogProductId,
      imageSourceBefore,
      imageSourceAfter,
      thumbnailBefore,
      thumbnailAfter,
      fallbackAttempted,
      fallbackMatchedItem,
      fallbackSkippedReason,
    });
    return next;
  }

  next = { ...c, competitor_thumbnail: thumb };
  thumbnailAfter = thumb;
  logAnchoredImageFallbackTrace({
    anchoredItemId: anchored,
    catalogProductId: resolvedCatalogProductId,
    imageSourceBefore,
    imageSourceAfter,
    thumbnailBefore,
    thumbnailAfter,
    fallbackAttempted,
    fallbackMatchedItem,
    fallbackSkippedReason,
  });
  return next;
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function extractMetaContent(html, propName) {
  const safe = String(propName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rgxA = new RegExp(
    `<meta[^>]+(?:property|name)=["']${safe}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const rgxB = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${safe}["'][^>]*>`,
    "i"
  );
  const m = html.match(rgxA) || html.match(rgxB);
  return m?.[1] ? decodeHtmlEntities(m[1]).trim() : null;
}

function extractHtmlTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m?.[1]) return null;
  const t = decodeHtmlEntities(m[1]).trim();
  return t || null;
}

async function enrichCandidateFromPublicPage(rawUrl, candidate, debug) {
  const c = candidate && typeof candidate === "object" ? candidate : null;
  if (!c) return candidate;
  const needsTitle = !c.competitor_title;
  const needsThumb = !c.competitor_thumbnail;
  if (!needsTitle && !needsThumb) return candidate;

  const url = String(rawUrl || "").trim();
  if (!url.startsWith("http")) return candidate;
  if (!/mercadolivre\.com\.br|mercadolibre\.com/i.test(url)) return candidate;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; S7Bot/1.0)" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const html = await resp.text();
    const ogTitle = extractMetaContent(html, "og:title");
    const ogImage = extractMetaContent(html, "og:image");
    const pageTitle = extractHtmlTitle(html);
    const resolvedTitle =
      c.competitor_title ||
      titleFromMercadoLivrePermalink(url) ||
      ogTitle ||
      pageTitle ||
      null;
    const resolvedThumb = c.competitor_thumbnail || ogImage || null;
    pushAttempt(debug, {
      endpoint: url,
      status: resp.status,
      fallback: "public_page_og",
      has_title: Boolean(resolvedTitle),
      has_thumbnail: Boolean(resolvedThumb),
    });
    return {
      ...c,
      competitor_title: resolvedTitle,
      competitor_thumbnail: resolvedThumb,
      competitor_permalink: c.competitor_permalink || url,
    };
  } catch (e) {
    pushAttempt(debug, {
      endpoint: url,
      status: e?.status ?? null,
      fallback: "public_page_og",
      error: String(e?.message ?? e).slice(0, 120),
    });
    const fallbackTitle = c.competitor_title || titleFromMercadoLivrePermalink(url) || null;
    if (fallbackTitle && !c.competitor_title) {
      return {
        ...c,
        competitor_title: fallbackTitle,
        competitor_permalink: c.competitor_permalink || url,
      };
    }
    return candidate;
  }
}

async function enrichCandidateFromSiteSearch(accessToken, candidate, debug) {
  const c = candidate && typeof candidate === "object" ? candidate : null;
  if (!c) return candidate;
  const needsTitle = !c.competitor_title;
  const needsThumb = !c.competitor_thumbnail;
  if (!needsTitle && !needsThumb) return candidate;
  const listingId = c.competitor_listing_id != null ? String(c.competitor_listing_id).trim() : "";
  if (!listingId) return candidate;

  try {
    const url = `https://api.mercadolibre.com/sites/MLB/search?q=${encodeURIComponent(listingId)}&limit=15`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await resp.json().catch(() => ({}));
    const results = Array.isArray(body?.results) ? body.results : [];
    const hit =
      results.find((it) => String(it?.id ?? "").trim() === listingId) ??
      results.find((it) => String(it?.id ?? "").trim().toUpperCase() === listingId.toUpperCase()) ??
      null;

    pushAttempt(debug, {
      endpoint: "/sites/MLB/search",
      status: resp.status,
      fallback: "search_by_listing_id",
      count: results.length,
      hit: Boolean(hit),
    });

    if (!hit) return candidate;

    const title = hit?.title != null ? String(hit.title).trim() : null;
    const thumb =
      hit?.thumbnail != null && String(hit.thumbnail).trim() !== ""
        ? String(hit.thumbnail).trim()
        : hit?.secure_thumbnail != null && String(hit.secure_thumbnail).trim() !== ""
          ? String(hit.secure_thumbnail).trim()
          : null;
    const permalink = hit?.permalink != null ? String(hit.permalink).trim() : null;

    return {
      ...c,
      competitor_title: c.competitor_title || title || null,
      competitor_thumbnail: c.competitor_thumbnail || thumb || null,
      competitor_permalink: c.competitor_permalink || permalink || c.competitor_permalink,
    };
  } catch (e) {
    pushAttempt(debug, {
      endpoint: "/sites/MLB/search",
      status: e?.status ?? null,
      fallback: "search_by_listing_id",
      error: String(e?.message ?? e).slice(0, 120),
    });
    return candidate;
  }
}

async function enrichThumbnailFromCatalogSearch(
  accessToken,
  candidate,
  rawUrl,
  debug,
  targetCatalogProductId = null
) {
  const c = candidate && typeof candidate === "object" ? candidate : null;
  if (!c || c.competitor_thumbnail) return candidate;
  const listingId = c.competitor_listing_id != null ? String(c.competitor_listing_id).trim() : "";
  if (!listingId) return candidate;
  const query = c.competitor_title || titleFromMercadoLivrePermalink(rawUrl) || null;
  if (!query) return candidate;

  try {
    const searched = await searchCatalogProducts(accessToken, {
      siteId: "MLB",
      q: query,
      status: "active",
      limit: 20,
      offset: 0,
    });
    const products = Array.isArray(searched?.results) ? searched.results : [];
    pushAttempt(debug, {
      endpoint: "/products/search",
      status: 200,
      fallback: "catalog_search_thumbnail_fill",
      query: String(query).slice(0, 80),
      count: products.length,
    });

    const targetCatalog =
      targetCatalogProductId != null ? String(targetCatalogProductId).trim().toUpperCase() : "";

    const fetchProductItemsPages = async (productId) => {
      const pages = [];
      let total = null;
      for (let offset = 0; offset <= 200; offset += 50) {
        const page = await fetchCatalogProductItemsSafe(accessToken, productId, { limit: 50, offset });
        pages.push(page);
        const pageTotal = Number(page?.paging?.total);
        if (Number.isFinite(pageTotal) && pageTotal >= 0) total = pageTotal;
        const currentCount = Array.isArray(page?.results) ? page.results.length : 0;
        if (currentCount < 50) break;
        if (total != null && offset + 50 >= total) break;
      }
      return pages;
    };

    for (const p of products.slice(0, 12)) {
      const productId = p?.id != null ? String(p.id).trim() : "";
      if (!productId) continue;
      const thumb = pickCatalogProductThumbnail(p);
      if (!thumb) continue;
      const pages = await fetchProductItemsPages(productId);
      const allRows = pages.flatMap((pg) => (Array.isArray(pg?.results) ? pg.results : []));
      const catalogMatch = targetCatalog
        ? allRows.some((row) => {
            const up = row?.user_product_id != null ? String(row.user_product_id).trim().toUpperCase() : "";
            return up !== "" && up === targetCatalog;
          })
        : false;
      if (catalogMatch) {
        pushAttempt(debug, {
          endpoint: `/products/${productId}/items`,
          status: pages[0]?.status ?? null,
          fallback: "catalog_search_thumbnail_catalog_match",
          listing_id: listingId,
          target_catalog: targetCatalog,
          has_thumbnail: true,
          pages_scanned: pages.length,
        });
        return { ...c, competitor_thumbnail: thumb };
      }
      const hit = allRows.some(
        (row) => row?.item_id != null && String(row.item_id).trim() === listingId
      );
      if (hit) {
        pushAttempt(debug, {
          endpoint: `/products/${productId}/items`,
          status: pages[0]?.status ?? null,
          fallback: "catalog_search_thumbnail_match",
          listing_id: listingId,
          has_thumbnail: true,
          pages_scanned: pages.length,
        });
        return { ...c, competitor_thumbnail: thumb };
      }
    }
  } catch (e) {
    pushAttempt(debug, {
      endpoint: "/products/search",
      status: e?.status ?? null,
      fallback: "catalog_search_thumbnail_fill",
      error: String(e?.message ?? e).slice(0, 120),
    });
  }

  return candidate;
}

/** Completa imagem/meta via discovery quando o item API trouxe só o básico. */
async function ensureCandidateBoostFromDiscovery(ctx) {
  const {
    accessToken,
    userId,
    product,
    listingRow,
    context,
    candidate,
    sourceStrategy,
    rawUrl,
    resolvedVia = null,
  } = ctx;
  if (!candidateNeedsDiscoveryBoost(candidate) || !product?.id) {
    return { candidate, sourceStrategy, resolvedVia, completed: false };
  }
  const completed = await tryDiscoveryCompletionForCandidate({
    accessToken,
    userId,
    product,
    listingRow,
    context,
    candidate,
    sourceStrategy,
    rawUrl,
  });
  return {
    candidate: completed.candidate,
    sourceStrategy: completed.sourceStrategy,
    resolvedVia: completed.completed
      ? `${resolvedVia ?? sourceStrategy}+discovery_completion`
      : resolvedVia,
    completed: completed.completed,
  };
}

function returnPartialPreview({
  candidate,
  sourceStrategy,
  resolvedVia,
  linkDebug,
  enrichOut,
  debug,
  itemFetchStatus,
}) {
  const health = assessLinkCandidateHealth(candidate);
  const desiredMissing = listEnrichDesiredMissingFields(candidate);

  linkDebug.missing_required_fields = desiredMissing;
  linkDebug.final = { healthy: false, enrich_status: "partial", source_strategy: sourceStrategy };

  logS7LinkDebug06Final({
    item_id: candidate.competitor_listing_id,
    healthy: false,
    source_strategy: sourceStrategy,
    missing_required_fields: desiredMissing,
    enrich_status: "partial",
    has_title: Boolean(candidate.competitor_title),
    has_price: candidate.competitor_price != null,
    has_thumbnail: Boolean(candidate.competitor_thumbnail),
    has_seller_nickname: Boolean(candidate.competitor_store_name),
    has_permalink: Boolean(candidate.competitor_permalink),
    has_listing_type: Boolean(candidate.listing_type),
    has_frete_hint: Boolean(
      candidate?.shipping?.free_shipping === true || candidate?.shipping?.mode
    ),
    has_seller_reputation: Boolean(
      candidate?.reputation?.level_id || candidate?.reputation?.power_seller_status
    ),
  });

  if (debug) {
    debug.normalize_ok = true;
    debug.resolved_via = resolvedVia ?? enrichOut?.enrichSource ?? null;
    debug.partial = true;
    debug.final_code = null;
    debug.link_debug = linkDebug;
  }

  pushLinkDebugStep(linkDebug, "partial_preview_ok");

  return {
    ok: true,
    candidate,
    item_id: candidate.competitor_listing_id,
    partial: true,
    resolved_via: resolvedVia ?? enrichOut?.enrichSource ?? "partial",
    healthy: false,
    enrich_status: "partial",
    enrich_missing_fields: desiredMissing,
    source_strategy: sourceStrategy,
    linkDebug: buildResolveLinkFailureDebug(linkDebug),
  };
}

function safeBodySummary(body) {
  if (!body || typeof body !== "object") return null;
  const b = /** @type {Record<string, unknown>} */ (body);
  return {
    message: b.message != null ? String(b.message).slice(0, 120) : null,
    error: b.error != null ? String(b.error).slice(0, 80) : null,
  };
}

function pushAttempt(debug, entry) {
  if (!debug) return;
  if (!Array.isArray(debug.attempts)) debug.attempts = [];
  debug.attempts.push(entry);
}

function resolvePermalinkFromUrl(url, listingId) {
  const urlTrim = String(url || "").trim();
  if (urlTrim.startsWith("http")) return urlTrim;
  return buildMercadoLivreItemPermalink(listingId);
}

function pickSellerIdFromItem(item) {
  if (!item) return null;
  if (item.seller_id != null) return String(item.seller_id);
  if (item.seller?.id != null) return String(item.seller.id);
  return null;
}

async function tryFetchItem(accessToken, itemId) {
  try {
    const item = await fetchItem(accessToken, itemId);
    return { ok: true, status: 200, item, body: null };
  } catch (e) {
    return {
      ok: false,
      status: e?.status ?? null,
      item: null,
      body: e?.body ?? null,
      message: String(e?.message ?? e).slice(0, 200),
    };
  }
}

async function resolveFromCatalogProduct(accessToken, productId, debug, targetListingId = null) {
  const meta = { name: null, thumbnail: null, id: productId };
  const itemsRes = await fetchCatalogProductItemsSafe(accessToken, productId, { limit: 50 });
  pushAttempt(debug, {
    endpoint: `/products/${productId}/items`,
    status: itemsRes.status,
    count: itemsRes.results.length,
    fallback: "catalog_items",
  });

  let catalogDetail = null;
  try {
    catalogDetail = await fetchCatalogProduct(accessToken, productId);
    meta.name = catalogDetail?.name != null ? String(catalogDetail.name) : null;
    meta.thumbnail = pickCatalogProductThumbnail(catalogDetail);
    pushAttempt(debug, {
      endpoint: `/products/${productId}`,
      status: 200,
      fallback: "catalog_detail_seed",
      has_name: Boolean(meta.name),
      has_thumbnail: Boolean(meta.thumbnail),
    });
  } catch (e) {
    pushAttempt(debug, {
      endpoint: `/products/${productId}`,
      status: e?.status ?? null,
      body: safeBodySummary(e?.body),
      fallback: "catalog_detail_seed",
    });
  }

  if (targetListingId) {
    const row = itemsRes.results.find(
      (r) => r?.item_id != null && String(r.item_id).trim() === String(targetListingId).trim()
    );
    if (row) {
      const raw = mlCatalogItemRowToCandidateRaw(row, meta);
      if (raw?.competitor_listing_id) return { raw, via: "catalog_items_match" };
    }
  }

  for (const row of itemsRes.results) {
    const raw = mlCatalogItemRowToCandidateRaw(row, meta);
    if (raw?.competitor_listing_id && raw.competitor_price != null && raw.competitor_seller_id) {
      return { raw, via: "catalog_items_row" };
    }
  }

  try {
    const detail = catalogDetail ?? (await fetchCatalogProduct(accessToken, productId));
    const bbRaw = mlBuyBoxWinnerToCandidateRaw(detail, meta);
    if (bbRaw?.competitor_listing_id) return { raw: bbRaw, via: "buy_box_winner" };
  } catch (e) {
    pushAttempt(debug, {
      endpoint: `/products/${productId}`,
      status: e?.status ?? null,
      body: safeBodySummary(e?.body),
    });
  }

  return { raw: null, via: null };
}

async function fetchSellerProfile(accessToken, sellerId, linkDebug) {
  const id = sellerId != null ? String(sellerId).trim() : "";
  if (!id) return { profile: null, status: null };

  const profile = await fetchMercadoLivreSellerPublicProfile(accessToken, id);
  const ok = Boolean(profile?.nickname);
  const sellerLog = {
    seller_id: id,
    endpoint: `/users/${id}`,
    ok,
    status: profile ? 200 : null,
    has_nickname: Boolean(profile?.nickname),
    power_seller_status: profile?.reputation?.power_seller_status ?? null,
    level_id: profile?.reputation?.level_id ?? null,
  };
  logS7LinkDebug03SellerFetch(sellerLog);
  if (linkDebug) linkDebug.seller_fetch_status = profile ? 200 : "no_profile";

  return { profile, status: profile ? 200 : null };
}

async function enrichSellerOnRaw(accessToken, raw, debug, linkDebug) {
  if (!raw?.competitor_seller_id) return raw;
  const { profile } = await fetchSellerProfile(accessToken, raw.competitor_seller_id, linkDebug);
  pushAttempt(debug, {
    endpoint: `/users/${raw.competitor_seller_id}`,
    status: profile ? 200 : null,
    fallback: "seller_profile",
  });
  if (profile?.nickname && !raw.competitor_store_name) raw.competitor_store_name = profile.nickname;
  if (profile?.reputation && !raw.reputation) raw.reputation = profile.reputation;
  return raw;
}

async function enrichSellerOnCandidate(accessToken, candidate, debug, linkDebug) {
  if (!candidate?.competitor_seller_id || candidate?.competitor_store_name) return candidate;
  const { profile } = await fetchSellerProfile(accessToken, candidate.competitor_seller_id, linkDebug);
  pushAttempt(debug, {
    endpoint: `/users/${candidate.competitor_seller_id}`,
    status: profile ? 200 : null,
    fallback: "seller_profile_candidate",
  });
  if (!profile) return candidate;
  return {
    ...candidate,
    competitor_store_name: candidate.competitor_store_name || profile.nickname || null,
    reputation: candidate.reputation || profile.reputation || null,
  };
}

async function enrichThumbnailFromCatalogProduct(accessToken, candidate, catalogProductId, debug) {
  if (!candidate || candidate.competitor_thumbnail || !catalogProductId) return candidate;
  try {
    const detail = await fetchCatalogProduct(accessToken, catalogProductId);
    const thumb = pickCatalogProductThumbnail(detail);
    pushAttempt(debug, {
      endpoint: `/products/${catalogProductId}`,
      status: 200,
      fallback: "catalog_thumbnail_fill",
      has_pictures: Boolean(thumb),
    });
    if (!thumb) return candidate;
    return { ...candidate, competitor_thumbnail: thumb };
  } catch (e) {
    pushAttempt(debug, {
      endpoint: `/products/${catalogProductId}`,
      status: e?.status ?? null,
      body: safeBodySummary(e?.body),
      fallback: "catalog_thumbnail_fill",
    });
    return candidate;
  }
}

function finalizeFailure({
  code,
  error,
  item_id,
  health,
  sourceStrategy,
  linkDebug,
  resolvedVia,
}) {
  const missing = health?.missing_required_fields ?? linkDebug?.missing_required_fields ?? [];
  linkDebug.missing_required_fields = missing;
  linkDebug.final = {
    healthy: false,
    code,
    source_strategy: sourceStrategy ?? SOURCE_STRATEGY,
    resolved_via: resolvedVia ?? null,
  };

  logS7LinkDebug06Final({
    item_id: item_id ?? linkDebug.parsed_item_id ?? null,
    healthy: false,
    source_strategy: sourceStrategy ?? SOURCE_STRATEGY,
    missing_required_fields: missing,
    has_title: health?.has_title ?? false,
    has_price: health?.has_price ?? false,
    has_thumbnail: health?.has_thumbnail ?? false,
    has_seller_nickname: health?.has_seller_nickname ?? false,
    has_permalink: health?.has_permalink ?? false,
    has_listing_type: health?.has_listing_type ?? false,
    has_frete_hint: health?.has_frete_hint ?? false,
    has_seller_reputation: health?.has_seller_reputation ?? false,
    error_code: code,
  });

  return {
    ok: false,
    error,
    code,
    missing_required_fields: missing,
    item_id: item_id ?? null,
    linkDebug: buildResolveLinkFailureDebug(linkDebug),
  };
}

async function runDiscoveryFallback({
  accessToken,
  userId,
  product,
  listingRow,
  context,
  targetListingId,
  permalink,
  parsed,
  rawUrl,
  titleHint,
  linkDebug,
  reason,
}) {
  pushLinkDebugStep(linkDebug, "discovery_fallback");
  const slugQuery = parsed?.slug || extractSlugQueryFromMercadoLivreUrl(rawUrl);
  const titleQuery = titleHint || titleFromMercadoLivrePermalink(rawUrl);
  const queries = buildLinkDiscoveryQueries({
    parsed,
    rawUrl,
    titleHint: titleQuery,
    listingId: targetListingId,
    product,
  });

  return discoverHealthyCandidateForLink({
    accessToken,
    userId,
    product,
    listingRow,
    ownSellerId: context.ownSellerId ?? null,
    ownListingId: context.ownListingId ?? null,
    targetListingId,
    permalink,
    queries,
    reason,
    slugQuery,
    titleQuery,
    linkDebug,
  });
}

export async function resolveCompetitionCandidateFromLink({
  accessToken,
  url,
  context = {},
  debug = null,
  productId = null,
  product = null,
  listingRow = null,
  marketplaceAccountId = null,
  userId = null,
}) {
  const rawUrl = String(url || "").trim();
  const linkDebug = createLinkDebugTrace();
  let parsed = parseMercadoLivreListingUrl(rawUrl);

  const slugFromUrl = parsed.ok
    ? parsed.slug
    : extractSlugQueryFromMercadoLivreUrl(rawUrl) || parsed.slug || null;

  logS7LinkDebug01Parse({
    raw_url: rawUrl.slice(0, 300),
    normalized_url: parsed.ok ? parsed.normalizedUrl : parsed.normalizedUrl ?? rawUrl,
    parsed_item_id: parsed.ok ? parsed.itemId ?? (parsed.idType === "item" ? parsed.id : null) : null,
    parsed_catalog_product_id: parsed.ok ? parsed.catalogProductId ?? null : null,
    slug_query: slugFromUrl,
    source_type: parsed.ok ? parsed.idType : parsed.code,
    parse_strategy: parsed.ok ? parsed.parseStrategy : null,
  });

  linkDebug.parsed_item_id = parsed.ok
    ? parsed.itemId ?? (parsed.idType === "item" ? parsed.id : null)
    : null;
  linkDebug.parsed_catalog_product_id = parsed.ok ? parsed.catalogProductId ?? null : null;
  linkDebug.slug_query = slugFromUrl;
  pushLinkDebugStep(linkDebug, "parse");

  if (!parsed.ok) {
    if (slugFromUrl && accessToken && product?.id) {
      parsed = {
        ok: true,
        id: null,
        itemId: null,
        catalogProductId: null,
        idType: "slug_only",
        source: "slug_after_parse_fail",
        parseStrategy: "slug_recovery",
        normalizedUrl: parsed.normalizedUrl ?? rawUrl,
        slug: slugFromUrl,
      };
      pushLinkDebugStep(linkDebug, "parse_slug_recovery");
    } else {
      return finalizeFailure({
        code: parsed.code ?? "link_unresolved",
        error: parsed.error ?? UNRESOLVED_MESSAGE,
        item_id: null,
        health: { missing_required_fields: ["parse_failed"] },
        linkDebug,
      });
    }
  }

  if (!accessToken) {
    return {
      ok: false,
      error: "Conecte uma conta do Mercado Livre em Integrações para buscar anúncios por link.",
      code: "ml_token_unavailable",
      linkDebug: buildResolveLinkFailureDebug(linkDebug),
    };
  }

  if (debug) {
    debug.parse_ok = true;
    debug.id = parsed.itemId ?? parsed.id;
    debug.id_type = parsed.idType;
    debug.attempts = [];
  }

  let baseRaw = null;
  const anchoredItemId = parsed.itemId != null ? String(parsed.itemId).trim() : null;
  linkDebug.anchored_item_id = anchoredItemId;
  let listingId = parsed.itemId ?? (parsed.idType === "item" ? parsed.id : null);
  let resolvedVia = null;
  const permalink = resolvePermalinkFromUrl(rawUrl, listingId || parsed.catalogProductId || parsed.id);
  let itemFetchStatus = null;

  // slug only → discovery direto
  if (parsed.idType === "slug_only" && !listingId) {
    pushLinkDebugStep(linkDebug, "slug_discovery");
    const discovery = await runDiscoveryFallback({
      accessToken,
      userId,
      product,
      listingRow,
      context,
      targetListingId: null,
      permalink,
      parsed,
      rawUrl,
      titleHint: null,
      linkDebug,
      reason: "slug_only_url",
    });
    if (discovery?.candidate) {
      const health = assessLinkCandidateHealth(discovery.candidate);
      logS7LinkDebug06Final({
        item_id: discovery.candidate.competitor_listing_id,
        healthy: health.healthy,
        source_strategy: discovery.source_strategy,
        ...health,
      });
      if (health.healthy) {
        const metaDone = await ensureCandidateBoostFromDiscovery({
          accessToken,
          userId,
          product,
          listingRow,
          context,
          candidate: discovery.candidate,
          sourceStrategy: discovery.source_strategy,
          rawUrl,
          resolvedVia: `discovery_${discovery.matched_by}`,
        });
        const finalCandidate = metaDone.candidate;
        const finalHealth = assessLinkCandidateHealth(finalCandidate);
        return {
          ok: true,
          candidate: finalCandidate,
          item_id: finalCandidate.competitor_listing_id,
          partial: false,
          resolved_via: metaDone.resolvedVia ?? `discovery_${discovery.matched_by}`,
          healthy: finalHealth.healthy,
          enrich_status: "complete",
          enrich_missing_fields: [],
          source_strategy: metaDone.sourceStrategy,
          linkDebug,
        };
      }
      if (isPreviewResolvableCandidate(discovery.candidate)) {
        let partialCand = mergeThumbnailIntoCandidate(discovery.candidate, discovery.candidate);
        const boosted = await ensureCandidateBoostFromDiscovery({
          accessToken,
          userId,
          product,
          listingRow,
          context,
          candidate: partialCand,
          sourceStrategy: discovery.source_strategy,
          rawUrl,
          resolvedVia: `discovery_${discovery.matched_by}`,
        });
        partialCand = mergeThumbnailIntoCandidate(boosted.candidate, boosted.candidate);
        return returnPartialPreview({
          candidate: partialCand,
          sourceStrategy: boosted.sourceStrategy,
          resolvedVia: boosted.resolvedVia ?? `discovery_${discovery.matched_by}`,
          linkDebug,
          enrichOut: null,
          debug,
          itemFetchStatus: null,
        });
      }
    }
    return finalizeFailure({
      code: "link_slug_ambiguous",
      error: SLUG_AMBIGUOUS_MESSAGE,
      item_id: null,
      health: { missing_required_fields: ["no_healthy_slug_match"] },
      linkDebug,
    });
  }

  if (parsed.catalogProductId && !listingId) {
    pushLinkDebugStep(linkDebug, "catalog_resolve");
    const catHit = await resolveFromCatalogProduct(accessToken, parsed.catalogProductId, debug);
    if (catHit?.raw) {
      baseRaw = catHit.raw;
      listingId = catHit.raw.competitor_listing_id;
      resolvedVia = catHit.via;
    }
  }

  if (listingId) {
    pushLinkDebugStep(linkDebug, "item_fetch");
    const itemRes = await tryFetchItem(accessToken, listingId);
    itemFetchStatus = itemRes.status;
    linkDebug.item_fetch_status = itemRes.status;

    const sellerIdFromItem = pickSellerIdFromItem(itemRes.item);
    logS7LinkDebug02ItemFetch({
      item_id: listingId,
      endpoint: `/items/${listingId}`,
      ok: itemRes.ok,
      status: itemRes.status,
      error_code: itemRes.ok ? null : `http_${itemRes.status}`,
      has_title: Boolean(itemRes.item?.title),
      has_price: itemRes.item?.price != null,
      has_thumbnail: Boolean(itemRes.item?.thumbnail || itemRes.item?.secure_thumbnail),
      has_permalink: Boolean(itemRes.item?.permalink),
      seller_id: sellerIdFromItem,
      listing_type_id: itemRes.item?.listing_type_id ?? null,
      free_shipping: itemRes.item?.shipping?.free_shipping === true ? true : null,
    });

    pushAttempt(debug, {
      endpoint: `/items/${listingId}`,
      status: itemRes.status,
      body: safeBodySummary(itemRes.body),
    });

    if (itemRes.ok && itemRes.item) {
      baseRaw = mergeCompetitorRawFields(baseRaw, mlItemBodyToCandidateRaw(itemRes.item));
      resolvedVia = resolvedVia ? `${resolvedVia}+items_api` : "items_api";
      baseRaw = await enrichSellerOnRaw(accessToken, baseRaw, debug, linkDebug);
    } else if (
      !itemRes.ok &&
      itemRes.status === 404 &&
      parsed.catalogProductId &&
      listingId === parsed.catalogProductId
    ) {
      logCompetitionLinkParseWarning({
        original_url: rawUrl,
        parsed_value: listingId,
        expected_pattern: "catalog_product_resolve",
        reason: "item_404_catalog_id_fallback",
      });
      listingId = null;
      pushLinkDebugStep(linkDebug, "catalog_resolve_after_item_404");
      const catHit = await resolveFromCatalogProduct(accessToken, parsed.catalogProductId, debug);
      if (catHit?.raw?.competitor_listing_id) {
        baseRaw = mergeCompetitorRawFields(baseRaw, catHit.raw);
        listingId = catHit.raw.competitor_listing_id;
        resolvedVia = catHit.via;
        itemFetchStatus = null;
      }
    }
  }

  if (listingId && parsed.catalogProductId) {
    const catMatch = await resolveFromCatalogProduct(
      accessToken,
      parsed.catalogProductId,
      debug,
      listingId
    );
    if (catMatch?.raw) {
      baseRaw = mergeCompetitorRawFields(baseRaw, catMatch.raw);
      resolvedVia = resolvedVia ? `${resolvedVia}+${catMatch.via}` : catMatch.via;
    }
  }

  if (!listingId) {
    // último recurso: discovery antes de link_unresolved
    if (product?.id) {
      const discovery = await runDiscoveryFallback({
        accessToken,
        userId,
        product,
        listingRow,
        context,
        targetListingId: null,
        permalink: rawUrl,
        parsed,
        rawUrl,
        titleHint: titleFromMercadoLivrePermalink(rawUrl),
        linkDebug,
        reason: "no_listing_id",
      });
      if (discovery?.candidate) {
        const health = assessLinkCandidateHealth(discovery.candidate);
        if (health.healthy) {
          const metaDone = await ensureCandidateBoostFromDiscovery({
            accessToken,
            userId,
            product,
            listingRow,
            context,
            candidate: discovery.candidate,
            sourceStrategy: discovery.source_strategy,
            rawUrl,
            resolvedVia: `discovery_${discovery.matched_by}`,
          });
          const finalCandidate = metaDone.candidate;
          listingId = finalCandidate.competitor_listing_id;
          return {
            ok: true,
            candidate: finalCandidate,
            item_id: listingId,
            partial: false,
            resolved_via: metaDone.resolvedVia ?? `discovery_${discovery.matched_by}`,
            healthy: assessLinkCandidateHealth(finalCandidate).healthy,
            enrich_status: "complete",
            enrich_missing_fields: [],
            source_strategy: metaDone.sourceStrategy,
            linkDebug,
          };
        }
        if (isPreviewResolvableCandidate(discovery.candidate)) {
          let partialCand = mergeThumbnailIntoCandidate(discovery.candidate, discovery.candidate);
          const boosted = await ensureCandidateBoostFromDiscovery({
            accessToken,
            userId,
            product,
            listingRow,
            context,
            candidate: partialCand,
            sourceStrategy: discovery.source_strategy,
            rawUrl,
            resolvedVia: `discovery_${discovery.matched_by}`,
          });
          partialCand = mergeThumbnailIntoCandidate(boosted.candidate, boosted.candidate);
          return returnPartialPreview({
            candidate: partialCand,
            sourceStrategy: boosted.sourceStrategy,
            resolvedVia: boosted.resolvedVia ?? `discovery_${discovery.matched_by}`,
            linkDebug,
            enrichOut: null,
            debug,
            itemFetchStatus: null,
          });
        }
      }
    }
    return finalizeFailure({
      code: "link_unresolved",
      error: UNRESOLVED_MESSAGE,
      item_id: null,
      health: { missing_required_fields: ["listing_id"] },
      linkDebug,
    });
  }

  pushLinkDebugStep(linkDebug, "enrich");
  const enrichOut = await enrichCompetitorListing(accessToken, {
    listingId: String(listingId),
    permalink: baseRaw?.competitor_permalink ?? permalink,
    titleHint: baseRaw?.competitor_title ?? titleFromMercadoLivrePermalink(rawUrl),
    debug,
  });

  let mergedRaw = mergeCompetitorRawFields(
    baseRaw || { competitor_listing_id: listingId, competitor_permalink: permalink },
    enrichOut?.raw
  );
  mergedRaw = await enrichSellerOnRaw(accessToken, mergedRaw, debug, linkDebug);

  let candidate = normalizeDiscoveredCompetitor(mergedRaw, SOURCE_STRATEGY);
  candidate = mergeThumbnailIntoCandidate(candidate, mergedRaw);
  candidate = await enrichThumbnailFromCatalogProduct(
    accessToken,
    candidate,
    parsed.catalogProductId,
    debug,
  );
  candidate = await enrichSellerOnCandidate(accessToken, candidate, debug, linkDebug);
  candidate = await enrichCandidateFromSiteSearch(accessToken, candidate, debug);
  candidate = await enrichThumbnailFromCatalogSearch(
    accessToken,
    candidate,
    rawUrl,
    debug,
    parsed.catalogProductId ?? null
  );
  candidate = await enrichCandidateFromPublicPage(rawUrl, candidate, debug);
  candidate = await enrichAnchoredThumbnailDeterministic({
    accessToken,
    candidate,
    anchoredItemId,
    catalogProductId: parsed.catalogProductId ?? null,
    rawUrl,
    debug,
  });
  let sourceStrategy = SOURCE_STRATEGY;
  let health = assessLinkCandidateHealth(candidate);

  // OBRIGATÓRIO: fallback discovery quando incompleto
  if (!health.healthy) {
    pushLinkDebugStep(linkDebug, "discovery_fallback_required");
    const candidateBeforeDiscovery = candidate;
    const discovery = await runDiscoveryFallback({
      accessToken,
      userId,
      product,
      listingRow,
      context,
      targetListingId: listingId,
      permalink,
      parsed,
      rawUrl,
      titleHint:
        candidate.competitor_title ||
        mergedRaw?.competitor_title ||
        parsed?.slug ||
        listingRow?.title ||
        product?.product_name ||
        null,
      linkDebug,
      reason: health.missing_required_fields?.length
        ? `missing:${health.missing_required_fields.join(",")}`
        : "enrich_incomplete",
    });

    if (discovery?.candidate) {
      const discoveredListingId = discovery?.candidate?.competitor_listing_id ?? null;
      const anchorMatchesDiscovery =
        !anchoredItemId || isSameAnchoredListing(discoveredListingId, anchoredItemId);
      logAnchorGuard({
        anchoredItemId,
        candidateListingId: discoveredListingId,
        swapBlocked: !anchorMatchesDiscovery,
        reason: anchorMatchesDiscovery
          ? `discovery_fallback_allowed:${discovery.matched_by ?? "unknown"}`
          : `discovery_fallback_blocked:${discovery.matched_by ?? "unknown"}`,
      });
      if (!anchorMatchesDiscovery) {
        linkDebug.anchor_swap_blocked = true;
        linkDebug.anchor_swap_reason = "discovery_candidate_listing_mismatch";
        candidate = candidateBeforeDiscovery;
      } else {
        candidate = discovery.candidate;
        linkDebug.anchor_swap_blocked = false;
      }
      candidate = mergeThumbnailIntoCandidate(candidate, candidate);
      candidate = await enrichThumbnailFromCatalogProduct(
        accessToken,
        candidate,
        parsed.catalogProductId,
        debug,
      );
      candidate = await enrichSellerOnCandidate(accessToken, candidate, debug, linkDebug);
      candidate = await enrichCandidateFromSiteSearch(accessToken, candidate, debug);
      candidate = await enrichThumbnailFromCatalogSearch(
        accessToken,
        candidate,
        rawUrl,
        debug,
        parsed.catalogProductId ?? null
      );
      candidate = await enrichCandidateFromPublicPage(rawUrl, candidate, debug);
      candidate = await enrichAnchoredThumbnailDeterministic({
        accessToken,
        candidate,
        anchoredItemId,
        catalogProductId: parsed.catalogProductId ?? null,
        rawUrl,
        debug,
      });
      if (anchorMatchesDiscovery) {
        sourceStrategy = discovery.source_strategy;
        resolvedVia = `discovery_${discovery.matched_by}`;
      }
      health = assessLinkCandidateHealth(candidate);
    } else if (!product?.id) {
      linkDebug.discovery_match_reason = "product_context_missing";
    }
  }

  if (isOwnCandidate(context, mergedRaw) || isOwnCandidate(context, candidate)) {
    return finalizeFailure({
      code: "own_listing",
      error: "Este link é do seu próprio anúncio. Cadastre um concorrente diferente.",
      item_id: listingId,
      health,
      linkDebug,
      sourceStrategy,
    });
  }

  linkDebug.missing_required_fields = health.missing_required_fields;
  linkDebug.final = {
    healthy: health.healthy,
    source_strategy: sourceStrategy,
    item_fetch_status: itemFetchStatus,
  };

  logS7LinkDebug06Final({
    item_id: candidate.competitor_listing_id,
    healthy: health.healthy,
    source_strategy: sourceStrategy,
    missing_required_fields: health.missing_required_fields,
    has_title: health.has_title,
    has_price: health.has_price,
    has_thumbnail: health.has_thumbnail,
    has_seller_nickname: health.has_seller_nickname,
    has_permalink: health.has_permalink,
    has_listing_type: health.has_listing_type,
    has_frete_hint: health.has_frete_hint,
    has_seller_reputation: health.has_seller_reputation,
  });

  if (debug) {
    debug.normalize_ok = health.healthy;
    debug.resolved_via = resolvedVia ?? enrichOut?.enrichSource ?? null;
    debug.enrich_fields_found = enrichOut?.fieldsFound ?? [];
    debug.enrich_fields_missing = enrichOut?.fieldsMissing ?? [];
    debug.partial = !health.healthy;
    debug.final_code = health.healthy ? null : null;
    debug.link_debug = linkDebug;
  }

  if (!health.healthy) {
    if (!isPreviewResolvableCandidate(candidate)) {
      const minimalRaw = buildMinimalCandidateFromLink(listingId, rawUrl);
      candidate = normalizeDiscoveredCompetitor(minimalRaw, SOURCE_STRATEGY);
      sourceStrategy = SOURCE_STRATEGY;
      health = assessLinkCandidateHealth(candidate);
    }
    if (isPreviewResolvableCandidate(candidate)) {
      const completed = await tryDiscoveryCompletionForCandidate({
        accessToken,
        userId,
        product,
        listingRow,
        context,
        candidate,
        sourceStrategy,
        rawUrl,
      });
      candidate = mergeThumbnailIntoCandidate(completed.candidate, completed.candidate);
      candidate = await enrichThumbnailFromCatalogProduct(
        accessToken,
        candidate,
        parsed.catalogProductId,
        debug,
      );
      candidate = await enrichSellerOnCandidate(accessToken, candidate, debug, linkDebug);
      candidate = await enrichCandidateFromSiteSearch(accessToken, candidate, debug);
      candidate = await enrichThumbnailFromCatalogSearch(
        accessToken,
        candidate,
        rawUrl,
        debug,
        parsed.catalogProductId ?? null
      );
      candidate = await enrichCandidateFromPublicPage(rawUrl, candidate, debug);
      candidate = await enrichAnchoredThumbnailDeterministic({
        accessToken,
        candidate,
        anchoredItemId,
        catalogProductId: parsed.catalogProductId ?? null,
        rawUrl,
        debug,
      });
      sourceStrategy = completed.sourceStrategy;
      const boosted = await ensureCandidateBoostFromDiscovery({
        accessToken,
        userId,
        product,
        listingRow,
        context,
        candidate,
        sourceStrategy,
        rawUrl,
        resolvedVia: completed.completed
          ? `${resolvedVia ?? "partial"}+discovery_completion`
          : resolvedVia,
      });
      candidate = mergeThumbnailIntoCandidate(boosted.candidate, boosted.candidate);
      candidate = await enrichThumbnailFromCatalogProduct(
        accessToken,
        candidate,
        parsed.catalogProductId,
        debug,
      );
      candidate = await enrichSellerOnCandidate(accessToken, candidate, debug, linkDebug);
      candidate = await enrichCandidateFromSiteSearch(accessToken, candidate, debug);
      candidate = await enrichThumbnailFromCatalogSearch(
        accessToken,
        candidate,
        rawUrl,
        debug,
        parsed.catalogProductId ?? null
      );
      candidate = await enrichCandidateFromPublicPage(rawUrl, candidate, debug);
      candidate = await enrichAnchoredThumbnailDeterministic({
        accessToken,
        candidate,
        anchoredItemId,
        catalogProductId: parsed.catalogProductId ?? null,
        rawUrl,
        debug,
      });
      sourceStrategy = boosted.sourceStrategy;
      health = assessLinkCandidateHealth(candidate);
      if (health.healthy) {
        if (anchoredItemId && !isSameAnchoredListing(candidate.competitor_listing_id, anchoredItemId)) {
          logAnchorGuard({
            anchoredItemId,
            candidateListingId: candidate.competitor_listing_id ?? null,
            swapBlocked: true,
            reason: "final_complete_candidate_listing_mismatch_forced_partial",
          });
          const anchoredRaw = mergeCompetitorRawFields(
            buildMinimalCandidateFromLink(anchoredItemId, rawUrl),
            mergedRaw
          );
          anchoredRaw.competitor_listing_id = anchoredItemId;
          const anchoredCandidate = normalizeDiscoveredCompetitor(anchoredRaw, SOURCE_STRATEGY);
          return returnPartialPreview({
            candidate: anchoredCandidate,
            sourceStrategy: SOURCE_STRATEGY,
            resolvedVia: "anchor_guard_forced_partial",
            linkDebug,
            enrichOut,
            debug,
            itemFetchStatus,
          });
        }
        logAnchorGuard({
          anchoredItemId,
          candidateListingId: candidate.competitor_listing_id ?? null,
          swapBlocked: false,
          reason: "final_complete_candidate_listing_matches_anchor",
        });
        candidate = finalizeLinkCandidate(candidate, rawUrl);
        return {
          ok: true,
          candidate,
          item_id: candidate.competitor_listing_id,
          partial: false,
          resolved_via: boosted.resolvedVia ?? resolvedVia ?? enrichOut?.enrichSource ?? "enriched",
          healthy: true,
          enrich_status: "complete",
          enrich_missing_fields: [],
          source_strategy: sourceStrategy,
          linkDebug,
        };
      }
      return returnPartialPreview({
        candidate,
        sourceStrategy,
        resolvedVia: completed.completed ? `${resolvedVia ?? "partial"}+discovery_completion` : resolvedVia,
        linkDebug,
        enrichOut,
        debug,
        itemFetchStatus,
      });
    }
    return finalizeFailure({
      code: "link_unresolved",
      error: UNRESOLVED_MESSAGE,
      item_id: listingId,
      health,
      sourceStrategy,
      linkDebug,
      resolvedVia,
    });
  }

  const metaDone = await ensureCandidateBoostFromDiscovery({
    accessToken,
    userId,
    product,
    listingRow,
    context,
    candidate,
    sourceStrategy,
    rawUrl,
    resolvedVia: resolvedVia ?? enrichOut?.enrichSource ?? "enriched",
  });
  candidate = metaDone.candidate;
  candidate = await enrichThumbnailFromCatalogProduct(
    accessToken,
    candidate,
    parsed.catalogProductId,
    debug,
  );
  candidate = await enrichSellerOnCandidate(accessToken, candidate, debug, linkDebug);
  candidate = await enrichAnchoredThumbnailDeterministic({
    accessToken,
    candidate,
    anchoredItemId,
    catalogProductId: parsed.catalogProductId ?? null,
    rawUrl,
    debug,
  });
  sourceStrategy = metaDone.sourceStrategy;
  health = assessLinkCandidateHealth(candidate);
  if (anchoredItemId && !isSameAnchoredListing(candidate.competitor_listing_id, anchoredItemId)) {
    logAnchorGuard({
      anchoredItemId,
      candidateListingId: candidate.competitor_listing_id ?? null,
      swapBlocked: true,
      reason: "final_candidate_listing_mismatch_forced_partial",
    });
    const anchoredRaw = mergeCompetitorRawFields(
      buildMinimalCandidateFromLink(anchoredItemId, rawUrl),
      mergedRaw
    );
    anchoredRaw.competitor_listing_id = anchoredItemId;
    const anchoredCandidate = normalizeDiscoveredCompetitor(anchoredRaw, SOURCE_STRATEGY);
    return returnPartialPreview({
      candidate: anchoredCandidate,
      sourceStrategy: SOURCE_STRATEGY,
      resolvedVia: "anchor_guard_forced_partial",
      linkDebug,
      enrichOut,
      debug,
      itemFetchStatus,
    });
  }
  logAnchorGuard({
    anchoredItemId,
    candidateListingId: candidate.competitor_listing_id ?? null,
    swapBlocked: false,
    reason: "final_candidate_listing_matches_anchor",
  });
  candidate = finalizeLinkCandidate(candidate, rawUrl);

  return {
    ok: true,
    candidate,
    item_id: candidate.competitor_listing_id,
    partial: false,
    resolved_via: metaDone.resolvedVia ?? resolvedVia ?? enrichOut?.enrichSource ?? "enriched",
    healthy: health.healthy,
    enrich_status: "complete",
    enrich_missing_fields: [],
    source_strategy: sourceStrategy,
    linkDebug,
  };
}

export async function resolveCompetitorFromMercadoLivreLink(params) {
  return resolveCompetitionCandidateFromLink(params);
}
