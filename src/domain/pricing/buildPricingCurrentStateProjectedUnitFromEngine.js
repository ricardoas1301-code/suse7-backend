// ======================================================
// pricing_current_state_projected_unit — engine PI homologada (paridade Modal).
// ======================================================

import Decimal from "decimal.js";

import { MercadoLivrePricingSimulator, mapMercadoLivreScenarioToFlatFinancialContract } from "./marketplacePricingSimulator.js";
import { buildPricingCurrentStateRowContract } from "./buildPricingCurrentStateRowContract.js";
import { readPricingSimulationConfigFromRawJson } from "./listingPricingSimulationConfig.js";
import { readCommercialFlagsFromHealthRow } from "../sales/saleListingHealthCommercial.js";
import {
  mergePricingSimulationConfigPreferHealth,
  pricingSimulationConfigToFinancialExtras,
} from "./pricingSimulationConfigToFinancialExtras.js";
import {
  resolveListingTypeChoiceFromGridRow,
  selectLowestActiveEffectivePromotionForList,
} from "./selectLowestActiveEffectivePromotionForList.js";
import {
  resolveOfficialPromotionPresentationFinancials,
  resolveOfficialSellerPromotionFinancials,
} from "./mercadoLivreOfficialSellerPromotions.js";
import {
  calcularLucroPromocaoComCustosExibidos,
  recalcularContratoFinanceiroPromocaoSelecionada,
} from "./mercadoLivrePromotionCalcCardSelectionParity.js";
import { aplicarExtrasPrecificacaoInteligente } from "./aplicarExtrasPrecificacaoInteligente.js";
import { classifyOfferMarginStatus } from "../offerMarginStatus.js";

const HOMOLOG_LISTING_IDS = new Set(["MLB6086602390", "MLB6784329822"]);

const ROUND = Decimal.ROUND_HALF_UP;

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
 * Aplica redução de tarifa / payout oficial da promoção selecionada sobre o cenário simulado.
 * @param {Record<string, unknown>} scenario
 * @param {Record<string, unknown>} rawPromoRow
 * @param {string | null} salePriceStr
 * @param {import("./aplicarExtrasPrecificacaoInteligente.js").ExtrasPrecificacaoInteligenteInput | null | undefined} extrasInput
 * @param {string | null | undefined} listingExternalId
 */
function overlaySelectedPromotionFinancialsOnScenario(
  scenario,
  rawPromoRow,
  salePriceStr,
  extrasInput,
  listingExternalId,
) {
  if (scenario == null || typeof scenario !== "object") return scenario;
  const m0 =
    scenario.marketplace != null && typeof scenario.marketplace === "object"
      ? /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (scenario.marketplace) })
      : /** @type {Record<string, unknown>} */ ({});

  const grossFeeStr =
    m0.sale_fee_amount_brl != null
      ? String(m0.sale_fee_amount_brl)
      : m0.fee_amount_brl != null
        ? String(m0.fee_amount_brl)
        : null;
  const shipStr =
    m0.shipping_cost_amount_brl != null ? String(m0.shipping_cost_amount_brl) : null;

  const fin = resolveOfficialSellerPromotionFinancials(rawPromoRow, salePriceStr, null, {
    listingId: listingExternalId,
  });
  const presentation = resolveOfficialPromotionPresentationFinancials({
    grossFeeBrl: grossFeeStr,
    salePriceBrl: salePriceStr,
    shippingCostBrl: shipStr,
    fin,
    rawRow: rawPromoRow,
  });

  const feeReductionDec = toDec(presentation.fee_discount_brl);
  const hasFeeSubsidy = feeReductionDec != null && feeReductionDec.gt(0);

  if (presentation.gross_fee_brl != null) {
    m0.fee_amount_before_promo_subsidy_brl = presentation.gross_fee_brl;
    m0.sale_fee_amount_brl = presentation.gross_fee_brl;
  }
  if (presentation.net_fee_brl != null) {
    m0.fee_amount_after_promo_subsidy_brl = presentation.net_fee_brl;
    m0.sale_fee_net_display_brl = presentation.net_fee_brl;
    m0.promotion_fee_net_brl = presentation.net_fee_brl;
    m0.sale_fee_amount_brl = presentation.net_fee_brl;
    m0.fee_amount_brl = presentation.net_fee_brl;
  }
  if (presentation.fee_discount_brl != null && hasFeeSubsidy) {
    m0.promotion_subsidy_amount_brl = presentation.fee_discount_brl;
    m0.fee_discount_brl = presentation.fee_discount_brl;
    m0.has_fee_subsidy = true;
  }
  if (presentation.expected_payout_brl != null) {
    m0.marketplace_payout_amount_brl = presentation.expected_payout_brl;
    m0.net_receivable_brl = presentation.expected_payout_brl;
  }
  if (salePriceStr != null) {
    m0.sale_price_brl = salePriceStr;
  }

  let next = { ...scenario, marketplace: m0, sale_price_brl: salePriceStr ?? scenario.sale_price_brl ?? null };
  next = recalcularContratoFinanceiroPromocaoSelecionada(next, extrasInput, {
    listing_id: listingExternalId ?? null,
    promotion_id: rawPromoRow.id ?? rawPromoRow.promotion_id ?? null,
    promotion_name: rawPromoRow.name ?? rawPromoRow.promotion_name ?? null,
    promotion_type: rawPromoRow.type ?? rawPromoRow.promotion_type ?? null,
    selected_final_price: salePriceStr,
    amount_to_receive_source: "official_promotion_presentation_overlay",
    selected_rule: "lowest_active_effective_price",
  });

  const applied = aplicarExtrasPrecificacaoInteligente(
    /** @type {Record<string, unknown>} */ ({ ...next }),
    extrasInput,
  );
  const mk =
    applied.marketplace != null && typeof applied.marketplace === "object"
      ? /** @type {Record<string, unknown>} */ (applied.marketplace)
      : {};
  const ic =
    applied.internal_costs != null && typeof applied.internal_costs === "object"
      ? /** @type {Record<string, unknown>} */ (applied.internal_costs)
      : {};
  const pi =
    applied.pricing_intelligence_extras != null &&
    typeof applied.pricing_intelligence_extras === "object"
      ? /** @type {Record<string, unknown>} */ (applied.pricing_intelligence_extras)
      : {};

  const payout = toDec(mk.marketplace_payout_amount_brl ?? mk.net_receivable_brl);
  if (payout != null) {
    const profit = calcularLucroPromocaoComCustosExibidos({
      payout,
      productCost: toDec(ic.product_cost_brl) ?? new Decimal(0),
      tax: toDec(ic.tax_amount_brl) ?? new Decimal(0),
      packaging: toDec(ic.operational_packaging_total_brl) ?? new Decimal(0),
      mlAds: toDec(pi.ads_brl) ?? new Decimal(0),
      operational: toDec(pi.operational_cost_brl) ?? new Decimal(0),
      promoReserve: toDec(pi.promotion_reserve_brl) ?? new Decimal(0),
      affiliate: toDec(pi.affiliate_brl) ?? new Decimal(0),
    });
    const saleDec = toDec(salePriceStr ?? mk.sale_price_brl);
    const marginPct =
      saleDec != null && saleDec.gt(0) ? profit.times(100).div(saleDec) : null;
    const baseResult =
      applied.result != null && typeof applied.result === "object"
        ? /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (applied.result) })
        : /** @type {Record<string, unknown>} */ ({});
    return {
      ...applied,
      result: {
        ...baseResult,
        profit_brl: decStr2(profit),
        margin_pct: decStr2(marginPct),
        offer_status: classifyOfferMarginStatus(marginPct, profit),
      },
    };
  }

  return applied;
}

/**
 * @param {Record<string, unknown>} financial
 * @param {Record<string, unknown> | null | undefined} scenario
 */
function buildScenarioBlock(financial, scenario) {
  const ic =
    scenario?.internal_costs != null && typeof scenario.internal_costs === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.internal_costs)
      : {};
  const pi =
    scenario?.pricing_intelligence_extras != null && typeof scenario.pricing_intelligence_extras === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.pricing_intelligence_extras)
      : {};

  const packagingDec = toDec(ic.operational_packaging_total_brl);
  const opExtraDec = toDec(financial.operational_cost_brl ?? pi.operational_cost_brl);
  const mlAdsDec = toDec(financial.ads_brl ?? pi.ads_brl);

  return {
    sale_price_brl: financial.sale_price_brl ?? null,
    marketplace_fee_brl: financial.official_fee_brl ?? null,
    shipping_cost_brl: financial.shipping_cost_brl ?? null,
    payout_brl: financial.payout_brl ?? null,
    product_cost_brl: financial.product_cost_brl ?? null,
    tax_brl: financial.tax_brl ?? null,
    ml_ads_cost_brl: decStr2(mlAdsDec),
    operational_cost_brl: decStr2(opExtraDec),
    package_cost_brl: decStr2(packagingDec),
    profit_brl: financial.profit_brl ?? null,
    profit_percent: financial.margin_percent ?? null,
  };
}

/**
 * @param {{
 *   financial: Record<string, unknown>;
 *   scenario: Record<string, unknown> | null | undefined;
 *   gridRow: Record<string, unknown>;
 *   listing: Record<string, unknown>;
 *   listingType: "classic" | "premium";
 *   promotionPick: ReturnType<typeof selectLowestActiveEffectivePromotionForList>;
 *   engineSource: string;
 * }} p
 */
export function mapEngineFinancialToPricingCurrentStateContract(p) {
  const { financial, scenario, gridRow, listing, listingType, promotionPick, engineSource } = p;
  const scenarioBlock = buildScenarioBlock(financial, scenario);
  const fallback = buildPricingCurrentStateRowContract(gridRow);

  /** @type {string[]} */
  const missingDataFlags = Array.isArray(fallback.missing_data_flags)
    ? [.../** @type {string[]} */ (fallback.missing_data_flags)]
    : [];

  if (financial.sale_price_brl == null) missingDataFlags.push("current_price_unavailable");
  if (financial.payout_brl == null) missingDataFlags.push("payout_unavailable");
  if (financial.profit_brl == null) missingDataFlags.push("profit_unavailable");

  const effectivePrice =
    promotionPick.current_effective_price_brl ??
    financial.sale_price_brl ??
    fallback.current_price_brl ??
    null;
  const originalPrice =
    promotionPick.original_price_brl ??
    promotionPick.base_sale_price_brl ??
    gridRow.listing_sale_price_brl ??
    gridRow.listing_price_brl ??
    fallback.current_regular_price ??
    null;

  const premiumBlock = listingType === "premium" ? scenarioBlock : null;
  const classicBlock = listingType === "classic" ? scenarioBlock : null;

  return {
    contract_kind: "pricing_current_state_projected_unit",
    money_scale: "BRL_DECIMAL",
    listing_id: gridRow.id ?? gridRow.listing_id ?? listing.id ?? null,
    external_listing_id: gridRow.external_listing_id ?? listing.external_listing_id ?? null,
    product_id: gridRow.product_id ?? listing.product_id ?? null,
    sku: gridRow.sku ?? listing.product_sku ?? listing.sku ?? null,
    marketplace: gridRow.marketplace ?? listing.marketplace ?? null,
    account_id: gridRow.marketplace_account_id ?? listing.marketplace_account_id ?? null,

    original_price_brl: originalPrice,
    base_sale_price_brl: promotionPick.base_sale_price_brl ?? originalPrice,
    current_effective_price_brl: effectivePrice,
    current_effective_price_source: promotionPick.current_effective_price_source ?? engineSource,

    selected_listing_type: listingType,
    selected_promotion_id: promotionPick.selected_promotion_id ?? null,
    selected_promotion_name: promotionPick.selected_promotion_name ?? null,
    selected_promotion_status: promotionPick.selected_promotion_status ?? null,
    selected_promotion_price_brl: promotionPick.selected_promotion_price_brl ?? null,
    selected_promotion_discount_brl: promotionPick.selected_promotion_discount_brl ?? null,
    selected_promotion_discount_percent: promotionPick.selected_promotion_discount_percent ?? null,
    selected_promotion_strategy: promotionPick.selected_promotion_strategy ?? null,
    active_promotions_count: promotionPick.active_promotions_count ?? 0,

    premium: premiumBlock,
    classic: classicBlock,
    row_selected_scenario: listingType,
    row_projected_payout_brl: scenarioBlock.payout_brl,
    row_projected_commission_brl: scenarioBlock.marketplace_fee_brl,
    row_projected_freight_brl: scenarioBlock.shipping_cost_brl,
    row_projected_tax_brl: scenarioBlock.tax_brl,
    row_projected_product_cost_brl: scenarioBlock.product_cost_brl,
    row_projected_ml_ads_cost_brl: scenarioBlock.ml_ads_cost_brl,
    row_projected_operational_cost_brl: scenarioBlock.operational_cost_brl,
    row_projected_package_cost_brl: scenarioBlock.package_cost_brl,
    row_projected_profit_brl: scenarioBlock.profit_brl,
    row_projected_profit_percent: scenarioBlock.profit_percent,

    current_price: effectivePrice,
    current_price_brl: effectivePrice,
    current_regular_price: originalPrice != null && effectivePrice != null && originalPrice !== effectivePrice ? originalPrice : null,
    regular_price_brl: originalPrice != null && effectivePrice != null && originalPrice !== effectivePrice ? originalPrice : null,
    promotion_active:
      promotionPick.selected_promotion_price_brl != null ||
      gridRow.promotion_active === true ||
      fallback.promotion_active === true,
    current_listing_type: gridRow.listing_type_label ?? fallback.current_listing_type ?? null,
    listing_type: gridRow.listing_type_label ?? fallback.listing_type ?? null,

    projected_payout: scenarioBlock.payout_brl,
    projected_commission: scenarioBlock.marketplace_fee_brl,
    projected_commission_percent: financial.official_fee_percent ?? fallback.projected_commission_percent ?? null,
    projected_freight: scenarioBlock.shipping_cost_brl,
    projected_tax: scenarioBlock.tax_brl,
    projected_tax_percent: financial.tax_percent ?? fallback.projected_tax_percent ?? null,
    current_product_cost: scenarioBlock.product_cost_brl,
    product_cost_brl: scenarioBlock.product_cost_brl,
    current_operational_cost: scenarioBlock.package_cost_brl,
    projected_profit_brl: scenarioBlock.profit_brl,
    projected_profit_percent: scenarioBlock.profit_percent,

    pricing_source_trace: {
      ...(fallback.pricing_source_trace != null && typeof fallback.pricing_source_trace === "object"
        ? /** @type {Record<string, unknown>} */ (fallback.pricing_source_trace)
        : {}),
      engine_source: engineSource,
      selected_promotion_strategy: promotionPick.selected_promotion_strategy ?? null,
      selected_promotion_id: promotionPick.selected_promotion_id ?? null,
      selected_promotion_name: promotionPick.selected_promotion_name ?? null,
      current_effective_price_source: promotionPick.current_effective_price_source ?? null,
      normalized_current_price_brl: effectivePrice,
      normalized_profit_brl: scenarioBlock.profit_brl,
      normalized_profit_percent: scenarioBlock.profit_percent,
      normalized_commission_brl: scenarioBlock.marketplace_fee_brl,
      normalized_shipping_brl: scenarioBlock.shipping_cost_brl,
      normalized_tax_brl: scenarioBlock.tax_brl,
      normalized_product_cost_brl: scenarioBlock.product_cost_brl,
      normalized_ml_ads_cost_brl: scenarioBlock.ml_ads_cost_brl,
      normalized_operational_cost_brl: scenarioBlock.operational_cost_brl,
      normalized_package_cost_brl: scenarioBlock.package_cost_brl,
    },
    missing_data_flags: missingDataFlags,
  };
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   userId: string;
 *   gridRow: Record<string, unknown>;
 *   listing: Record<string, unknown>;
 *   health?: Record<string, unknown> | null;
 *   mlAccessToken?: string | null;
 *   referenceZipCode?: string | null;
 *   localOnly?: boolean;
 * }} ctx
 */
export async function buildPricingCurrentStateProjectedUnitFromEngine(ctx) {
  const { supabase, userId, gridRow, listing, health = null } = ctx;
  const localOnly = ctx.localOnly === true;

  const listingType = resolveListingTypeChoiceFromGridRow(gridRow);
  let promotionPick;
  try {
    promotionPick = selectLowestActiveEffectivePromotionForList({ listing, health, gridRow });
  } catch {
    promotionPick = {
      current_effective_price_brl: gridRow.effective_sale_price_brl ?? null,
      selected_promotion_id: null,
      active_promotions_count: 0,
      selected_promotion_strategy: null,
      original_price_brl: null,
      base_sale_price_brl: null,
      current_effective_price_source: "grid.effective_sale_price_brl",
      promotionSelection: null,
    };
  }

  const rawConfig = readPricingSimulationConfigFromRawJson(listing.raw_json);
  const healthConfig = readCommercialFlagsFromHealthRow(health);
  const mergedConfig = mergePricingSimulationConfigPreferHealth(healthConfig, rawConfig);
  const financialExtras = pricingSimulationConfigToFinancialExtras(mergedConfig);

  const salePrice =
    promotionPick.current_effective_price_brl ??
    gridRow.effective_sale_price_brl ??
    gridRow.listing_sale_price_brl ??
    gridRow.listing_price_brl ??
    null;

  if (salePrice == null || String(salePrice).trim() === "") {
    return buildPricingCurrentStateRowContract(gridRow);
  }

  const referenceZipCode =
    ctx.referenceZipCode ??
    process.env.SUSE7_ML_PRICING_REFERENCE_ZIP?.trim() ??
    process.env.ML_PRICING_REFERENCE_ZIP?.trim() ??
    "01310100";

  let simResult;
  try {
    simResult = await MercadoLivrePricingSimulator.simulate(supabase, userId, {
      listingExternalId:
        gridRow.external_listing_id != null ? String(gridRow.external_listing_id).trim() : undefined,
      listingId: gridRow.id != null ? String(gridRow.id).trim() : undefined,
      listingType,
      salePrice,
      mlAccessToken: localOnly ? null : ctx.mlAccessToken ?? null,
      referenceZipCode,
      financialExtras,
      promotionSelection: promotionPick.promotionSelection ?? undefined,
    });
  } catch (simErr) {
    return buildPricingCurrentStateRowContract({
      ...gridRow,
      effective_sale_price_brl: salePrice,
      promotion_sale_price_brl: promotionPick.selected_promotion_price_brl ?? gridRow.promotion_sale_price_brl,
      promotion_active: promotionPick.selected_promotion_price_brl != null || gridRow.promotion_active === true,
    });
  }

  if (!simResult.ok || simResult.data?.financial == null) {
    const fallback = buildPricingCurrentStateRowContract({
      ...gridRow,
      effective_sale_price_brl: salePrice,
      promotion_sale_price_brl: promotionPick.selected_promotion_price_brl ?? gridRow.promotion_sale_price_brl,
      promotion_active: promotionPick.selected_promotion_price_brl != null || gridRow.promotion_active === true,
    });
    return fallback;
  }

  const data = /** @type {Record<string, unknown>} */ (simResult.data);
  let scenario =
    data.scenario != null && typeof data.scenario === "object"
      ? /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (data.scenario) })
      : null;

  const rawPromoRow =
    promotionPick.promotionSelection?.ml_api_raw_row != null &&
    typeof promotionPick.promotionSelection.ml_api_raw_row === "object"
      ? /** @type {Record<string, unknown>} */ (promotionPick.promotionSelection.ml_api_raw_row)
      : null;

  if (scenario != null && rawPromoRow != null) {
    scenario = overlaySelectedPromotionFinancialsOnScenario(
      scenario,
      rawPromoRow,
      salePrice != null ? String(salePrice) : null,
      financialExtras,
      gridRow.external_listing_id != null ? String(gridRow.external_listing_id) : null,
    );
  }

  const financial = mapMercadoLivreScenarioToFlatFinancialContract(scenario ?? {}, {
    listing_external_id: gridRow.external_listing_id != null ? String(gridRow.external_listing_id) : null,
    listing_type: listingType,
    commission_source: data.commission_source != null ? String(data.commission_source) : null,
    official_fee_percent: data.official_fee_percent != null ? String(data.official_fee_percent) : null,
  });

  return mapEngineFinancialToPricingCurrentStateContract({
    financial,
    scenario,
    gridRow,
    listing,
    listingType,
    promotionPick,
    engineSource: localOnly ? "local_persisted_engine" : "MercadoLivrePricingSimulator.simulate",
  });
}

/**
 * @param {Record<string, unknown>} contract
 */
export function logPricingListModalParityAudit(contract) {
  const externalId =
    contract.external_listing_id != null ? String(contract.external_listing_id).trim() : "";
  if (!HOMOLOG_LISTING_IDS.has(externalId) && process.env.S7_PRICING_LIST_MODAL_PARITY_AUDIT !== "1") {
    return;
  }

  console.info("[S7_PRICING_LIST_MODAL_PARITY_AUDIT]", {
    listing_id: contract.external_listing_id ?? contract.listing_id ?? null,
    current_effective_price_brl: contract.current_effective_price_brl ?? contract.current_price_brl ?? null,
    original_price_brl: contract.original_price_brl ?? contract.regular_price_brl ?? null,
    selected_listing_type: contract.selected_listing_type ?? contract.row_selected_scenario ?? null,
    selected_promotion_id: contract.selected_promotion_id ?? null,
    selected_promotion_name: contract.selected_promotion_name ?? null,
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
 * @param {Record<string, unknown>} contract
 */
export function logPricingCurrentEffectivePriceParity(contract) {
  const externalId =
    contract.external_listing_id != null ? String(contract.external_listing_id).trim() : "";
  const homologCase = externalId === "MLB6086602390";
  const auditEnabled =
    homologCase ||
    process.env.S7_PRICING_CURRENT_EFFECTIVE_PRICE_AUDIT === "1" ||
    process.env.NODE_ENV !== "production";

  if (!auditEnabled) return;

  console.info("[S7_PRICING_CURRENT_EFFECTIVE_PRICE_PARITY]", {
    listing_id: contract.external_listing_id ?? contract.listing_id ?? null,
    sku: contract.sku ?? null,
    original_price_brl: contract.original_price_brl ?? contract.regular_price_brl ?? null,
    base_sale_price_brl: contract.base_sale_price_brl ?? null,
    active_promotions_count: contract.active_promotions_count ?? null,
    selected_promotion_id: contract.selected_promotion_id ?? null,
    selected_promotion_name: contract.selected_promotion_name ?? null,
    selected_promotion_price_brl: contract.selected_promotion_price_brl ?? null,
    selected_promotion_strategy: contract.selected_promotion_strategy ?? null,
    selected_listing_type: contract.selected_listing_type ?? contract.row_selected_scenario ?? null,
    row_projected_payout_brl: contract.row_projected_payout_brl ?? contract.projected_payout ?? null,
    row_projected_commission_brl: contract.row_projected_commission_brl ?? contract.projected_commission ?? null,
    row_projected_freight_brl: contract.row_projected_freight_brl ?? contract.projected_freight ?? null,
    row_projected_tax_brl: contract.row_projected_tax_brl ?? contract.projected_tax ?? null,
    row_projected_product_cost_brl: contract.row_projected_product_cost_brl ?? contract.product_cost_brl ?? null,
    row_projected_ml_ads_cost_brl: contract.row_projected_ml_ads_cost_brl ?? null,
    row_projected_operational_cost_brl: contract.row_projected_operational_cost_brl ?? null,
    row_projected_package_cost_brl: contract.row_projected_package_cost_brl ?? null,
    row_projected_profit_brl: contract.row_projected_profit_brl ?? contract.projected_profit_brl ?? null,
    row_projected_profit_percent: contract.row_projected_profit_percent ?? contract.projected_profit_percent ?? null,
    source_contract: contract.contract_kind ?? "pricing_current_state_projected_unit",
  });
}
