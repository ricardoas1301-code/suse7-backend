// ============================================================
// S7 — Concorrência: trace de debug do resolve-link (DEV)
// Logs seguros — nunca token/header.
// ============================================================

import { assessLinkCandidateHealth } from "./competitionEnrichHelpers.js";

/** @returns {import("./competitionLinkDebug.js").LinkDebugTrace} */
export function createLinkDebugTrace() {
  return {
    attempted_steps: [],
    parsed_item_id: null,
    parsed_catalog_product_id: null,
    slug_query: null,
    item_fetch_status: null,
    seller_fetch_status: null,
    discovery_fallback_total: null,
    discovery_fallback_matched: false,
    discovery_match_reason: null,
    discovery_queries_tried: [],
    discovery_sample_candidates: [],
    missing_required_fields: [],
    final: null,
  };
}

export function pushLinkDebugStep(trace, step) {
  if (!trace) return;
  if (!Array.isArray(trace.attempted_steps)) trace.attempted_steps = [];
  trace.attempted_steps.push(step);
}

export function logS7LinkDebug01Parse(data) {
  console.info("[S7_LINK_DEBUG_01_PARSE]", data);
}

export function logS7LinkDebug02ItemFetch(data) {
  console.info("[S7_LINK_DEBUG_02_ITEM_FETCH]", data);
}

export function logS7LinkDebug03SellerFetch(data) {
  console.info("[S7_LINK_DEBUG_03_SELLER_FETCH]", data);
}

export function logS7LinkDebug04DiscoveryFallbackStart(data) {
  console.info("[S7_LINK_DEBUG_04_DISCOVERY_FALLBACK_START]", data);
}

export function logS7LinkDebug05DiscoveryFallbackResult(data) {
  console.info("[S7_LINK_DEBUG_05_DISCOVERY_FALLBACK_RESULT]", data);
}

export function logS7LinkDebug06Final(data) {
  console.info("[S7_LINK_DEBUG_06_FINAL]", data);
}

export function sampleCandidatesForDebug(candidates, limit = 10) {
  const list = Array.isArray(candidates) ? candidates : [];
  return list.slice(0, limit).map((c) => {
    const health = assessLinkCandidateHealth(c);
    return {
      external_item_id: c?.competitor_listing_id ?? null,
      title: c?.competitor_title != null ? String(c.competitor_title).slice(0, 80) : null,
      has_price: c?.competitor_price != null,
      has_thumbnail: Boolean(c?.competitor_thumbnail),
      has_store: Boolean(c?.competitor_store_name),
      healthy: health.healthy,
      missing: health.missing_required_fields,
    };
  });
}

/** Payload JSON para resposta DEV quando resolve-link falha. */
export function buildResolveLinkFailureDebug(trace, extra = {}) {
  const t = trace && typeof trace === "object" ? trace : {};
  return {
    parsed_item_id: t.parsed_item_id ?? extra.parsed_item_id ?? null,
    parsed_catalog_product_id: t.parsed_catalog_product_id ?? extra.parsed_catalog_product_id ?? null,
    slug_query: t.slug_query ?? null,
    attempted_steps: t.attempted_steps ?? [],
    missing_required_fields: t.missing_required_fields ?? [],
    item_fetch_status: t.item_fetch_status ?? null,
    seller_fetch_status: t.seller_fetch_status ?? null,
    discovery_fallback_total: t.discovery_fallback_total ?? null,
    discovery_fallback_matched: t.discovery_fallback_matched === true,
    discovery_match_reason: t.discovery_match_reason ?? null,
    discovery_queries_tried: t.discovery_queries_tried ?? [],
    discovery_sample_candidates: t.discovery_sample_candidates ?? [],
    final: t.final ?? null,
  };
}
