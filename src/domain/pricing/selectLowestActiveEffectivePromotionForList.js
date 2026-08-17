// ======================================================
// Lista Precificações — menor preço efetivo entre promoções ATIVAS/PARTICIPANDO.
// SSOT: mesmo contrato do Modal PI (normalizeOfficialSellerPromotionsFromApi).
// Regra: só status started/active com promotion_active=true; ignora candidate/Participar.
// ======================================================

import Decimal from "decimal.js";

import { extractPersistedPromotionRawRows } from "./extractPersistedPromotionRawRows.js";
import {
  evaluateOfficialPromotionUiEligibility,
  normalizeOfficialSellerPromotionsFromApi,
  resolveOfficialSellerPromotionFinancials,
  resolvePromotionUiFinancials,
} from "./mercadoLivreOfficialSellerPromotions.js";

const ROUND = Decimal.ROUND_HALF_UP;
const HOMOLOG_LISTING_IDS = new Set(["MLB6086602390", "MLB6087428866", "MLB6784329822"]);

/** @param {unknown} v @returns {Decimal | null} */
function toDec(v) {
  if (v == null || v === "") return null;
  try {
    const d = new Decimal(String(v).trim().replace(",", "."));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** @param {Decimal | null} d @returns {string | null} */
function decStr2(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/**
 * @param {Record<string, unknown>} gridRow
 * @returns {"classic" | "premium"}
 */
export function resolveListingTypeChoiceFromGridRow(gridRow) {
  const label =
    gridRow.listing_type_label != null ? String(gridRow.listing_type_label).trim().toLowerCase() : "";
  const typeId =
    gridRow.listing_type_id != null ? String(gridRow.listing_type_id).trim().toLowerCase() : "";
  if (label.includes("premium") || typeId === "gold_pro" || typeId === "gold_premium" || typeId === "pro") {
    return "premium";
  }
  return "classic";
}

/**
 * @param {Record<string, unknown>} promo
 */
function isActiveParticipatingPromotion(promo) {
  if (promo.promotion_active !== true) return false;
  if (promo.ml_effective_state != null && String(promo.ml_effective_state).trim() !== "active") {
    return false;
  }
  const raw = promo.raw_status != null ? String(promo.raw_status).trim().toLowerCase() : "";
  if (raw === "candidate" || raw === "pending") return false;
  if (raw !== "" && raw !== "started" && raw !== "active") return false;
  return true;
}

/**
 * @param {Record<string, unknown>} promo
 */
function isProgrammedPromotion(promo) {
  const raw = promo.raw_status != null ? String(promo.raw_status).trim().toLowerCase() : "";
  return raw === "pending" || promo.ml_effective_state === "scheduled";
}

/**
 * @param {Record<string, unknown>} promo
 */
function isEligibleNotParticipatingPromotion(promo) {
  if (promo.promotion_active === true) return false;
  const state = promo.ml_effective_state != null ? String(promo.ml_effective_state).trim() : "";
  if (state === "participate" || state === "candidate") return true;
  const raw = promo.raw_status != null ? String(promo.raw_status).trim().toLowerCase() : "";
  return raw === "candidate";
}

/**
 * @param {{
 *   listingExternalId: string | null;
 *   sku: string | null;
 *   promotionsSourceUsed: string;
 *   rawRows: Record<string, unknown>[];
 *   normalized: Record<string, unknown>[];
 *   activeCandidates: Record<string, unknown>[];
 *   picked: Record<string, unknown> | null;
 * }} ctx
 */
function logActivePromotionSelector(ctx) {
  const externalId = ctx.listingExternalId ?? "";
  if (!HOMOLOG_LISTING_IDS.has(externalId)) return;

  const activeParticipating = ctx.normalized.filter(isActiveParticipatingPromotion);
  const eligibleNotParticipating = ctx.normalized.filter(isEligibleNotParticipatingPromotion);
  const programmedPromotions = ctx.normalized.filter(isProgrammedPromotion);
  const candidatePromotions = ctx.normalized.filter(
    (promo) => isEligibleNotParticipatingPromotion(promo) && !isProgrammedPromotion(promo),
  );

  /** @type {Record<string, unknown>[]} */
  const ignored = [];
  for (const promo of ctx.normalized) {
    if (isActiveParticipatingPromotion(promo)) continue;
    let reason = "not_active_participating";
    if (promo.ml_effective_state === "participate" || promo.raw_status === "candidate") {
      reason = "eligible_participar_only";
    } else if (promo.promotion_active !== true) {
      reason = "promotion_not_active";
    } else if (promo.raw_status === "pending") {
      reason = "scheduled_not_started";
    }
    ignored.push({
      promotion_id: promo.promotion_id ?? null,
      promotion_name: promo.promotion_name ?? null,
      raw_status: promo.raw_status ?? null,
      ml_effective_state: promo.ml_effective_state ?? null,
      final_price_brl: promo.final_price_brl ?? promo.reference_price_brl ?? null,
      reason,
    });
  }

  const picked = ctx.picked;
  console.info("[S7_PRICING_ACTIVE_PROMOTION_SELECTOR]", {
    listing_id: externalId,
    sku: ctx.sku ?? null,
    promotions_source_used: ctx.promotionsSourceUsed,
    raw_promotions_count: ctx.rawRows.length,
    active_participating_promotions_count: activeParticipating.length,
    programmed_promotions_count: programmedPromotions.length,
    candidate_promotions_count: candidatePromotions.length,
    eligible_not_participating_promotions_count: eligibleNotParticipating.length,
    selected_promotion_id: picked?.promotion_id ?? null,
    selected_promotion_name: picked?.promotion_name ?? null,
    selected_promotion_status: picked?.raw_status ?? "active_participating",
    selected_promotion_price_brl: picked?.final_price_brl ?? null,
    selected_promotion_payout_brl: picked?.payout_brl ?? null,
    selected_promotion_commission_brl: picked?.commission_brl ?? null,
    selected_promotion_shipping_brl: picked?.shipping_brl ?? null,
    ignored_promotions_with_reason: ignored,
  });
}

/**
 * Seleciona promoção ativa/participando (started) com menor preço final efetivo.
 *
 * @param {{
 *   listing: Record<string, unknown>;
 *   health?: Record<string, unknown> | null;
 *   gridRow?: Record<string, unknown> | null;
 * }} input
 */
export function selectLowestActiveEffectivePromotionForList(input) {
  const listing = input.listing ?? {};
  const health = input.health ?? null;
  const gridRow = input.gridRow ?? null;
  const listingExternalId =
    listing.external_listing_id != null
      ? String(listing.external_listing_id).trim()
      : gridRow?.external_listing_id != null
        ? String(gridRow.external_listing_id).trim()
        : null;
  const sku =
    gridRow?.sku != null
      ? String(gridRow.sku)
      : listing.product_sku != null
        ? String(listing.product_sku)
        : listing.sku != null
          ? String(listing.sku)
          : null;

  const rawRows = extractPersistedPromotionRawRows(listing, health);
  const promotionsSourceUsed = rawRows.length > 0 ? "persisted_snapshot_unified" : "none";

  let normalized = [];
  try {
    normalized =
      normalizeOfficialSellerPromotionsFromApi(rawRows, {
        source: "persisted_list_current_state",
        listingId: listingExternalId,
      }).promotions ?? [];
  } catch {
    normalized = [];
  }

  /** @type {Record<string, unknown>[]} */
  const activeCandidates = [];
  for (const promo of normalized) {
    if (!isActiveParticipatingPromotion(promo)) continue;

    const eligibility = evaluateOfficialPromotionUiEligibility({
      raw_status: promo.raw_status ?? promo.status ?? null,
      ends_at: promo.ends_at ?? null,
    });
    if (!eligibility.ok) continue;

    const rawRow =
      promo.ml_api_raw_row != null && typeof promo.ml_api_raw_row === "object"
        ? /** @type {Record<string, unknown>} */ (promo.ml_api_raw_row)
        : null;

    const ui = rawRow
      ? resolvePromotionUiFinancials(rawRow, { listingId: listingExternalId })
      : null;

    const finalDec =
      toDec(ui?.final_price_brl) ??
      toDec(promo.final_price_brl) ??
      toDec(promo.reference_price_brl);
    if (finalDec == null || !finalDec.gt(0)) continue;

    let payoutBrl = null;
    let commissionBrl = null;
    let shippingBrl = null;
    if (rawRow) {
      try {
        const fin = resolveOfficialSellerPromotionFinancials(rawRow, decStr2(finalDec), null, {
          listingId: listingExternalId,
        });
        payoutBrl = fin?.payout_brl ?? fin?.net_receivable_brl ?? null;
        commissionBrl = fin?.sale_fee_amount_brl ?? fin?.marketplace_fee_brl ?? null;
        shippingBrl = fin?.shipping_cost_amount_brl ?? fin?.shipping_cost_brl ?? null;
      } catch {
        /* financeiro opcional no selector */
      }
    }

    activeCandidates.push({
      promotion_id: promo.promotion_id ?? null,
      promotion_name: promo.promotion_name ?? null,
      promotion_type: promo.promotion_type ?? null,
      final_price_brl: decStr2(finalDec),
      ml_api_raw_row: rawRow,
      original_price_brl:
        ui?.original_price_brl ??
        promo.reference_price_brl ??
        gridRow?.listing_sale_price_brl ??
        gridRow?.listing_price_brl ??
        null,
      discount_amount_brl: ui?.discount_amount_brl ?? null,
      discount_percent: ui?.discount_percent_display ?? null,
      raw_status: promo.raw_status ?? "started",
      price_applied: promo.price_applied === true,
      payout_brl: payoutBrl,
      commission_brl: commissionBrl,
      shipping_brl: shippingBrl,
    });
  }

  if (activeCandidates.length === 0) {
    logActivePromotionSelector({
      listingExternalId,
      sku,
      promotionsSourceUsed,
      rawRows,
      normalized,
      activeCandidates,
      picked: null,
    });

    return {
      active_promotions_count: 0,
      selected_promotion_id: null,
      selected_promotion_name: null,
      selected_promotion_status: null,
      selected_promotion_price_brl: null,
      selected_promotion_discount_brl: null,
      selected_promotion_discount_percent: null,
      selected_promotion_strategy: null,
      original_price_brl:
        gridRow?.listing_sale_price_brl ??
        gridRow?.listing_price_brl ??
        gridRow?.list_or_original_price_brl ??
        null,
      base_sale_price_brl:
        gridRow?.listing_sale_price_brl ??
        gridRow?.listing_price_brl ??
        null,
      current_effective_price_brl:
        gridRow?.effective_sale_price_brl ??
        gridRow?.listing_sale_price_brl ??
        gridRow?.listing_price_brl ??
        null,
      current_effective_price_source: "grid.effective_sale_price_brl",
      promotionSelection: null,
    };
  }

  activeCandidates.sort((a, b) => {
    const da = toDec(a.final_price_brl) ?? new Decimal(Number.MAX_SAFE_INTEGER);
    const db = toDec(b.final_price_brl) ?? new Decimal(Number.MAX_SAFE_INTEGER);
    return da.comparedTo(db);
  });

  const picked = activeCandidates[0];
  logActivePromotionSelector({
    listingExternalId,
    sku,
    promotionsSourceUsed,
    rawRows,
    normalized,
    activeCandidates,
    picked,
  });

  const originalPrice =
    picked.original_price_brl ??
    gridRow?.listing_sale_price_brl ??
    gridRow?.listing_price_brl ??
    null;

  return {
    active_promotions_count: activeCandidates.length,
    selected_promotion_id: picked.promotion_id ?? null,
    selected_promotion_name: picked.promotion_name ?? null,
    selected_promotion_status: "active_participating",
    selected_promotion_price_brl: picked.final_price_brl ?? null,
    selected_promotion_discount_brl: picked.discount_amount_brl ?? null,
    selected_promotion_discount_percent: picked.discount_percent ?? null,
    selected_promotion_strategy: "lowest_active_effective_price",
    original_price_brl: originalPrice,
    base_sale_price_brl: originalPrice,
    current_effective_price_brl: picked.final_price_brl ?? null,
    current_effective_price_source: "lowest_active_effective_price",
    promotionSelection: {
      promotion_id: picked.promotion_id ?? null,
      promotion_name: picked.promotion_name ?? null,
      promotion_type: picked.promotion_type ?? null,
      selected_final_price: picked.final_price_brl ?? null,
      selected_discount_amount: picked.discount_amount_brl ?? null,
      selected_rule: "lowest_active_effective_price",
      ml_api_raw_row: picked.ml_api_raw_row ?? null,
      source_trace: {
        strategy: "lowest_active_effective_price",
        raw_status: picked.raw_status ?? "started",
        price_applied: picked.price_applied === true,
      },
    },
  };
}
