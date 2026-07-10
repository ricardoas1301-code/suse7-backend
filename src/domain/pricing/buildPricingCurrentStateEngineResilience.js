// ======================================================
// Resiliência — pricing_current_state na grid (engine PI).
// Nenhuma falha por linha derruba GET /api/ml/listings.
// ======================================================

import { buildPricingCurrentStateRowContract } from "./buildPricingCurrentStateRowContract.js";
import {
  resolveListingTypeChoiceFromGridRow,
  selectLowestActiveEffectivePromotionForList,
} from "./selectLowestActiveEffectivePromotionForList.js";

const HOMOLOG_LISTING_IDS = new Set(["MLB6086602390", "MLB6415546858"]);

/**
 * @param {unknown} err
 */
function summarizeError(err) {
  if (err instanceof Error) {
    return {
      error_name: err.name ?? "Error",
      error_message: String(err.message ?? "unknown").slice(0, 240),
      stack: err.stack != null ? String(err.stack).split("\n").slice(0, 4).join(" | ") : null,
    };
  }
  return {
    error_name: "UnknownError",
    error_message: String(err ?? "unknown").slice(0, 240),
    stack: null,
  };
}

/**
 * @param {Record<string, unknown>} gridRow
 * @param {Record<string, unknown> | null | undefined} listing
 * @param {Record<string, unknown> | null | undefined} health
 */
function countPromotionsSnapshot(listing, health) {
  try {
    const pick = selectLowestActiveEffectivePromotionForList({
      listing: listing ?? {},
      health,
      gridRow,
    });
    return {
      has_promotions_snapshot: (pick.active_promotions_count ?? 0) > 0 || pick.selected_promotion_id != null,
      promotions_count: pick.active_promotions_count ?? 0,
      selected_promotion_id: pick.selected_promotion_id ?? null,
    };
  } catch {
    return { has_promotions_snapshot: false, promotions_count: 0, selected_promotion_id: null };
  }
}

/**
 * @param {Record<string, unknown>} gridRow
 * @param {ReturnType<typeof selectLowestActiveEffectivePromotionForList>} promotionPick
 */
function gridRowWithPromotionPick(gridRow, promotionPick) {
  return {
    ...gridRow,
    effective_sale_price_brl:
      promotionPick.current_effective_price_brl ?? gridRow.effective_sale_price_brl ?? null,
    promotion_sale_price_brl:
      promotionPick.selected_promotion_price_brl ?? gridRow.promotion_sale_price_brl ?? null,
    promotion_active:
      promotionPick.selected_promotion_price_brl != null || gridRow.promotion_active === true,
    listing_sale_price_brl:
      promotionPick.original_price_brl ??
      promotionPick.base_sale_price_brl ??
      gridRow.listing_sale_price_brl ??
      gridRow.listing_price_brl ??
      null,
  };
}

/**
 * @param {Record<string, unknown>} base
 * @param {ReturnType<typeof selectLowestActiveEffectivePromotionForList>} promotionPick
 * @param {"classic" | "premium"} listingType
 * @param {string} engineSource
 */
function mergePromotionMetadataIntoContract(base, promotionPick, listingType, engineSource) {
  const effectivePrice =
    promotionPick.current_effective_price_brl ?? base.current_price_brl ?? base.current_price ?? null;
  const originalPrice =
    promotionPick.original_price_brl ??
    promotionPick.base_sale_price_brl ??
    base.regular_price_brl ??
    base.current_regular_price ??
    null;

  return {
    ...base,
    contract_kind: "pricing_current_state_projected_unit",
    money_scale: "BRL_DECIMAL",
    selected_listing_type: listingType,
    row_selected_scenario: listingType,
    original_price_brl: originalPrice,
    base_sale_price_brl: promotionPick.base_sale_price_brl ?? originalPrice,
    current_effective_price_brl: effectivePrice,
    current_effective_price_source: promotionPick.current_effective_price_source ?? engineSource,
    selected_promotion_id: promotionPick.selected_promotion_id ?? null,
    selected_promotion_name: promotionPick.selected_promotion_name ?? null,
    selected_promotion_price_brl: promotionPick.selected_promotion_price_brl ?? null,
    selected_promotion_discount_brl: promotionPick.selected_promotion_discount_brl ?? null,
    selected_promotion_discount_percent: promotionPick.selected_promotion_discount_percent ?? null,
    selected_promotion_strategy: promotionPick.selected_promotion_strategy ?? null,
    active_promotions_count: promotionPick.active_promotions_count ?? 0,
    current_price: effectivePrice,
    current_price_brl: effectivePrice,
    current_regular_price:
      originalPrice != null && effectivePrice != null && String(originalPrice) !== String(effectivePrice)
        ? originalPrice
        : base.current_regular_price ?? null,
    regular_price_brl:
      originalPrice != null && effectivePrice != null && String(originalPrice) !== String(effectivePrice)
        ? originalPrice
        : base.regular_price_brl ?? null,
    row_projected_payout_brl: base.projected_payout ?? null,
    row_projected_commission_brl: base.projected_commission ?? null,
    row_projected_freight_brl: base.projected_freight ?? null,
    row_projected_tax_brl: base.projected_tax ?? null,
    row_projected_product_cost_brl: base.product_cost_brl ?? base.current_product_cost ?? null,
    row_projected_profit_brl: base.projected_profit_brl ?? null,
    row_projected_profit_percent: base.projected_profit_percent ?? null,
    pricing_source_trace: {
      ...(base.pricing_source_trace != null && typeof base.pricing_source_trace === "object"
        ? /** @type {Record<string, unknown>} */ (base.pricing_source_trace)
        : {}),
      engine_source: engineSource,
      selected_promotion_strategy: promotionPick.selected_promotion_strategy ?? null,
      selected_promotion_id: promotionPick.selected_promotion_id ?? null,
    },
  };
}

/**
 * Snapshot local — sem simulate/live ML (local_only=1).
 * @param {{
 *   gridRow: Record<string, unknown>;
 *   listing: Record<string, unknown>;
 *   health?: Record<string, unknown> | null;
 * }} ctx
 */
export function buildLocalPersistedPricingCurrentState(ctx) {
  const { gridRow, listing, health = null } = ctx;
  const listingType = resolveListingTypeChoiceFromGridRow(gridRow);
  const promotionPick = selectLowestActiveEffectivePromotionForList({ listing, health, gridRow });
  const adjustedRow = gridRowWithPromotionPick(gridRow, promotionPick);
  const base = buildPricingCurrentStateRowContract(adjustedRow);
  return mergePromotionMetadataIntoContract(
    base,
    promotionPick,
    listingType,
    "local_persisted_snapshot",
  );
}

/**
 * @param {{
 *   gridRow: Record<string, unknown>;
 *   listing?: Record<string, unknown> | null;
 *   health?: Record<string, unknown> | null;
 *   errorMessage: string;
 *   fallbackUsed?: string;
 * }} p
 */
export function buildPricingEngineErrorContract(p) {
  const { gridRow, listing = null, health = null, errorMessage, fallbackUsed = "legacy_row_contract" } = p;
  let promotionPick;
  try {
    promotionPick = selectLowestActiveEffectivePromotionForList({
      listing: listing ?? {},
      health,
      gridRow,
    });
  } catch {
    promotionPick = {
      current_effective_price_brl: gridRow.effective_sale_price_brl ?? null,
      selected_promotion_id: null,
      active_promotions_count: 0,
      selected_promotion_strategy: null,
      original_price_brl: null,
      base_sale_price_brl: null,
      current_effective_price_source: "grid.effective_sale_price_brl",
    };
  }

  const listingType = resolveListingTypeChoiceFromGridRow(gridRow);
  const adjustedRow = gridRowWithPromotionPick(gridRow, promotionPick);
  const base = buildPricingCurrentStateRowContract(adjustedRow);
  const merged = mergePromotionMetadataIntoContract(
    base,
    promotionPick,
    listingType,
    fallbackUsed,
  );

  /** @type {string[]} */
  const flags = Array.isArray(merged.missing_data_flags)
    ? [.../** @type {string[]} */ (merged.missing_data_flags)]
    : [];
  if (!flags.includes("pricing_engine_error")) flags.push("pricing_engine_error");

  return {
    ...merged,
    row_projected_payout_brl: null,
    row_projected_commission_brl: null,
    row_projected_freight_brl: null,
    row_projected_tax_brl: null,
    row_projected_product_cost_brl: merged.product_cost_brl ?? null,
    row_projected_profit_brl: null,
    row_projected_profit_percent: null,
    projected_profit_brl: null,
    projected_profit_percent: null,
    missing_data_flags: flags,
    pricing_engine_error: String(errorMessage ?? "pricing_engine_error").slice(0, 240),
    pricing_engine_fallback_used: fallbackUsed,
  };
}

/**
 * @param {Record<string, unknown>} contract
 */
export function logPricingEngineRowOk(contract, gridRow = null) {
  const externalId =
    contract.external_listing_id != null
      ? String(contract.external_listing_id).trim()
      : gridRow?.external_listing_id != null
        ? String(gridRow.external_listing_id).trim()
        : "";
  if (!HOMOLOG_LISTING_IDS.has(externalId)) return;

  console.info("[S7_PRICING_ENGINE_ROW_OK]", {
    listing_id: contract.external_listing_id ?? contract.listing_id ?? null,
    current_effective_price_brl: contract.current_effective_price_brl ?? contract.current_price_brl ?? null,
    original_price_brl: contract.original_price_brl ?? contract.regular_price_brl ?? null,
    selected_listing_type: contract.selected_listing_type ?? contract.row_selected_scenario ?? null,
    selected_promotion_id: contract.selected_promotion_id ?? null,
    row_projected_payout_brl: contract.row_projected_payout_brl ?? contract.projected_payout ?? null,
    row_projected_commission_brl: contract.row_projected_commission_brl ?? contract.projected_commission ?? null,
    row_projected_freight_brl: contract.row_projected_freight_brl ?? contract.projected_freight ?? null,
    row_projected_tax_brl: contract.row_projected_tax_brl ?? contract.projected_tax ?? null,
    row_projected_product_cost_brl:
      contract.row_projected_product_cost_brl ?? contract.product_cost_brl ?? null,
    row_projected_profit_brl: contract.row_projected_profit_brl ?? contract.projected_profit_brl ?? null,
    row_projected_profit_percent:
      contract.row_projected_profit_percent ?? contract.projected_profit_percent ?? null,
    source_contract: contract.contract_kind ?? "pricing_current_state_projected_unit",
  });
}

/**
 * @param {{
 *   gridRow: Record<string, unknown>;
 *   listing?: Record<string, unknown> | null;
 *   health?: Record<string, unknown> | null;
 *   err: unknown;
 *   fallbackUsed?: string;
 * }} p
 */
export function logPricingEngineRowError(p) {
  const { gridRow, listing = null, health = null, err, fallbackUsed = "legacy_row_contract" } = p;
  const promoMeta = countPromotionsSnapshot(listing ?? {}, health);
  const summary = summarizeError(err);

  console.warn("[S7_PRICING_ENGINE_ROW_ERROR]", {
    listing_id: gridRow.external_listing_id ?? gridRow.id ?? null,
    sku: gridRow.sku ?? listing?.product_sku ?? listing?.sku ?? null,
    account_id: gridRow.marketplace_account_id ?? listing?.marketplace_account_id ?? null,
    listing_type: gridRow.listing_type_label ?? gridRow.listing_type_id ?? null,
    has_pricing_context: gridRow.pricing_context != null,
    has_promotions_snapshot: promoMeta.has_promotions_snapshot,
    promotions_count: promoMeta.promotions_count,
    selected_promotion_id: promoMeta.selected_promotion_id,
    error_name: summary.error_name,
    error_message: summary.error_message,
    fallback_used: fallbackUsed,
  });
}

/**
 * @param {{
 *   route: string;
 *   localOnly: boolean;
 *   userId?: string | null;
 *   err: unknown;
 *   stage: string;
 * }} p
 */
export function logPricingListLoadFatal(p) {
  const summary = summarizeError(p.err);
  console.error("[S7_PRICING_LIST_LOAD_FATAL]", {
    route: p.route,
    local_only: p.localOnly,
    seller_account: p.userId ?? null,
    stage: p.stage,
    error_name: summary.error_name,
    error_message: summary.error_message,
    stack: summary.stack,
  });
}
