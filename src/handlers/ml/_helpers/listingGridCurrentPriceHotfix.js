// ======================================================
// GET /api/ml/listings — hotfix controlado de preço efetivo das LISTAS.
// Escopo: /anuncios e /precificacoes. Não altera Modal PI nem engine.
// ======================================================

import Decimal from "decimal.js";

import { getValidMLToken } from "./mlToken.js";
import {
  fetchSellerPromotionItemsForListing,
  fetchSellerPromotionsByItemDetailed,
} from "./mercadoLibreItemsApi.js";
import {
  enrichOfficialSellerPromotionRowsFromApi,
  normalizeOfficialSellerPromotionsFromApi,
} from "../../../domain/pricing/mercadoLivreOfficialSellerPromotions.js";

const AUDIT_PREFIX = "[S7_LISTS_CURRENT_PRICE_R68_AUDIT]";
const DEFAULT_TARGET_IDS = "MLB6415546858";
const STALE_SNAPSHOT_MS = 24 * 60 * 60 * 1000;
const ROUND = Decimal.ROUND_HALF_UP;

/** @param {unknown} v @returns {Decimal | null} */
function toDec(v) {
  if (v == null || String(v).trim() === "") return null;
  try {
    const d = new Decimal(String(v).trim().replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null} d */
function decStr2(d) {
  return d != null && d.isFinite() ? d.toDecimalPlaces(2, ROUND).toFixed(2) : null;
}

/** @param {unknown} raw */
function parseTargetIds(raw) {
  return new Set(
    String(raw ?? DEFAULT_TARGET_IDS)
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

/** @param {Record<string, unknown> | null | undefined} health */
function readSalePriceSnapshot(health) {
  const raw = health?.raw_json;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payloads = /** @type {Record<string, unknown>} */ (raw).raw_payloads;
  if (!payloads || typeof payloads !== "object" || Array.isArray(payloads)) return null;
  const snap = /** @type {Record<string, unknown>} */ (payloads).sale_price_snapshot;
  return snap && typeof snap === "object" && !Array.isArray(snap)
    ? /** @type {Record<string, unknown>} */ (snap)
    : null;
}

/** @param {Record<string, unknown>} promo */
function isActiveParticipatingPromotion(promo) {
  if (promo.promotion_active !== true) return false;
  if (promo.ml_effective_state != null && String(promo.ml_effective_state).trim() !== "active") return false;
  const raw = promo.raw_status != null ? String(promo.raw_status).trim().toLowerCase() : "";
  return raw === "" || raw === "started" || raw === "active";
}

/** @param {Record<string, unknown>[]} promotions */
function selectLowestActivePromotion(promotions) {
  let picked = null;
  let pickedPrice = null;
  for (const promo of promotions) {
    if (!isActiveParticipatingPromotion(promo)) continue;
    const finalDec = toDec(promo.final_price_brl ?? promo.reference_price_brl);
    if (finalDec == null || !finalDec.gt(0)) continue;
    if (pickedPrice == null || finalDec.lt(pickedPrice)) {
      picked = promo;
      pickedPrice = finalDec;
    }
  }
  return picked;
}

/**
 * Recalcula apenas o contrato financeiro unitário da linha da lista com base no preço efetivo corrigido.
 * Usa somente campos já presentes na grid/health; não chama engine PI.
 *
 * @param {Record<string, unknown>} gridRow
 * @param {string} effectivePriceBrl
 */
function recalculateListFinancialContext(gridRow, effectivePriceBrl) {
  const saleDec = toDec(effectivePriceBrl);
  if (saleDec == null || !saleDec.gt(0)) return;

  const pricingContext =
    gridRow.pricing_context != null && typeof gridRow.pricing_context === "object"
      ? /** @type {Record<string, unknown>} */ (gridRow.pricing_context)
      : {};
  const internalCosts =
    pricingContext.internal_costs != null && typeof pricingContext.internal_costs === "object"
      ? /** @type {Record<string, unknown>} */ (pricingContext.internal_costs)
      : {};

  const commissionPct = toDec(gridRow.commission_percent);
  const commissionDec =
    commissionPct != null
      ? saleDec.times(commissionPct).div(100).toDecimalPlaces(2, ROUND)
      : toDec(gridRow.commission_amount_brl);
  const freightDec = toDec(gridRow.shipping_cost_brl ?? gridRow.shipping_cost_amount_brl);
  const costDec = toDec(internalCosts.product_cost_brl);
  const operationalDec = toDec(internalCosts.operational_packaging_total_brl) ?? new Decimal(0);
  const taxPct = toDec(internalCosts.tax_percent_applied);
  const taxDec =
    taxPct != null ? saleDec.times(taxPct).div(100).toDecimalPlaces(2, ROUND) : toDec(internalCosts.tax_amount_brl);
  const payoutDec =
    commissionDec != null && freightDec != null
      ? saleDec.minus(commissionDec).minus(freightDec).toDecimalPlaces(2, ROUND)
      : null;
  const profitDec =
    payoutDec != null && costDec != null
      ? payoutDec.minus(costDec).minus(taxDec ?? 0).minus(operationalDec).toDecimalPlaces(2, ROUND)
      : null;
  const marginDec =
    profitDec != null && saleDec.gt(0) ? profitDec.div(saleDec).times(100).toDecimalPlaces(2, ROUND) : null;

  gridRow.commission_amount_brl = decStr2(commissionDec) ?? gridRow.commission_amount_brl ?? null;
  gridRow.shipping_cost_brl = decStr2(freightDec) ?? gridRow.shipping_cost_brl ?? null;
  gridRow.shipping_cost_amount_brl = decStr2(freightDec) ?? gridRow.shipping_cost_amount_brl ?? null;
  gridRow.marketplace_payout_amount = decStr2(payoutDec) ?? gridRow.marketplace_payout_amount ?? null;
  gridRow.net_proceeds = {
    ...(gridRow.net_proceeds != null && typeof gridRow.net_proceeds === "object"
      ? /** @type {Record<string, unknown>} */ (gridRow.net_proceeds)
      : {}),
    sale_fee_amount: decStr2(commissionDec) ?? null,
    shipping_cost_amount: decStr2(freightDec) ?? null,
    marketplace_payout_amount: decStr2(payoutDec) ?? null,
    net_proceeds_amount: decStr2(payoutDec) ?? null,
  };

  gridRow.pricing_context = {
    ...pricingContext,
    internal_costs: {
      ...internalCosts,
      tax_amount_brl: decStr2(taxDec) ?? internalCosts.tax_amount_brl ?? null,
    },
    result:
      profitDec != null
        ? {
            profit_brl: decStr2(profitDec),
            margin_pct: decStr2(marginDec),
          }
        : null,
  };
}

/**
 * Overlay pontual para impedir que health/sale_price_snapshot stale alimente o preço atual da lista.
 * Não faz chamada live em massa: só IDs explicitamente permitidos (default: case de homologação).
 *
 * @param {{
 *   userId: string;
 *   gridRows: Record<string, unknown>[];
 *   listings: Record<string, unknown>[];
 *   healthByKey: Map<string, Record<string, unknown>>;
 *   getHealth: (marketplace: unknown, externalListingId: unknown) => Record<string, unknown> | null | undefined;
 * }} ctx
 */
export async function applyListsCurrentPriceStalenessHotfix(ctx) {
  const targetIds = parseTargetIds(process.env.S7_LISTS_CURRENT_PRICE_LIVE_TARGET_IDS);
  if (targetIds.size === 0 || !Array.isArray(ctx.gridRows) || ctx.gridRows.length === 0) return;

  const listingByExternal = new Map();
  for (const listing of ctx.listings ?? []) {
    if (listing?.external_listing_id != null) {
      listingByExternal.set(String(listing.external_listing_id).trim(), listing);
    }
  }

  for (const gridRow of ctx.gridRows) {
    const listingId = gridRow?.external_listing_id != null ? String(gridRow.external_listing_id).trim() : "";
    if (!targetIds.has(listingId)) continue;

    const listing = listingByExternal.get(listingId) ?? null;
    const health = ctx.getHealth(gridRow.marketplace ?? listing?.marketplace, listingId) ?? null;
    const snap = readSalePriceSnapshot(health);
    const snapAmount = toDec(snap?.amount);
    const snapReferenceDate =
      snap?.reference_date != null ? String(snap.reference_date) : health?.updated_at != null ? String(health.updated_at) : null;
    const snapTs = snapReferenceDate ? Date.parse(snapReferenceDate) : NaN;
    const isPriceStale = snapAmount != null && snapAmount.eq(68) && (!Number.isFinite(snapTs) || Date.now() - snapTs > STALE_SNAPSHOT_MS);

    let picked = null;
    let liveRowsCount = 0;
    let liveError = null;

    try {
      const accountId =
        gridRow.marketplace_account_id != null
          ? String(gridRow.marketplace_account_id)
          : listing?.marketplace_account_id != null
            ? String(listing.marketplace_account_id)
            : null;
      const token = await getValidMLToken(ctx.userId, { marketplaceAccountId: accountId });
      const fetchResult = await fetchSellerPromotionsByItemDetailed(token, listingId);
      liveRowsCount = fetchResult.rows.length;
      if (!fetchResult.ok) {
        liveError = fetchResult.error ?? `http_${fetchResult.httpStatus}`;
      } else {
        const enriched = await enrichOfficialSellerPromotionRowsFromApi(
          token,
          listingId,
          fetchResult.rows,
          fetchSellerPromotionItemsForListing,
        );
        const normalized =
          normalizeOfficialSellerPromotionsFromApi(enriched, {
            source: "lists_current_price_hotfix_live",
            listingId,
          }).promotions ?? [];
        picked = selectLowestActivePromotion(normalized);
      }
    } catch (err) {
      liveError = err instanceof Error ? err.message : String(err);
    }

    const finalDec = toDec(picked?.final_price_brl ?? picked?.reference_price_brl);
    const originalDec =
      toDec(picked?.original_price_brl) ??
      toDec(picked?.base_price_brl) ??
      toDec(gridRow.listing_sale_price_brl ?? gridRow.listing_price_brl) ??
      toDec(listing?.base_price ?? listing?.price);

    const previousDisplayed = gridRow.effective_sale_price_brl ?? gridRow.promotional_price_brl ?? gridRow.price_brl ?? null;
    const shouldOverlay = finalDec != null && finalDec.gt(0) && (isPriceStale || previousDisplayed != null);
    const finalStr = decStr2(finalDec);
    const originalStr = decStr2(originalDec);

    if (shouldOverlay && finalStr) {
      gridRow.promotion_active = true;
      gridRow.promotional_price_brl = finalStr;
      gridRow.promotion_sale_price_brl = finalStr;
      gridRow.effective_sale_price_brl = finalStr;
      gridRow.price_brl = finalStr;
      gridRow.listing_price_brl = originalStr ?? gridRow.listing_price_brl ?? null;
      gridRow.listing_sale_price_brl = originalStr ?? gridRow.listing_sale_price_brl ?? null;
      gridRow.list_or_original_price_brl = originalStr ?? gridRow.list_or_original_price_brl ?? null;
      gridRow.listing_grid_price_evidence = "lists_current_price_hotfix_live_seller_promotions";
      gridRow.lists_current_price_hotfix = {
        active_promotion_id: picked?.promotion_id ?? null,
        active_promotion_name: picked?.promotion_name ?? null,
        price_source: "live_seller_promotions_items_targeted",
        replaced_price_brl: previousDisplayed,
        rejected_stale_snapshot_price_brl: snapAmount != null ? decStr2(snapAmount) : null,
        price_source_timestamp: new Date().toISOString(),
      };
      recalculateListFinancialContext(gridRow, finalStr);
    }

    console.info(AUDIT_PREFIX, {
      listing_id: listingId,
      marketplace_account_id: gridRow.marketplace_account_id ?? listing?.marketplace_account_id ?? null,
      seller_id:
        listing?.raw_json != null && typeof listing.raw_json === "object"
          ? /** @type {Record<string, unknown>} */ (listing.raw_json).seller_id ?? null
          : null,
      displayed_price: shouldOverlay ? finalStr : previousDisplayed,
      original_price: originalStr ?? gridRow.listing_sale_price_brl ?? gridRow.listing_price_brl ?? null,
      effective_price: shouldOverlay ? finalStr : gridRow.effective_sale_price_brl ?? null,
      sale_price: gridRow.price_brl ?? null,
      promotion_final_price: finalStr,
      active_promotion_id: picked?.promotion_id ?? null,
      active_promotion_name: picked?.promotion_name ?? null,
      price_source: shouldOverlay ? "live_seller_promotions_items_targeted" : "grid_or_health_existing",
      price_source_timestamp: snapReferenceDate,
      is_price_stale: isPriceStale,
      fallback_used: shouldOverlay,
      stale_price_rejected: snapAmount != null ? decStr2(snapAmount) : null,
      previous_displayed_price: previousDisplayed,
      live_rows_count: liveRowsCount,
      live_error: liveError,
      selection_reason: shouldOverlay
        ? "health sale_price_snapshot R$68 stale replaced by active seller promotion"
        : "no active live promotion overlay applied",
    });
  }
}
