// ============================================================
// S7 — Concorrência: fallback de link via discovery (busca por nome)
// Reutiliza CompetitionEngine no modo broad search.
// ============================================================

import { CompetitionEngine } from "./CompetitionEngine.js";
import { extractBrandGtinFromRawJson } from "./strategies/mlCompetitorMapping.js";
import { titleFromMercadoLivrePermalink } from "./mlListingDisplay.js";
import { assessLinkCandidateHealth } from "./competitionEnrichHelpers.js";
import { pickDiscoveryMatchForPartial } from "./competitionLinkDiscoveryCompletion.js";
import { normalizeDiscoveredCompetitor } from "./competitionNormalizer.js";
import {
  logS7LinkDebug04DiscoveryFallbackStart,
  logS7LinkDebug05DiscoveryFallbackResult,
  sampleCandidatesForDebug,
} from "./competitionLinkDebug.js";

const engine = new CompetitionEngine();

function normalizeListingId(id) {
  const s = id != null ? String(id).trim().toUpperCase() : "";
  return s || null;
}

function listingDigits(id) {
  const n = normalizeListingId(id);
  if (!n) return null;
  const m = n.match(/^ML[ABCU](\d+)$/i);
  return m?.[1] ?? null;
}

function candidateMatchesTarget(candidate, targetListingId, permalink) {
  const target = normalizeListingId(targetListingId);
  const candId = normalizeListingId(candidate?.competitor_listing_id);
  if (target && candId && target === candId) return true;

  const pl = String(candidate?.competitor_permalink || permalink || "").toUpperCase();
  if (target && pl.includes(target)) return true;

  const digits = listingDigits(target);
  if (digits && pl.includes(digits)) return true;

  return false;
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

function explainNoMatch(list, healthy, targetListingId) {
  if (!targetListingId) {
    if (list.length === 0) return "discovery_returned_zero_candidates";
    if (healthy.length === 0) return "candidates_found_but_none_healthy";
    if (healthy.length > 1) return "multiple_healthy_no_target_listing_id";
    return "no_match_unknown";
  }
  const exactAny = list.find((c) => candidateMatchesTarget(c, targetListingId, null));
  if (exactAny) {
    const h = assessLinkCandidateHealth(exactAny);
    if (!h.healthy) return `listing_id_found_but_unhealthy:${h.missing_required_fields.join(",")}`;
    return "listing_id_in_results_but_not_selected";
  }
  if (list.length === 0) return "discovery_returned_zero_candidates";
  if (healthy.length === 0) return "candidates_found_but_none_healthy";
  return "listing_id_not_in_discovery_results";
}

function buildDiscoveryContext({
  accessToken,
  userId,
  product,
  listingRow,
  ownSellerId,
  ownListingId,
  query,
}) {
  const rawJson = listingRow?.raw_json && typeof listingRow.raw_json === "object" ? listingRow.raw_json : null;
  const { brand, gtin } = extractBrandGtinFromRawJson(rawJson);
  const debug = { strategy_attempted: [], search_queries_attempted: [], attempts: [] };

  return {
    userId,
    marketplace: "mercado_livre",
    accessToken,
    limit: 40,
    catalogOffset: 0,
    excludeListingIds: [],
    broadSearch: true,
    searchOnly: true,
    query: String(query || "").trim(),
    product: {
      id: product?.id ?? null,
      sku: product?.sku ?? null,
      product_name: product?.product_name ?? null,
    },
    listing: {
      externalListingId: listingRow?.external_listing_id ?? null,
      catalogProductId: listingRow?.catalog_product_id ?? null,
      catalogListing: Boolean(listingRow?.catalog_listing),
      categoryId: listingRow?.category_id ?? null,
      title: listingRow?.title ?? null,
      brand,
      gtin,
    },
    ownListingId: ownListingId ?? listingRow?.external_listing_id ?? null,
    ownSellerId: ownSellerId ?? null,
    debug,
  };
}

async function runDiscoveryQuery({
  accessToken,
  userId,
  product,
  listingRow,
  ownSellerId,
  ownListingId,
  targetListingId,
  permalink,
  query,
  queryType,
  reason,
  slugQuery,
  titleQuery,
}) {
  const q = String(query || "").trim();
  if (!q) return null;

  logS7LinkDebug04DiscoveryFallbackStart({
    reason,
    item_id: targetListingId ?? null,
    slug_query: slugQuery ?? null,
    title_query: titleQuery ?? null,
    query_used: q,
    query_type: queryType ?? null,
  });

  const context = buildDiscoveryContext({
    accessToken,
    userId,
    product,
    listingRow,
    ownSellerId,
    ownListingId,
    query: q,
  });

  const { strategy, results } = await engine.discover(context);
  const list = Array.isArray(results) ? results : [];
  const healthy = list.filter((c) => assessLinkCandidateHealth(c).healthy);

  const hit = pickDiscoveryMatchForPartial(list, {
    listingId: targetListingId,
    permalink,
    title: titleQuery,
  });

  let matched = hit?.candidate ?? null;
  let matchedBy = hit?.matched_by ?? null;

  if (!matched && healthy.length === 1 && !targetListingId) {
    matched = healthy[0];
    matchedBy = "single_healthy_match";
  }

  if (matched && targetListingId && !candidateMatchesTarget(matched, targetListingId, permalink)) {
    logAnchorGuard({
      anchoredItemId: targetListingId,
      candidateListingId: matched?.competitor_listing_id ?? null,
      swapBlocked: true,
      reason: `discovery_fallback_mismatch:${matchedBy || "unknown_match"}`,
    });
    matched = null;
    matchedBy = null;
  } else {
    logAnchorGuard({
      anchoredItemId: targetListingId,
      candidateListingId: matched?.competitor_listing_id ?? null,
      swapBlocked: false,
      reason: matched ? `discovery_fallback_match:${matchedBy || "unknown_match"}` : "no_match",
    });
  }

  const health = matched ? assessLinkCandidateHealth(matched) : { healthy: false, missing_required_fields: [] };
  const noMatchReason = matched ? null : explainNoMatch(list, healthy, targetListingId);

  logS7LinkDebug05DiscoveryFallbackResult({
    query_used: q,
    query_type: queryType ?? null,
    total_candidates: list.length,
    healthy_candidates: healthy.length,
    matched: Boolean(matched),
    matched_by: matchedBy,
    matched_item_id: matched?.competitor_listing_id ?? null,
    matched_title: matched?.competitor_title != null ? String(matched.competitor_title).slice(0, 80) : null,
    healthy: health.healthy,
    missing_required_fields: health.missing_required_fields ?? [],
    no_match_reason: noMatchReason,
    sample_candidates: sampleCandidatesForDebug(list, 10),
    strategy,
  });

  if (!matched) {
    return {
      matched: null,
      meta: {
        query: q,
        queryType,
        total: list.length,
        healthyCount: healthy.length,
        noMatchReason,
        sample: sampleCandidatesForDebug(list, 10),
        strategy,
      },
    };
  }

  return {
    matched: {
      candidate: normalizeDiscoveredCompetitor(
        { ...matched, source_strategy: "ml_link_via_discovery_fallback" },
        "ml_link_via_discovery_fallback"
      ),
      matched_by: matchedBy,
      source_strategy: "ml_link_via_discovery_fallback",
      partial: !health.healthy,
    },
    meta: {
      query: q,
      queryType,
      total: list.length,
      matchedBy,
      healthy: health.healthy,
      strategy,
    },
  };
}

/**
 * Tenta múltiplas queries (item_id → slug → título → produto).
 * @param {object} params
 * @param {string[]} [params.queries] — lista de { query, type } ou strings
 */
export async function discoverHealthyCandidateForLink({
  accessToken,
  userId,
  product,
  listingRow,
  ownSellerId,
  ownListingId,
  targetListingId,
  query,
  queries,
  permalink,
  reason = "enrich_incomplete",
  slugQuery = null,
  titleQuery = null,
  linkDebug = null,
}) {
  if (!accessToken || !product?.id) return null;

  const queryEntries = [];
  if (Array.isArray(queries)) {
    for (const entry of queries) {
      if (typeof entry === "string") queryEntries.push({ query: entry, type: "custom" });
      else if (entry?.query) queryEntries.push({ query: entry.query, type: entry.type ?? "custom" });
    }
  }
  if (query && !queryEntries.some((e) => e.query === query)) {
    queryEntries.unshift({ query, type: "primary" });
  }
  if (queryEntries.length === 0) return null;

  if (linkDebug) {
    linkDebug.discovery_queries_tried = [];
  }

  let lastMeta = null;

  for (const { query: q, type } of queryEntries) {
    const out = await runDiscoveryQuery({
      accessToken,
      userId,
      product,
      listingRow,
      ownSellerId,
      ownListingId,
      targetListingId,
      permalink,
      query: q,
      queryType: type,
      reason,
      slugQuery,
      titleQuery,
    });

    if (linkDebug) {
      linkDebug.discovery_queries_tried.push({
        query: q,
        type,
        total: out?.meta?.total ?? 0,
        matched: Boolean(out?.matched),
        no_match_reason: out?.meta?.noMatchReason ?? null,
      });
      if (out?.meta?.sample) {
        linkDebug.discovery_sample_candidates = out.meta.sample;
        linkDebug.discovery_fallback_total = out.meta.total;
      }
    }

    lastMeta = out?.meta ?? lastMeta;
    if (out?.matched) {
      if (linkDebug) {
        linkDebug.discovery_fallback_matched = true;
        linkDebug.discovery_match_reason = out.meta?.matchedBy ?? type;
        linkDebug.discovery_fallback_total = out.meta?.total ?? null;
      }
      return out.matched;
    }
  }

  if (linkDebug) {
    linkDebug.discovery_fallback_matched = false;
    linkDebug.discovery_match_reason = lastMeta?.noMatchReason ?? "all_queries_exhausted";
    linkDebug.discovery_fallback_total = lastMeta?.total ?? linkDebug.discovery_fallback_total;
  }

  return null;
}

/** Monta lista ordenada de queries para fallback discovery. */
export function buildLinkDiscoveryQueries({ parsed, rawUrl, titleHint, listingId, product }) {
  const entries = [];
  const seen = new Set();
  const push = (q, type) => {
    const s = String(q || "").trim();
    if (s.length < 2 || seen.has(s.toLowerCase())) return;
    seen.add(s.toLowerCase());
    entries.push({ query: s, type });
  };

  if (listingId) {
    push(listingId, "item_id_full");
    const digits = String(listingId).replace(/^ML[ABCU]/i, "").trim();
    if (digits.length >= 6) push(digits, "item_id_digits");
  }

  const slug = parsed?.slug || null;
  if (slug) push(slug, "url_slug");

  if (titleHint) push(titleHint, "title_partial");

  if (rawUrl) {
    const fromPermalink = titleFromMercadoLivrePermalink(rawUrl);
    if (fromPermalink) push(fromPermalink, "permalink_title");
  }

  if (product?.product_name) push(String(product.product_name).trim(), "product_name");

  return entries;
}
