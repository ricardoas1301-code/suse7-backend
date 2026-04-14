// ======================================================
// Mercado Livre — detecção centralizada de promoção (sync + grid).
// Não depender de uma única fonte: item coalescido, health persistido, resolution, sale_price snapshot.
// ======================================================

import {
  mercadoLivreListingPayloadForMoneyFields,
  mercadoLivreToFiniteGrid,
} from "./mercadoLivreListingMoneyShared.js";
import {
  coalesceMercadoLibreItemForMoneyExtract,
  extractPromotionPrice,
} from "./mlItemMoneyExtract.js";

export const MERCADO_LIVRE_PROMO_PRICE_TOL = 0.004;

/**
 * Snapshot GET /items/:id/sale_price persistido em health (mesma evidência que repasse/taxa).
 * @param {Record<string, unknown> | null | undefined} health
 * @returns {Record<string, unknown> | null}
 */
export function extractMercadoLivreSalePriceSnapshotFromHealth(health) {
  if (!health || typeof health !== "object") return null;
  const rj = health.raw_json;
  if (!rj || typeof rj !== "object" || Array.isArray(rj)) return null;
  const rp = /** @type {Record<string, unknown>} */ (rj).raw_payloads;
  if (!rp || typeof rp !== "object" || Array.isArray(rp)) return null;
  const sp = /** @type {Record<string, unknown>} */ (rp).sale_price_snapshot;
  return sp && typeof sp === "object" && !Array.isArray(sp) ? sp : null;
}

/**
 * @param {Record<string, unknown>} merged
 * @param {(v: unknown) => number | null} toN
 */
function catalogAndPromoFromPricesArray(merged, toN) {
  const prices = merged.prices;
  if (!Array.isArray(prices)) return null;
  const TOL = MERCADO_LIVRE_PROMO_PRICE_TOL;
  for (const p of prices) {
    if (!p || typeof p !== "object") continue;
    const po = /** @type {Record<string, unknown>} */ (p);
    const meta = po.metadata && typeof po.metadata === "object" ? po.metadata : null;
    const amt = toN(po.amount ?? po.price);
    const reg = toN(
      po.regular_amount ??
        (meta ? /** @type {Record<string, unknown>} */ (meta).promotion_price : undefined)
    );
    if (reg != null && amt != null && reg > 0 && amt > 0 && reg > amt + TOL) {
      return { catalog: reg, promo: amt };
    }
  }
  return null;
}

/**
 * Núcleo compartilhado: `merged` = item já coalescido para extração (API ou listing+raw+health mesclados).
 *
 * @param {Record<string, unknown>} merged
 * @param {Record<string, unknown> | null | undefined} healthRec
 * @param {Record<string, unknown> | null | undefined} resolution
 * @param {Record<string, unknown> | null | undefined} saleSnapshot
 */
export function resolveMercadoLivrePromotionCore(
  merged,
  healthRec,
  resolution,
  saleSnapshot
) {
  const toN = mercadoLivreToFiniteGrid;
  const TOL = MERCADO_LIVRE_PROMO_PRICE_TOL;

  const strike = toN(merged.price);
  const orig = toN(merged.original_price);
  const base = toN(merged.base_price);

  const pr = resolution && typeof resolution === "object" ? resolution : null;
  const resolutionSays = Boolean(pr && (pr.promotion_active === true || pr.has_valid_promotion === true));

  const prListing = pr ? toN(pr.listing_price_brl) : null;
  const prPromo = pr ? toN(pr.promotion_price_brl ?? pr.promotion_price_observed_brl) : null;
  const prEffective = pr ? toN(pr.sale_price_effective_brl) : null;

  const dbList = healthRec ? toN(healthRec.list_or_original_price_brl) : null;
  const dbPromo = healthRec ? toN(healthRec.promotional_price_brl ?? healthRec.promotion_price) : null;

  const itemOriginalGtPrice =
    orig != null && strike != null && orig > 0 && strike > 0 && orig > strike + TOL;

  const healthPromoValid =
    dbList != null && dbPromo != null && dbList > 0 && dbPromo > 0 && dbPromo < dbList - TOL;

  const effectiveVsListing =
    prEffective != null &&
    prListing != null &&
    prEffective > 0 &&
    prListing > 0 &&
    prEffective < prListing - TOL;

  let saleSnapPromo = false;
  /** @type {number | null} */
  let saleSnapAmount = null;
  /** @type {number | null} */
  let saleSnapRegular = null;
  if (saleSnapshot && typeof saleSnapshot === "object") {
    const amt = toN(saleSnapshot.amount);
    const reg = toN(saleSnapshot.regular_amount);
    saleSnapAmount = amt;
    saleSnapRegular = reg;
    saleSnapPromo =
      reg != null && amt != null && reg > 0 && amt > 0 && reg > amt + TOL;
  }

  const fromArr = catalogAndPromoFromPricesArray(merged, toN);
  const arrShowsPromo = fromArr != null;

  const extractPromo = extractPromotionPrice(merged);
  const extractPromoValid =
    extractPromo != null &&
    extractPromo > 0 &&
    (itemOriginalGtPrice ||
      arrShowsPromo ||
      (orig != null && orig > extractPromo + TOL) ||
      (base != null && base > extractPromo + TOL) ||
      (strike != null && strike > extractPromo + TOL));

  const promotion_active = Boolean(
    resolutionSays ||
      itemOriginalGtPrice ||
      healthPromoValid ||
      effectiveVsListing ||
      saleSnapPromo ||
      arrShowsPromo ||
      extractPromoValid
  );

  /** @type {string | null} */
  let evidence_source = null;
  if (promotion_active) {
    if (resolutionSays) evidence_source = "resolution";
    else if (itemOriginalGtPrice) evidence_source = "item_original_gt_price";
    else if (healthPromoValid) evidence_source = "health_promotion_price";
    else if (effectiveVsListing) evidence_source = "sale_price_effective_lt_listing";
    else if (saleSnapPromo) evidence_source = "sale_price_snapshot";
    else if (arrShowsPromo) evidence_source = "item_prices_array";
    else if (extractPromoValid) evidence_source = "extract_promotion_price";
  }

  /** @type {number | null} */
  let promotion_price_num =
    prPromo ??
    dbPromo ??
    (itemOriginalGtPrice ? strike : null) ??
    (arrShowsPromo ? fromArr.promo : null) ??
    (saleSnapPromo ? saleSnapAmount : null) ??
    (extractPromoValid ? extractPromo : null) ??
    (effectiveVsListing ? prEffective : null);

  /**
   * Catálogo / “valor de venda” (base) com promo ativa: nunca priorizar só `original_price` —
   * no ML ele costuma ficar defasado se o vendedor altera o preço de lista durante a promoção.
   * Ordem: prices[] (regular_amount) → sale_price snapshot → base_price → original_price → price.
   */
  const mergedCatalogCandidate =
    (arrShowsPromo ? fromArr.catalog : null) ??
    (saleSnapPromo ? saleSnapRegular : null) ??
    (base != null && base > 0 ? base : null) ??
    (orig != null && orig > 0 ? orig : null) ??
    (strike != null && strike > 0 ? strike : null);

  /** @type {number | null} */
  let listing_catalog_num = mergedCatalogCandidate ?? prListing ?? dbList;

  if (promotion_active && promotion_price_num == null) {
    promotion_price_num = extractPromo ?? saleSnapAmount ?? prEffective ?? strike;
  }

  if (
    promotion_active &&
    promotion_price_num != null &&
    listing_catalog_num != null &&
    promotion_price_num >= listing_catalog_num - TOL &&
    !resolutionSays
  ) {
    if (base != null && base > promotion_price_num + TOL) listing_catalog_num = base;
    else if (orig != null && orig > promotion_price_num + TOL) listing_catalog_num = orig;
    else if (saleSnapRegular != null && saleSnapRegular > promotion_price_num + TOL) {
      listing_catalog_num = saleSnapRegular;
    } else if (arrShowsPromo && fromArr.catalog > promotion_price_num + TOL) {
      listing_catalog_num = fromArr.catalog;
    }
  }

  /**
   * Padrão oficial com promoção: base e promo da **mesma** evidência ML.
   * Prioridade: `prices[]` (regular_amount + amount) → snapshot sale_price → restante (item/health).
   */
  /** @type {string | null} */
  let price_pair_evidence = null;
  if (promotion_active) {
    if (arrShowsPromo && fromArr != null) {
      listing_catalog_num = fromArr.catalog;
      promotion_price_num = fromArr.promo;
      evidence_source = "item_prices_array";
      price_pair_evidence = "item_prices_array";
    } else if (
      saleSnapPromo &&
      saleSnapRegular != null &&
      saleSnapAmount != null &&
      !arrShowsPromo
    ) {
      listing_catalog_num = saleSnapRegular;
      promotion_price_num = saleSnapAmount;
      evidence_source = "sale_price_snapshot";
      price_pair_evidence = "sale_price_snapshot";
    } else {
      price_pair_evidence = "item_coalesced_or_health_fallback";
    }
  }

  return {
    promotion_active,
    promotion_price_num,
    listing_catalog_num,
    coalesced: { strike, orig, base },
    flags: {
      resolutionSays,
      itemOriginalGtPrice,
      healthPromoValid,
      effectiveVsListing,
      saleSnapPromo,
      arrShowsPromo,
      extractPromoValid,
    },
    evidence_source: promotion_active ? evidence_source : "no_evidence",
    price_pair_evidence,
  };
}

/**
 * Para `mapMlToListingHealthRow`: item já passou por `coalesceMercadoLibreItemForMoneyExtract`.
 *
 * @param {Record<string, unknown>} mergedSrc
 * @param {Record<string, unknown> | null | undefined} saleSnapshot
 */
export function resolvePromotionEvidenceFromCoalescedItem(mergedSrc, saleSnapshot) {
  const core = resolveMercadoLivrePromotionCore(mergedSrc, null, null, saleSnapshot);
  const TOL = MERCADO_LIVRE_PROMO_PRICE_TOL;
  let active = core.promotion_active;
  let promo = core.promotion_price_num;
  let cat = core.listing_catalog_num;

  if (
    active &&
    promo != null &&
    cat != null &&
    promo >= cat - TOL &&
    !core.flags.resolutionSays
  ) {
    active = false;
    promo = null;
    cat =
      core.coalesced.orig ??
      core.coalesced.base ??
      core.coalesced.strike ??
      cat;
  }

  /** @type {string} */
  let source = "no_evidence";
  if (active) {
    source =
      core.evidence_source != null && core.evidence_source !== "no_evidence"
        ? core.evidence_source
        : "unknown";
  }

  return {
    promotion_active: active,
    promotion_price: active && promo != null && promo > 0 ? promo : null,
    listing_catalog_num: cat,
    source,
  };
}

/**
 * Grid / reprocessamento: combina listing (Supabase + raw_json), health e resolution persistidos.
 *
 * @param {{
 *   listing: Record<string, unknown>;
 *   health?: Record<string, unknown> | null;
 *   pricingResolution?: Record<string, unknown> | null;
 *   saleSnapshot?: Record<string, unknown> | null;
 * }} input
 */
export function resolvePromotionState(input) {
  const listing = input.listing && typeof input.listing === "object" ? input.listing : {};
  const health = input.health && typeof input.health === "object" ? input.health : null;
  const pricingResolution =
    input.pricingResolution && typeof input.pricingResolution === "object"
      ? input.pricingResolution
      : null;
  const saleSnapshot =
    input.saleSnapshot && typeof input.saleSnapshot === "object"
      ? input.saleSnapshot
      : extractMercadoLivreSalePriceSnapshotFromHealth(
          health && typeof health === "object" ? /** @type {Record<string, unknown>} */ (health) : null
        );

  const pre = mercadoLivreListingPayloadForMoneyFields(
    /** @type {Record<string, unknown>} */ (listing),
    health
  );
  const merged = coalesceMercadoLibreItemForMoneyExtract(pre);
  const core = resolveMercadoLivrePromotionCore(merged, health, pricingResolution, saleSnapshot);
  return {
    ...core,
    merged_for_log: {
      price: merged.price ?? null,
      original_price: merged.original_price ?? null,
      base_price: merged.base_price ?? null,
    },
  };
}

/**
 * ML_PROMO_DETECT_LOG=1 ou ML_PROMO_DETECT_EXT_ID=substring do listing id.
 *
 * @param {unknown} listingId
 * @param {ReturnType<resolvePromotionState>} st
 */
export function logMercadoLivrePromotionDetectMaybe(listingId, st) {
  const idStr = listingId != null ? String(listingId) : "";
  const on = process.env.ML_PROMO_DETECT_LOG === "1";
  const sub = process.env.ML_PROMO_DETECT_EXT_ID;
  if (!on && (!sub || !idStr.includes(String(sub)))) return;
  console.info("[ML_PROMO_DETECT]", {
    listing_id: idStr || null,
    coalesced_price: st.merged_for_log?.price ?? null,
    coalesced_original_price: st.merged_for_log?.original_price ?? null,
    promotion_price: st.promotion_price_num ?? null,
    promotion_active: st.promotion_active,
    evidence_source: st.evidence_source,
    flags: st.flags,
  });
}
