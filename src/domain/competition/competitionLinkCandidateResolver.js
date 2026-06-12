// ============================================================
// S7 — Concorrência: resolver único de link → candidato saudável
// Fallback progressivo: item API → enrich → discovery (busca por nome).
// ============================================================

import {
  fetchItem,
  fetchCatalogProduct,
  fetchCatalogProductItemsSafe,
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
import { titleFromMercadoLivrePermalink, buildMercadoLivreItemPermalink } from "./mlListingDisplay.js";
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

  if (targetListingId) {
    const row = itemsRes.results.find(
      (r) => r?.item_id != null && String(r.item_id).trim() === String(targetListingId).trim()
    );
    if (row) {
      try {
        const detail = await fetchCatalogProduct(accessToken, productId);
        meta.name = detail?.name != null ? String(detail.name) : null;
        meta.thumbnail = pickCatalogProductThumbnail(detail);
      } catch {
        /* ignore */
      }
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
    const detail = await fetchCatalogProduct(accessToken, productId);
    meta.name = detail?.name != null ? String(detail.name) : null;
    meta.thumbnail = pickCatalogProductThumbnail(detail);
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
  let sourceStrategy = SOURCE_STRATEGY;
  let health = assessLinkCandidateHealth(candidate);

  // OBRIGATÓRIO: fallback discovery quando incompleto
  if (!health.healthy) {
    pushLinkDebugStep(linkDebug, "discovery_fallback_required");
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
      titleHint: candidate.competitor_title || mergedRaw?.competitor_title,
      linkDebug,
      reason: health.missing_required_fields?.length
        ? `missing:${health.missing_required_fields.join(",")}`
        : "enrich_incomplete",
    });

    if (discovery?.candidate) {
      candidate = mergeThumbnailIntoCandidate(discovery.candidate, discovery.candidate);
      sourceStrategy = discovery.source_strategy;
      health = assessLinkCandidateHealth(candidate);
      resolvedVia = `discovery_${discovery.matched_by}`;
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
      sourceStrategy = boosted.sourceStrategy;
      health = assessLinkCandidateHealth(candidate);
      if (health.healthy) {
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
  sourceStrategy = metaDone.sourceStrategy;
  health = assessLinkCandidateHealth(candidate);
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
