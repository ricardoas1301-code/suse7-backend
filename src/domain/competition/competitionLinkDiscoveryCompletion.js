// ============================================================
// S7 — Concorrência: completar concorrente parcial via discovery
// Reutiliza CompetitionEngine (mesmo pipeline da busca por nome).
// ============================================================

import { CompetitionEngine } from "./CompetitionEngine.js";
import { extractBrandGtinFromRawJson } from "./strategies/mlCompetitorMapping.js";
import { titleFromMercadoLivrePermalink } from "./mlListingDisplay.js";
import { buildLinkDiscoveryQueries } from "./competitionLinkDiscoveryFallback.js";
import {
  assessLinkCandidateHealth,
  computeEnrichStatus,
  isEnrichResultComplete,
  mergeNonemptyCompetitorPatch,
} from "./competitionEnrichHelpers.js";
import {
  discoveredCandidateToSaveNormalized,
  enrichExtrasFromDiscoveredCandidate,
} from "./competitionNormalizer.js";

const engine = new CompetitionEngine();

export function canonicalizeMercadoLivreListingId(listingId) {
  const raw = listingId != null ? String(listingId).trim() : "";
  if (!raw) return null;
  const compact = raw.toUpperCase().replace(/-/g, "");
  const m = compact.match(/^(ML[ABCU])(\d{6,})$/);
  if (m) return `${m[1]}${m[2]}`;
  return raw.toUpperCase();
}

function isSameListingId(a, b) {
  const aa = canonicalizeMercadoLivreListingId(a);
  const bb = canonicalizeMercadoLivreListingId(b);
  return Boolean(aa && bb && aa === bb);
}

function listingDigits(id) {
  const n = canonicalizeMercadoLivreListingId(id);
  if (!n) return null;
  const m = n.match(/^ML[ABCU](\d+)$/i);
  return m?.[1] ?? null;
}

function canonicalizePermalink(url) {
  const raw = url != null ? String(url).trim() : "";
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const path = decodeURIComponent(u.pathname).toUpperCase().replace(/\/+$/, "");
    const host = u.hostname.toLowerCase();
    const idMatch = path.match(/ML[ABCU]-?(\d{6,})/i);
    const digits = idMatch?.[1] ?? null;
    return digits ? `${host}|${digits}` : `${host}|${path}`;
  } catch {
    return raw.toUpperCase();
  }
}

function normalizeTitleForMatch(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titlesHighlySimilar(a, b) {
  const ta = normalizeTitleForMatch(a);
  const tb = normalizeTitleForMatch(b);
  if (!ta || !tb || ta.length < 8 || tb.length < 8) return false;
  if (ta === tb) return true;
  if (ta.includes(tb) || tb.includes(ta)) return true;
  const wordsA = new Set(ta.split(" ").filter((w) => w.length > 2));
  const wordsB = tb.split(" ").filter((w) => w.length > 2);
  if (wordsB.length === 0) return false;
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;
  return overlap / wordsB.length >= 0.75;
}

function pricesCompatible(priceA, priceB) {
  const a = Number(priceA);
  const b = Number(priceB);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return true;
  const diff = Math.abs(a - b) / Math.max(a, b);
  return diff <= 0.05;
}

function pickBestFromPool(pool, preferHealthy = true) {
  const list = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (list.length === 0) return null;
  if (preferHealthy) {
    const healthy = list.find((c) => assessLinkCandidateHealth(c).healthy);
    if (healthy) return healthy;
  }
  return list[0];
}

/**
 * Match por prioridade: item_id → permalink contém id → permalink canônico → título+preço.
 */
export function pickDiscoveryMatchForPartial(candidates, { listingId, permalink, title, price }) {
  const list = Array.isArray(candidates) ? candidates : [];
  const targetId = canonicalizeMercadoLivreListingId(listingId);
  const digits = listingDigits(targetId);

  if (targetId) {
    const byId = list.filter(
      (c) => canonicalizeMercadoLivreListingId(c?.competitor_listing_id) === targetId
    );
    if (byId.length) {
      return { candidate: pickBestFromPool(byId), matched_by: "external_item_id" };
    }

    const byPermalinkId = list.filter((c) => {
      const pl = String(c?.competitor_permalink || "").toUpperCase();
      return pl.includes(targetId) || (digits != null && pl.includes(digits));
    });
    if (byPermalinkId.length) {
      return { candidate: pickBestFromPool(byPermalinkId), matched_by: "permalink_contains_item_id" };
    }
  }

  const canon = canonicalizePermalink(permalink);
  if (canon) {
    const byCanon = list.filter((c) => canonicalizePermalink(c?.competitor_permalink) === canon);
    if (byCanon.length) {
      return { candidate: pickBestFromPool(byCanon), matched_by: "permalink_canonical" };
    }
  }

  if (title) {
    const byTitle = list.filter(
      (c) => titlesHighlySimilar(title, c?.competitor_title) && pricesCompatible(price, c?.competitor_price)
    );
    if (!targetId && byTitle.length) {
      return { candidate: pickBestFromPool(byTitle), matched_by: "title_price_similar" };
    }
    // Com item_id ancorado, nunca usamos match por título/preço para evitar swap.
  }

  return null;
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
    debug: { strategy_attempted: [], search_queries_attempted: [], attempts: [] },
  };
}

/** Copia campos do candidato discovery para normalized + extras. */
export function mergeDiscoveryMatchIntoPartial(normalized, enrichExtras, discoveryCandidate) {
  const base = normalized && typeof normalized === "object" ? { ...normalized } : {};
  const extras = enrichExtras && typeof enrichExtras === "object" ? { ...enrichExtras } : {};
  const copiedFields = [];

  if (!discoveryCandidate) {
    return { normalized: base, enrichExtras: extras, copied_fields: copiedFields };
  }

  const fromNorm = discoveredCandidateToSaveNormalized(discoveryCandidate);
  const fromExtras = enrichExtrasFromDiscoveredCandidate(discoveryCandidate);

  const fieldMap = [
    ["competitor_title", "title"],
    ["last_seen_price", "price"],
    ["last_seen_currency", "currency_id"],
    ["competitor_thumbnail", "thumbnail"],
    ["competitor_permalink", "permalink"],
    ["competitor_store_name", "seller_nickname"],
    ["competitor_seller_id", "seller_id"],
  ];

  for (const [key, label] of fieldMap) {
    const current = base[key];
    const incoming = fromNorm[key];
    if ((current == null || current === "") && incoming != null && incoming !== "") {
      base[key] = incoming;
      copiedFields.push(label);
    }
  }

  if (!extras.sales_hint && fromExtras.sales_hint) {
    extras.sales_hint = fromExtras.sales_hint;
    copiedFields.push("sales_hint");
  }
  if (fromExtras.listing_type && !extras.listing_type) {
    extras.listing_type = fromExtras.listing_type;
    copiedFields.push("listing_type");
  }
  const ship = fromExtras.shipping && typeof fromExtras.shipping === "object" ? fromExtras.shipping : null;
  const existingShip = extras.shipping && typeof extras.shipping === "object" ? extras.shipping : null;
  const shipAddsValue =
    ship &&
    (ship.free_shipping === true ||
      (ship.mode && !existingShip?.mode) ||
      (ship.logistic_type && !existingShip?.logistic_type));
  if (shipAddsValue) {
    extras.shipping = { ...(existingShip || {}), ...ship };
    if (ship.free_shipping === true) copiedFields.push("free_shipping");
    copiedFields.push("frete_hint");
  }
  const rep = fromExtras.reputation && typeof fromExtras.reputation === "object" ? fromExtras.reputation : null;
  const existingRep = extras.reputation && typeof extras.reputation === "object" ? extras.reputation : null;
  if (rep && (rep.level_id || rep.power_seller_status)) {
    const upgradesRep =
      !existingRep?.level_id && !existingRep?.power_seller_status;
    if (upgradesRep || rep.power_seller_status || rep.level_id) {
      extras.reputation = { ...(existingRep || {}), ...rep };
      copiedFields.push("seller_reputation");
    }
  }

  if (base.last_seen_price != null && !base.last_captured_at) {
    base.last_captured_at = new Date().toISOString();
  }

  return {
    normalized: mergeNonemptyCompetitorPatch(base, {}),
    enrichExtras: extras,
    copied_fields: [...new Set(copiedFields)],
  };
}

/**
 * Tenta completar concorrente parcial usando discovery (busca por nome).
 */
export async function completePartialCompetitorViaDiscovery({
  accessToken,
  userId,
  product,
  listingRow,
  ownSellerId = null,
  ownListingId = null,
  normalized,
  enrichExtras = {},
  competitorId = null,
  rawUrl = null,
}) {
  const row = normalized && typeof normalized === "object" ? normalized : {};
  const extras = enrichExtras && typeof enrichExtras === "object" ? enrichExtras : {};

  const statusBefore = computeEnrichStatus(row, extras);
  const thumbMissing = !row.competitor_thumbnail;
  if ((isEnrichResultComplete(row, extras) && !thumbMissing) || !accessToken || !product?.id) {
    return {
      matched: false,
      normalized: row,
      enrichExtras: extras,
      enrich_status_before: statusBefore.enrich_status,
      enrich_status_after: statusBefore.enrich_status,
      missing_fields_before: statusBefore.enrich_missing_fields,
      missing_fields_after: statusBefore.enrich_missing_fields,
    };
  }

  const listingId = row.competitor_listing_id;
  const permalink = row.competitor_permalink;
  const title = row.competitor_title;
  const urlForQueries = rawUrl || permalink || null;

  const queries = buildLinkDiscoveryQueries({
    parsed: null,
    rawUrl: urlForQueries,
    titleHint: title || titleFromMercadoLivrePermalink(urlForQueries),
    listingId,
    product,
  });

  console.info("[S7_COMPETITION_LINK_DISCOVERY_COMPLETION_START]", {
    competitor_id: competitorId ?? null,
    item_id: listingId ?? null,
    permalink: permalink ? String(permalink).slice(0, 200) : null,
    title: title ? String(title).slice(0, 120) : null,
    query_used: queries[0]?.query ?? null,
  });

  let matched = null;
  let matchedBy = null;
  let queryUsed = null;

  for (const { query, type } of queries) {
    const q = String(query || "").trim();
    if (!q) continue;

    const context = buildDiscoveryContext({
      accessToken,
      userId,
      product,
      listingRow,
      ownSellerId,
      ownListingId,
      query: q,
    });

    const { results } = await engine.discover(context);
    const hit = pickDiscoveryMatchForPartial(results, {
      listingId,
      permalink,
      title,
      price: row.last_seen_price,
    });

    if (hit?.candidate) {
      matched = hit.candidate;
      matchedBy = hit.matched_by;
      queryUsed = q;
      break;
    }

    if (!queryUsed) queryUsed = q;
  }

  if (!matched) {
    console.info("[S7_COMPETITION_LINK_DISCOVERY_COMPLETION_MATCH]", {
      competitor_id: competitorId ?? null,
      matched: false,
      matched_by: null,
      matched_item_id: null,
      copied_fields: [],
      query_used: queryUsed,
    });
    return {
      matched: false,
      normalized: row,
      enrichExtras: extras,
      enrich_status_before: statusBefore.enrich_status,
      enrich_status_after: statusBefore.enrich_status,
      missing_fields_before: statusBefore.enrich_missing_fields,
      missing_fields_after: statusBefore.enrich_missing_fields,
    };
  }

  const anchoredItemId = listingId != null ? String(listingId).trim() : "";
  const candidateListingId =
    matched?.competitor_listing_id != null ? String(matched.competitor_listing_id).trim() : "";
  const candidateMatchesAnchor =
    anchoredItemId === "" || isSameListingId(candidateListingId, anchoredItemId);
  if (!candidateMatchesAnchor) {
    console.info("[S7_COMPETITION_LINK_ANCHOR_GUARD]", {
      anchored_item_id: anchoredItemId || null,
      candidate_listing_id: candidateListingId || null,
      swap_blocked: true,
      reason: "discovery_completion_candidate_listing_mismatch",
    });
    return {
      matched: false,
      normalized: row,
      enrichExtras: extras,
      enrich_status_before: statusBefore.enrich_status,
      enrich_status_after: statusBefore.enrich_status,
      missing_fields_before: statusBefore.enrich_missing_fields,
      missing_fields_after: statusBefore.enrich_missing_fields,
    };
  }
  if (anchoredItemId) {
    console.info("[S7_COMPETITION_LINK_ANCHOR_GUARD]", {
      anchored_item_id: anchoredItemId,
      candidate_listing_id: candidateListingId || anchoredItemId,
      swap_blocked: false,
      reason: "discovery_completion_candidate_listing_matches_anchor",
    });
  }

  const merged = mergeDiscoveryMatchIntoPartial(row, extras, matched);
  const statusAfter = computeEnrichStatus(merged.normalized, merged.enrichExtras);

  console.info("[S7_COMPETITION_LINK_DISCOVERY_COMPLETION_MATCH]", {
    competitor_id: competitorId ?? null,
    matched: true,
    matched_by: matchedBy,
    matched_item_id: matched.competitor_listing_id ?? null,
    copied_fields: merged.copied_fields,
    query_used: queryUsed,
  });

  console.info("[S7_COMPETITION_LINK_PARTIAL_UPDATED]", {
    competitor_id: competitorId ?? null,
    enrich_status_before: statusBefore.enrich_status,
    enrich_status_after: statusAfter.enrich_status,
    missing_fields_before: statusBefore.enrich_missing_fields,
    missing_fields_after: statusAfter.enrich_missing_fields,
  });

  return {
    matched: true,
    matched_by: matchedBy,
    query_used: queryUsed,
    copied_fields: merged.copied_fields,
    normalized: merged.normalized,
    enrichExtras: merged.enrichExtras,
    enrich_status_before: statusBefore.enrich_status,
    enrich_status_after: statusAfter.enrich_status,
    missing_fields_before: statusBefore.enrich_missing_fields,
    missing_fields_after: statusAfter.enrich_missing_fields,
  };
}
