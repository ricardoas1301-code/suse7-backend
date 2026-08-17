// ======================================================
// Audit — promoções ML com variações / faixa de preço
// V1: detectar, logar e sinalizar; não mascarar preço único silencioso.
// ======================================================

import Decimal from "decimal.js";
import { decStr2, pickOriginalPriceDec, pickValidFinalBelowOriginal } from "./mercadoLivrePromotionPriceResolverRegistry.js";

const ROUND = Decimal.ROUND_HALF_UP;

/** @param {unknown} v @returns {Decimal | null} */
function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} row @param {string[]} keys */
function pickFirstRaw(row, keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== "") return row[k];
  }
  const meta =
    row.metadata != null && typeof row.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (row.metadata)
      : null;
  if (meta) {
    for (const k of keys) {
      if (meta[k] != null && String(meta[k]).trim() !== "") return meta[k];
    }
  }
  return null;
}

const FINAL_PRICE_CANDIDATE_KEYS = [
  "price",
  "amount",
  "deal_price",
  "promotion_price",
  "top_deal_price",
  "total_price_for_boosted_offer",
  "suggested_discounted_price",
  "min_discounted_price",
  "max_discounted_price",
  "buyer_price",
  "fixed_price",
];

const VARIATION_ID_KEYS = [
  "variation_id",
  "external_variation_id",
  "catalog_product_id",
  "user_product_id",
];

/**
 * @param {{
 *   variations_count?: number | null;
 *   has_listing_variations?: boolean | null;
 *   raw_json?: Record<string, unknown> | null;
 * }} [listingContext]
 */
export function listingHasMultipleVariations(listingContext = {}) {
  if (listingContext.has_listing_variations === true) {
    const count = listingContext.variations_count;
    if (typeof count === "number" && Number.isFinite(count) && count > 1) return true;
    const raw = listingContext.raw_json;
    if (raw != null && typeof raw === "object") {
      const vars = raw.variations;
      if (Array.isArray(vars) && vars.length > 1) return true;
    }
  }
  const count = listingContext.variations_count;
  if (typeof count === "number" && Number.isFinite(count) && count > 1) return true;
  const raw = listingContext.raw_json;
  if (raw != null && typeof raw === "object") {
    const vars = raw.variations;
    if (Array.isArray(vars) && vars.length > 1) return true;
  }
  return false;
}

/**
 * Monta listingContext para promoções a partir do listing bruto (DB/modal).
 * Não inventa variação sem evidência em raw_json.variations ou variations_count.
 *
 * @param {Record<string, unknown> | null | undefined} listing
 * @returns {{
 *   variations_count: number | null;
 *   has_listing_variations: boolean;
 *   raw_json: Record<string, unknown> | null;
 *   listingContext_source: string | null;
 *   raw_variations_length: number | null;
 *   raw_variations_count_field: number | null;
 * }}
 */
export function buildListingVariationContextForPromotions(listing) {
  const rawJson =
    listing != null &&
    listing.raw_json != null &&
    typeof listing.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (listing.raw_json)
      : null;

  const rawVariations = rawJson?.variations;
  const rawVariationsLength = Array.isArray(rawVariations) ? rawVariations.length : null;

  const countFieldRaw =
    listing?.variations_count ??
    rawJson?.variations_count ??
    null;
  const countFieldParsed =
    typeof countFieldRaw === "number" && Number.isFinite(countFieldRaw)
      ? countFieldRaw
      : countFieldRaw != null && String(countFieldRaw).trim() !== ""
        ? Number(String(countFieldRaw).trim())
        : null;
  const rawVariationsCountField =
    countFieldParsed != null && Number.isFinite(countFieldParsed) ? countFieldParsed : null;

  /** @type {number | null} */
  let resolvedVariationsCount = null;
  /** @type {string | null} */
  let listingContextSource = null;
  let hasListingVariations = false;

  if (rawVariationsLength != null && rawVariationsLength > 0) {
    resolvedVariationsCount = rawVariationsLength;
    hasListingVariations = true;
    listingContextSource = "raw_json.variations.length";
  } else if (rawVariationsCountField != null && rawVariationsCountField > 0) {
    resolvedVariationsCount = rawVariationsCountField;
    hasListingVariations = true;
    listingContextSource = "variations_count";
  }

  return {
    variations_count: resolvedVariationsCount,
    has_listing_variations: hasListingVariations,
    raw_json: rawJson,
    listingContext_source: listingContextSource,
    raw_variations_length: rawVariationsLength,
    raw_variations_count_field: rawVariationsCountField,
  };
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionVariationContextPropagation(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_VARIATION_CONTEXT_PROPAGATION]", payload);
}

/** @param {unknown} row */
function extractVariationIdsFromPromotionRow(row) {
  if (row == null || typeof row !== "object") return [];
  const r = /** @type {Record<string, unknown>} */ (row);
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (v == null || String(v).trim() === "") return;
    const s = String(v).trim();
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const key of VARIATION_ID_KEYS) {
    push(r[key]);
  }
  const nestedKeys = ["variations", "items", "results", "offers"];
  for (const nk of nestedKeys) {
    const nested = r[nk];
    if (!Array.isArray(nested)) continue;
    for (const entry of nested) {
      if (!entry || typeof entry !== "object") continue;
      const e = /** @type {Record<string, unknown>} */ (entry);
      for (const key of VARIATION_ID_KEYS) {
        push(e[key]);
      }
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Decimal | null} originalDec
 */
function collectFinalPriceCandidatesDec(row, originalDec) {
  /** @type {Decimal[]} */
  const out = [];
  const seen = new Set();
  const push = (dec) => {
    if (dec == null) return;
    const key = dec.toFixed(2);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(dec);
  };
  for (const key of FINAL_PRICE_CANDIDATE_KEYS) {
    push(pickValidFinalBelowOriginal(toDec(pickFirstRaw(row, [key])), originalDec));
  }
  const nestedKeys = ["variations", "items", "results", "offers"];
  for (const nk of nestedKeys) {
    const nested = row[nk];
    if (!Array.isArray(nested)) continue;
    for (const entry of nested) {
      if (!entry || typeof entry !== "object") continue;
      const e = /** @type {Record<string, unknown>} */ (entry);
      for (const key of FINAL_PRICE_CANDIDATE_KEYS) {
        push(pickValidFinalBelowOriginal(toDec(pickFirstRaw(e, [key])), originalDec));
      }
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Decimal | null} originalDec
 */
export function inferPromotionPriceDiscountRanges(row, originalDec) {
  const candidates = collectFinalPriceCandidatesDec(row, originalDec);
  if (candidates.length === 0) {
    return {
      price_range_min: null,
      price_range_max: null,
      discount_range_min: null,
      discount_range_max: null,
      candidate_count: 0,
    };
  }
  candidates.sort((a, b) => a.comparedTo(b));
  const minPrice = candidates[0];
  const maxPrice = candidates[candidates.length - 1];
  /** @type {Decimal | null} */
  let discountMin = null;
  /** @type {Decimal | null} */
  let discountMax = null;
  if (originalDec != null && originalDec.gt(0)) {
    discountMin = originalDec.minus(maxPrice);
    discountMax = originalDec.minus(minPrice);
    if (discountMin.lt(0)) discountMin = new Decimal(0);
    if (discountMax.lt(0)) discountMax = new Decimal(0);
  }
  return {
    price_range_min: decStr2(minPrice),
    price_range_max: decStr2(maxPrice),
    discount_range_min: discountMin != null ? decStr2(discountMin) : null,
    discount_range_max: discountMax != null ? decStr2(discountMax) : null,
    candidate_count: candidates.length,
  };
}

/**
 * @param {{
 *   row: Record<string, unknown>;
 *   selectedFinalPriceBrl?: string | null;
 *   selectedFinalPriceSource?: string | null;
 *   listingId?: string | null;
 *   parentListingId?: string | null;
 *   variationId?: string | null;
 *   listingContext?: {
 *     variations_count?: number | null;
 *     raw_json?: Record<string, unknown> | null;
 *   };
 *   enrichmentItemRows?: Record<string, unknown>[] | null;
 * }} ctx
 */
export function buildPromotionVariationRangeAuditPayload(ctx) {
  const row = ctx.row ?? {};
  const originalDec = pickOriginalPriceDec(row);
  const ranges = inferPromotionPriceDiscountRanges(row, originalDec);
  const variationIds = extractVariationIdsFromPromotionRow(row);
  if (Array.isArray(ctx.enrichmentItemRows)) {
    for (const itemRow of ctx.enrichmentItemRows) {
      if (!itemRow || typeof itemRow !== "object") continue;
      variationIds.push(...extractVariationIdsFromPromotionRow(itemRow));
    }
  }
  const uniqueVariationIds = [...new Set(variationIds.map((v) => String(v).trim()).filter(Boolean))];

  const listingHasVariations = listingHasMultipleVariations(ctx.listingContext ?? {});
  const hasPriceRange =
    ranges.price_range_min != null &&
    ranges.price_range_max != null &&
    ranges.price_range_min !== ranges.price_range_max;

  const selectedVariationId =
    ctx.variationId != null && String(ctx.variationId).trim() !== ""
      ? String(ctx.variationId).trim()
      : row.variation_id != null && String(row.variation_id).trim() !== ""
        ? String(row.variation_id).trim()
        : uniqueVariationIds.length === 1
          ? uniqueVariationIds[0]
          : null;

  const knowsExactVariation = selectedVariationId != null;
  const silentSinglePriceSelected =
    ctx.selectedFinalPriceBrl != null &&
    (listingHasVariations || hasPriceRange || uniqueVariationIds.length > 1) &&
    !knowsExactVariation;

  /** @type {string[]} */
  const sourceTrace = [];
  if (ctx.selectedFinalPriceSource) sourceTrace.push(`resolver:${ctx.selectedFinalPriceSource}`);
  if (row._suse7_price_enriched === true) sourceTrace.push("enrichment:promotion_items");
  if (listingHasVariations) sourceTrace.push("listing:multiple_variations");
  if (hasPriceRange) sourceTrace.push("promotion:price_range_detected");
  if (uniqueVariationIds.length > 1) sourceTrace.push("promotion:multiple_variation_ids");
  if (silentSinglePriceSelected) sourceTrace.push("warning:silent_single_price_without_variation");

  return {
    listing_id: ctx.listingId ?? row.item_id ?? row.listing_id ?? null,
    parent_listing_id:
      ctx.parentListingId ??
      (row.parent_item_id != null
        ? String(row.parent_item_id)
        : row.catalog_product_id != null
          ? String(row.catalog_product_id)
          : ctx.listingId ?? null),
    variation_id: row.variation_id ?? ctx.variationId ?? null,
    promotion_id: row.id ?? row.promotion_id ?? null,
    promotion_name: row.name ?? row.promotion_name ?? null,
    selected_final_price: ctx.selectedFinalPriceBrl ?? null,
    price_range_min: ranges.price_range_min,
    price_range_max: ranges.price_range_max,
    discount_range_min: ranges.discount_range_min,
    discount_range_max: ranges.discount_range_max,
    selected_variation_id: selectedVariationId,
    variation_ids_detected: uniqueVariationIds,
    listing_variations_count: ctx.listingContext?.variations_count ?? null,
    has_listing_variations: listingHasVariations,
    has_price_range: hasPriceRange,
    silent_single_price_selected: silentSinglePriceSelected,
    source_trace: sourceTrace,
    selected_source: ctx.selectedFinalPriceSource ?? null,
  };
}

/** @param {Record<string, unknown>} payload */
export function logS7PromotionVariationRangeAudit(payload = {}) {
  if (process.env.NODE_ENV === "production" && process.env.S7_PROMOTIONS_PI_AUDIT !== "1") return;
  console.info("[S7_PROMOTION_VARIATION_RANGE_AUDIT]", payload);
}

/**
 * V1 — metadados persistíveis no normalize/card quando ML expõe variação/faixa.
 * @param {ReturnType<typeof buildPromotionVariationRangeAuditPayload>} audit
 */
export function buildPromotionVariationLinkageV1(audit) {
  return {
    parent_listing_id: audit.parent_listing_id ?? null,
    variation_id: audit.selected_variation_id ?? audit.variation_id ?? null,
    variation_ids_detected: audit.variation_ids_detected ?? [],
    price_range_min_brl: audit.price_range_min ?? null,
    price_range_max_brl: audit.price_range_max ?? null,
    discount_range_min_brl: audit.discount_range_min ?? null,
    discount_range_max_brl: audit.discount_range_max ?? null,
    has_listing_variations: audit.has_listing_variations === true,
    has_price_range: audit.has_price_range === true,
    silent_single_price_selected: audit.silent_single_price_selected === true,
    source_trace: audit.source_trace ?? [],
  };
}
