// ======================================================
// Frete por cenário — orquestração assíncrona (ML)
// Fonte única alinhada ao simulador oficial do Mercado Livre:
// 1) GET /sites/.../listing_prices → sale_fee_details (logística)
// 2) GET /users/:id/shipping_options/free → coverage.all_country.list_cost
// 3) GET /items/:id/shipping_options?price&zip
// 4) Cadeia síncrona (GAP/health) — somente fallback explícito
//
/**
 * ENGINE FINANCEIRA HOMOLOGADA
 *
 * Alterações exigem:
 * - Nova trilha
 * - Nova homologação
 * - Comparação com simulador oficial ML
 *
 * Não alterar sem aprovação explícita.
 * Doc: docs/precificacao/PI_ENGINE_HOMOLOGADA.md
 */
// ======================================================

import Decimal from "decimal.js";
import {
  fetchMercadoLivreItemShippingOptions,
  parseMercadoLivreItemShippingOptionsForScenario,
} from "../../handlers/ml/_helpers/mercadoLivreItemShippingOptionsApi.js";
import {
  enrichItemWithListingPricesFees,
  fetchSellerShippingOptionsFree,
  fetchSellerShippingOptionsFreeDual,
} from "../../handlers/ml/_helpers/mercadoLibreItemsApi.js";
import {
  extractMercadoLivreOfficialShippingFromListingPricesRow,
  extractNetReceivableExplicitWithListingPricesRow,
} from "../../handlers/ml/_helpers/mlItemMoneyExtract.js";
import {
  logPricingEvent,
  PRICING_LOG_LEVEL,
  PRICING_EVENT_CODE,
} from "./pricingInconsistencyLog.js";
import {
  montarItemMlSinteticoPorPreco,
  snapshotListingPricesCoerenteComPreco,
} from "./mercadoLivreOfficialScenarioResolvers.js";
import { logPricingPiOfficialApiCall } from "./pricingFlowDiffLog.js";

const ROUND = Decimal.ROUND_HALF_UP;
const MIN_SUSPICIOUS_SHIPPING_BRL = new Decimal("30.00");

/**
 * @typedef {{
 *   amount_brl: string | null;
 *   source: string;
 *   shipping_context: "buyer_pays" | "free_for_buyer" | null;
 *   shipping_subsidy_amount_brl: string | null;
 *   is_shipping_estimated: boolean;
 *   warning?: string | null;
 * }} MercadoLivreScenarioShippingResolution
 */

/** @param {Decimal | null} d @returns {string | null} */
function decStr2(d) {
  if (d == null || !d.isFinite()) return null;
  return d.toDecimalPlaces(2, ROUND).toFixed(2);
}

/**
 * Rejeita frete muito baixo quando há âncora forte de valor maior (evita 26,45 vs 68,65).
 * @param {Decimal} candidate
 * @param {Decimal | null} anchor
 */
function isSuspiciousLowShipping(candidate, anchor) {
  if (!candidate.isFinite() || candidate.lte(0)) return true;
  if (candidate.gte(MIN_SUSPICIOUS_SHIPPING_BRL)) return false;
  if (anchor != null && anchor.isFinite() && anchor.gte(40) && anchor.gte(candidate.times(1.8))) {
    return true;
  }
  return false;
}

/**
 * @param {{
 *   listing_id?: string | null;
 *   sale_price: string | null;
 *   source: string;
 *   shipping_cost_brl: string | null;
 *   buyer_shipping_context?: string | null;
 *   raw_reference?: string | null;
 * }} payload
 */
function logOfficialShippingResolver(payload) {
  console.info("[ml-official-shipping-resolver]", payload);
}

/**
 * Snapshot listing_prices por preço — logística, payout e linha crua (auditoria).
 * @param {{
 *   accessToken: string;
 *   listing: Record<string, unknown>;
 *   priceStr: string;
 *   itemId: string;
 *   listingUuid: string | null;
 *   scenarioType: string;
 * }} p
 * @returns {Promise<{
 *   logistics_brl: string | null;
 *   payout_brl: string | null;
 *   row: Record<string, unknown> | null;
 * } | null>}
 */
async function snapshotListingPricesPorPreco(p) {
  const { accessToken, listing, priceStr, itemId, listingUuid, scenarioType } = p;
  const priceDec = new Decimal(priceStr);
  const itemSintetico = montarItemMlSinteticoPorPreco(listing, priceDec, {
    externalListingId: itemId || (listing.external_listing_id != null ? String(listing.external_listing_id) : ""),
  });

  try {
    const enriched = await enrichItemWithListingPricesFees(accessToken, itemSintetico, {
      healthSync: false,
      preservarPrecoCenarioSimulacao: true,
    });
    const rec = enriched && typeof enriched === "object" ? /** @type {Record<string, unknown>} */ (enriched) : {};
    const rowPersist =
      rec._suse7_listing_prices_row_persist != null && typeof rec._suse7_listing_prices_row_persist === "object"
        ? /** @type {Record<string, unknown>} */ (rec._suse7_listing_prices_row_persist)
        : rec;
    const logisticsNum = extractMercadoLivreOfficialShippingFromListingPricesRow(rowPersist, {
      listing_id: itemId,
      logContext: "ml_snapshot_listing_prices",
    });
    const payoutNum = extractNetReceivableExplicitWithListingPricesRow(rec, rowPersist);
    const logistics_brl =
      logisticsNum != null && logisticsNum > 0 ? decStr2(new Decimal(logisticsNum)) : null;
    const payout_brl = payoutNum != null && payoutNum > 0 ? decStr2(new Decimal(payoutNum)) : null;

    if (!snapshotListingPricesCoerenteComPreco(priceStr, payout_brl)) {
      console.info("[ml-shipping-raw] listing_prices_stale_rejected", {
        listing_id: listingUuid ?? itemId,
        scenario_type: scenarioType,
        sale_price: priceStr,
        logistics_brl,
        payout_brl,
        reason: "payout_incoerente_com_sale_price",
      });
      return { logistics_brl: null, payout_brl: null, row: null };
    }

    const logisticsOut = payout_brl != null ? logistics_brl : null;

    console.info("[ml-shipping-raw]", {
      endpoint: "GET /sites/{site_id}/listing_prices",
      listing_id: listingUuid ?? itemId,
      scenario_type: scenarioType,
      sale_price: priceStr,
      logistics_brl: logisticsOut,
      payout_brl,
      sale_fee_amount: rowPersist.sale_fee_amount ?? rec.sale_fee_amount ?? null,
      sale_fee_percent: rowPersist.sale_fee_percent ?? rec.sale_fee_percent ?? null,
    });

    return { logistics_brl: logisticsOut, payout_brl, row: rowPersist };
  } catch (e) {
    console.info("[ml-shipping-raw] listing_prices_error", {
      listing_id: listingUuid ?? itemId,
      sale_price: priceStr,
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Frete oficial via listing_prices no preço do cenário (mesma fonte do simulador ML).
 * @param {{
 *   accessToken: string;
 *   listing: Record<string, unknown>;
 *   priceStr: string;
 *   itemId: string;
 *   listingUuid: string | null;
 *   scenarioType: string;
 * }} p
 * @returns {Promise<MercadoLivreScenarioShippingResolution | null>}
 */
async function resolverFreteListingPricesPorPreco(p) {
  const { accessToken, listing, priceStr, itemId, listingUuid, scenarioType } = p;
  const priceDec = new Decimal(priceStr);
  const itemSintetico = montarItemMlSinteticoPorPreco(listing, priceDec, {
    externalListingId: itemId || (listing.external_listing_id != null ? String(listing.external_listing_id) : ""),
  });

  try {
    const enriched = await enrichItemWithListingPricesFees(accessToken, itemSintetico, {
      healthSync: false,
      preservarPrecoCenarioSimulacao: true,
    });
    const rec = enriched && typeof enriched === "object" ? /** @type {Record<string, unknown>} */ (enriched) : {};
    const rowPersist =
      rec._suse7_listing_prices_row_persist != null && typeof rec._suse7_listing_prices_row_persist === "object"
        ? /** @type {Record<string, unknown>} */ (rec._suse7_listing_prices_row_persist)
        : rec;
    const logistics = extractMercadoLivreOfficialShippingFromListingPricesRow(rowPersist, {
      listing_id: itemId,
      logContext: "ml_scenario_shipping_listing_prices",
    });
    if (logistics == null || !(logistics > 0)) return null;

    const amt = decStr2(new Decimal(logistics));
    console.info("[ml-shipping-resolver] listing_prices", {
      item_id: itemId,
      listing_id: listingUuid,
      scenario_type: scenarioType,
      sale_price_brl: priceStr,
      shipping_cost_brl: amt,
      source: "ml_listing_prices_logistics",
    });
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_SCENARIO_SHIPPING_RESOLVED, {
      marketplace: "mercado_livre",
      item_id: itemId,
      listing_id: listingUuid,
      external_listing_id: itemId,
      scenario_type: scenarioType,
      sale_price_brl: priceStr,
      source: "ml_listing_prices_logistics",
      is_shipping_estimated: false,
    });
    return {
      amount_brl: amt,
      source: "ml_listing_prices_logistics",
      shipping_context: inferMercadoLivreShippingContext(rec, listing),
      shipping_subsidy_amount_brl: null,
      is_shipping_estimated: false,
    };
  } catch (e) {
    console.info("[ml-shipping-resolver] listing_prices_failed", {
      item_id: itemId,
      sale_price_brl: priceStr,
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Frete via shipping_options/free (painel ML — list_cost integral do seller).
 * @param {{
 *   accessToken: string;
 *   listing: Record<string, unknown>;
 *   priceStr: string;
 *   itemId: string;
 *   listingUuid: string | null;
 *   scenarioType: string;
 * }} p
 * @returns {Promise<MercadoLivreScenarioShippingResolution | null>}
 */
async function resolverFreteShippingOptionsFree(p) {
  const { accessToken, listing, priceStr, itemId, listingUuid, scenarioType } = p;
  const priceDec = new Decimal(priceStr);
  const itemParaFree = montarItemMlSinteticoPorPreco(listing, priceDec, {
    externalListingId: itemId || (listing.external_listing_id != null ? String(listing.external_listing_id) : ""),
    listingTypeId:
      listing.listing_type_id != null ? String(listing.listing_type_id).trim() : null,
  });
  try {
    const fetched = await fetchSellerShippingOptionsFree(accessToken, itemParaFree);
    const payload = fetched.payload;
    const listCost =
      payload != null && typeof payload === "object" && payload.list_cost != null
        ? Number(payload.list_cost)
        : fetched.amount;
    if (listCost == null || !(listCost > 0)) return null;
    const amt = decStr2(new Decimal(listCost));
    const promoted =
      payload != null && typeof payload === "object" && payload.promoted_amount != null
        ? Number(payload.promoted_amount)
        : null;
    console.info("[ml-shipping-resolver] shipping_options_free", {
      item_id: itemId,
      listing_id: listingUuid,
      scenario_type: scenarioType,
      sale_price_brl: priceStr,
      shipping_cost_brl: amt,
      promoted_amount: promoted,
      source: "ml_shipping_options_free_list_cost",
    });
    return {
      amount_brl: amt,
      source: "ml_shipping_options_free_list_cost",
      shipping_context: inferMercadoLivreShippingContext({}, listing),
      shipping_subsidy_amount_brl:
        promoted != null && promoted > 0 ? decStr2(new Decimal(promoted)) : null,
      is_shipping_estimated: false,
    };
  } catch {
    return null;
  }
}

/**
 * Frete PI — shipping_options/free com item_price simulado e free_shipping true/false.
 * Fonte principal para edição/publicação em preço customizado (não items/shipping_options).
 * @param {{
 *   accessToken: string;
 *   listing: Record<string, unknown>;
 *   priceStr: string;
 *   itemId: string;
 *   listingUuid: string | null;
 *   scenarioType: string;
 *   categoryId?: string | null;
 *   listingTypeId?: string | null;
 *   currencyId?: string | null;
 *   logisticType?: string | null;
 *   shippingMode?: string | null;
 *   feeDebug?: Record<string, unknown> | null;
 * }} p
 * @returns {Promise<MercadoLivreScenarioShippingResolution & { pi_api_log?: Record<string, unknown> } | null>}
 */
async function resolverFretePiShippingOptionsFreeDual(p) {
  const {
    accessToken,
    listing,
    priceStr,
    itemId,
    listingUuid,
    scenarioType,
    categoryId,
    listingTypeId,
    currencyId,
    logisticType,
    shippingMode,
    feeDebug,
  } = p;
  const priceDec = new Decimal(priceStr);
  const itemSintetico = montarItemMlSinteticoPorPreco(listing, priceDec, {
    externalListingId: itemId,
    listingTypeId: listingTypeId ?? undefined,
  });

  const sh =
    itemSintetico.shipping != null && typeof itemSintetico.shipping === "object"
      ? /** @type {Record<string, unknown>} */ (itemSintetico.shipping)
      : null;
  const ofereceFreteGratis = sh?.free_shipping === true;

  const dual = await fetchSellerShippingOptionsFreeDual(accessToken, itemSintetico);
  const costTrue =
    dual.free_true.list_cost != null && dual.free_true.list_cost > 0
      ? dual.free_true.list_cost
      : dual.free_true.amount;
  const costFalse =
    dual.free_false.list_cost != null && dual.free_false.list_cost > 0
      ? dual.free_false.list_cost
      : dual.free_false.amount;

  /** @type {{ amount: number | null; context: "free_for_buyer" | "buyer_pays"; source: string }} */
  let selected = { amount: null, context: "free_for_buyer", source: "none" };

  if (ofereceFreteGratis && costTrue != null && costTrue > 0) {
    selected = {
      amount: costTrue,
      context: "free_for_buyer",
      source: "ml_shipping_options_free_list_cost:free_true",
    };
  } else if (costFalse != null && costFalse > 0) {
    selected = {
      amount: costFalse,
      context: "buyer_pays",
      source: "ml_shipping_options_free_list_cost:free_false",
    };
  } else if (costTrue != null && costTrue > 0) {
    selected = {
      amount: costTrue,
      context: ofereceFreteGratis ? "free_for_buyer" : "buyer_pays",
      source: "ml_shipping_options_free_list_cost:free_true_fallback",
    };
  }

  const piLog = {
    listing_id: listingUuid ?? itemId,
    sale_price: priceStr,
    category_id: categoryId ?? itemSintetico.category_id ?? null,
    listing_type_id: listingTypeId ?? itemSintetico.listing_type_id ?? null,
    currency_id: currencyId ?? itemSintetico.currency_id ?? "BRL",
    logistic_type: logisticType ?? sh?.logistic_type ?? null,
    shipping_mode: shippingMode ?? sh?.mode ?? null,
    fee_url: feeDebug?.request_url ?? null,
    fee_status: feeDebug?.response_status ?? null,
    fee_amount_brl: feeDebug?.fee_amount_brl ?? null,
    fee_percent: feeDebug?.fee_percent ?? null,
    shipping_url_free_true: dual.free_true.request_url,
    shipping_status_free_true: dual.free_true.http_status,
    shipping_cost_free_true: costTrue != null && costTrue > 0 ? decStr2(new Decimal(costTrue)) : null,
    shipping_url_free_false: dual.free_false.request_url,
    shipping_status_free_false: dual.free_false.http_status,
    shipping_cost_free_false: costFalse != null && costFalse > 0 ? decStr2(new Decimal(costFalse)) : null,
    selected_shipping_cost_brl:
      selected.amount != null && selected.amount > 0 ? decStr2(new Decimal(selected.amount)) : null,
    selected_shipping_context: selected.context,
    fallback_used: selected.source.includes("fallback"),
  };
  logPricingPiOfficialApiCall(piLog);

  if (selected.amount == null || !(selected.amount > 0)) {
    console.info("[ml-shipping-resolver] pi_shipping_options_free_unresolved", {
      item_id: itemId,
      sale_price_brl: priceStr,
      dual,
    });
    return { amount_brl: null, source: "official_unresolved", pi_api_log: piLog };
  }

  const amt = decStr2(new Decimal(selected.amount));
  console.info("[ml-shipping-resolver] pi_shipping_options_free", {
    item_id: itemId,
    listing_id: listingUuid,
    scenario_type: scenarioType,
    sale_price_brl: priceStr,
    shipping_cost_brl: amt,
    shipping_context: selected.context,
    source: selected.source,
  });
  return {
    amount_brl: amt,
    source: selected.source,
    shipping_context: selected.context,
    shipping_subsidy_amount_brl: null,
    is_shipping_estimated: false,
    pi_api_log: piLog,
  };
}

/**
 * Frete via GET /items/:id/shipping_options?price&zip — fonte oficial por preço (PI).
 * @param {{
 *   accessToken: string;
 *   id: string;
 *   zip: string;
 *   priceStr: string;
 *   listing: Record<string, unknown>;
 *   listingUuid: string | null;
 *   scenarioType: string;
 *   anchorDec: Decimal | null;
 *   trustOfficialApi?: boolean;
 *   officialFeeAmountBrl?: string | null;
 *   listingPricesLogisticsBrl?: string | null;
 *   listingPricesPayoutBrl?: string | null;
 * }} p
 * @returns {Promise<MercadoLivreScenarioShippingResolution | null>}
 */
async function resolverFreteItemShippingOptionsPorPreco(p) {
  const {
    accessToken,
    id,
    zip,
    priceStr,
    listing,
    listingUuid,
    scenarioType,
    anchorDec,
    trustOfficialApi,
    officialFeeAmountBrl,
    listingPricesLogisticsBrl,
    listingPricesPayoutBrl,
  } = p;
  const listingStatus =
    listing?.status != null && String(listing.status).trim() !== ""
      ? String(listing.status).trim()
      : null;
  const listingLogisticType =
    listing?.shipping &&
    typeof listing.shipping === "object" &&
    /** @type {Record<string, unknown>} */ (listing.shipping).logistic_type != null
      ? String(/** @type {Record<string, unknown>} */ (listing.shipping).logistic_type)
      : listing?.shipping_logistic_type != null
        ? String(listing.shipping_logistic_type)
        : null;
  const availableQtyRaw = listing?.available_quantity;
  const availableQty =
    availableQtyRaw != null && availableQtyRaw !== "" && Number.isFinite(Number(availableQtyRaw))
      ? Number(availableQtyRaw)
      : null;
  const marketplaceAccountId =
    listing?.marketplace_account_id != null && String(listing.marketplace_account_id).trim() !== ""
      ? String(listing.marketplace_account_id).trim()
      : null;
  const sellerId =
    listing?.seller_id != null && String(listing.seller_id).trim() !== ""
      ? String(listing.seller_id).trim()
      : null;

  const fetched = await fetchMercadoLivreItemShippingOptions(accessToken, id, {
    zipCode: zip,
    priceBrl: priceStr,
    scenario_type: scenarioType,
    diagnostics: {
      shipping_logistic_type: listingLogisticType,
      listing_status: listingStatus,
      available_quantity: availableQty,
      marketplace_account_id: marketplaceAccountId,
      seller_id: sellerId,
    },
  });
  if (!fetched.ok || !fetched.json) return null;

  const salePriceDec = new Decimal(priceStr);
  const feeDec =
    officialFeeAmountBrl != null && String(officialFeeAmountBrl).trim() !== ""
      ? new Decimal(String(officialFeeAmountBrl).trim())
      : null;
  const lpLogDec =
    listingPricesLogisticsBrl != null && String(listingPricesLogisticsBrl).trim() !== ""
      ? new Decimal(String(listingPricesLogisticsBrl).trim())
      : null;
  const lpPayDec =
    listingPricesPayoutBrl != null && String(listingPricesPayoutBrl).trim() !== ""
      ? new Decimal(String(listingPricesPayoutBrl).trim())
      : null;

  const parsed = parseMercadoLivreItemShippingOptionsForScenario(fetched.json, listing, {
    salePriceDec,
    feeAmountDec: feeDec,
    listingPricesLogisticsDec: lpLogDec,
    listingPricesPayoutDec: lpPayDec,
  });

  console.info("[ml-shipping-raw]", {
    endpoint: "GET /items/{id}/shipping_options",
    listing_id: listingUuid ?? id,
    scenario_type: scenarioType,
    sale_price: priceStr,
    zip_code: zip,
    raw_fields: parsed?.raw_fields ?? null,
    pick_reason: parsed?.pick_reason ?? null,
    seller_shipping_cost_brl: parsed?.seller_shipping_cost_brl ?? null,
    buyer_shipping_context: parsed?.shipping_context ?? null,
  });

  if (parsed?.seller_shipping_cost_brl == null) return null;

  const candidate = new Decimal(parsed.seller_shipping_cost_brl);
  const rejectLow = !trustOfficialApi && isSuspiciousLowShipping(candidate, anchorDec);
  if (rejectLow) {
    console.info("[ml-shipping-resolver] item_shipping_options_rejected_low", {
      item_id: id,
      sale_price_brl: priceStr,
      candidate_brl: parsed.seller_shipping_cost_brl,
      parse_source: parsed.seller_shipping_cost_source ?? null,
      anchor_brl: anchorDec != null ? decStr2(anchorDec) : null,
    });
    return null;
  }

  console.info("[ml-official-shipping-resolver]", {
    listing_id: listingUuid,
    sale_price: priceStr,
    source: "ml_item_shipping_options_api",
    shipping_cost_brl: parsed.seller_shipping_cost_brl,
    buyer_shipping_context: parsed.shipping_context,
    raw_reference: parsed.seller_shipping_cost_source ?? null,
  });
  logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_SCENARIO_SHIPPING_RESOLVED, {
    marketplace: "mercado_livre",
    item_id: id,
    listing_id: listingUuid ?? null,
    external_listing_id: id,
    scenario_type: scenarioType,
    sale_price_brl: priceStr,
    source: "ml_item_shipping_options_api",
    shipping_option_id: parsed.option_id ?? null,
    is_shipping_estimated: false,
  });
  return {
    amount_brl: parsed.seller_shipping_cost_brl,
    source: `ml_item_shipping_options_api:${parsed.seller_shipping_cost_source ?? "unknown"}`,
    shipping_context: parsed.shipping_context,
    shipping_subsidy_amount_brl: parsed.shipping_subsidy_amount_brl,
    is_shipping_estimated: false,
  };
}

/**
 * @param {{
 *   accessToken: string | null | undefined;
 *   itemId: string | null | undefined;
 *   zipCode: string | null | undefined;
 *   scenarioSaleDec: Decimal;
 *   npRec: Record<string, unknown>;
 *   healthOriginal: Record<string, unknown> | null | undefined;
 *   listing: Record<string, unknown>;
 *   scenarioType: string;
 *   listingUuid?: string | null;
 *   preferItemShippingOptionsByPrice?: boolean;
 *   piFreteViaShippingOptionsFree?: boolean;
 *   piOfficialApiContext?: {
 *     categoryId?: string | null;
 *     listingTypeId?: string | null;
 *     currencyId?: string | null;
 *     logisticType?: string | null;
 *     shippingMode?: string | null;
 *     feeDebug?: Record<string, unknown> | null;
 *   } | null;
 *   officialFeeAmountBrl?: string | null;
 * }} p
 * @returns {Promise<MercadoLivreScenarioShippingResolution>}
 */
export async function resolveMercadoLivreScenarioShippingAsync(p) {
  const {
    accessToken,
    itemId,
    zipCode,
    scenarioSaleDec,
    npRec,
    healthOriginal,
    listing,
    scenarioType,
    listingUuid,
    preferItemShippingOptionsByPrice = false,
    piFreteViaShippingOptionsFree = false,
    piOfficialApiContext = null,
    officialFeeAmountBrl = null,
  } = p;

  const priceStr =
    scenarioSaleDec != null && scenarioSaleDec.isFinite() && scenarioSaleDec.gt(0)
      ? scenarioSaleDec.toDecimalPlaces(2, ROUND).toFixed(2)
      : null;

  const id = itemId != null ? String(itemId).trim() : "";
  const zip = zipCode != null ? String(zipCode).trim() : "";

  /** Âncora para rejeitar frete espúrio baixo (listing_prices ou GAP). */
  let anchorDec = null;
  /** @type {string | null} */
  let listingPricesLogisticsBrl = null;
  /** @type {string | null} */
  let listingPricesPayoutBrl = null;

  if (accessToken && id && priceStr) {
    const snap = await snapshotListingPricesPorPreco({
      accessToken,
      listing,
      priceStr,
      itemId: id,
      listingUuid: listingUuid ?? null,
      scenarioType,
    });
    if (snap != null) {
      listingPricesLogisticsBrl = snap.logistics_brl;
      listingPricesPayoutBrl = snap.payout_brl;
      if (snap.logistics_brl != null) {
        anchorDec = new Decimal(snap.logistics_brl);
      }
    }
  }

  // PI preço customizado: shipping_options/free (true + false) — não items/shipping_options.
  if (accessToken && id && priceStr && piFreteViaShippingOptionsFree) {
    const fromPiFree = await resolverFretePiShippingOptionsFreeDual({
      accessToken,
      listing,
      priceStr,
      itemId: id,
      listingUuid: listingUuid ?? null,
      scenarioType,
      categoryId: piOfficialApiContext?.categoryId ?? null,
      listingTypeId: piOfficialApiContext?.listingTypeId ?? null,
      currencyId: piOfficialApiContext?.currencyId ?? null,
      logisticType: piOfficialApiContext?.logisticType ?? null,
      shippingMode: piOfficialApiContext?.shippingMode ?? null,
      feeDebug: piOfficialApiContext?.feeDebug ?? null,
    });
    if (fromPiFree?.amount_brl != null) {
      return fromPiFree;
    }
    const ctxPiBlocked = inferMercadoLivreShippingContext(npRec, healthOriginal);
    console.info("[ml-official-shipping-resolver]", {
      listing_id: listingUuid ?? null,
      sale_price: priceStr,
      source: "pi_shipping_options_free_unresolved",
      shipping_cost_brl: null,
      buyer_shipping_context: ctxPiBlocked,
      raw_reference: fromPiFree?.source ?? "official_unresolved",
      warning: "Frete PI indisponível — shipping_options/free sem custo seller válido.",
    });
    return {
      amount_brl: null,
      source: "official_unresolved",
      shipping_context: ctxPiBlocked,
      shipping_subsidy_amount_brl: null,
      is_shipping_estimated: true,
      warning:
        "Frete oficial indisponível para este preço — verifique token/conta ML ou parâmetros do anúncio.",
    };
  }

  // PI / Raio-X oficial: shipping_options?price= com validação payout listing_prices.
  if (accessToken && id && zip && priceStr && preferItemShippingOptionsByPrice && !piFreteViaShippingOptionsFree) {
    const fromItem = await resolverFreteItemShippingOptionsPorPreco({
      accessToken,
      id,
      zip,
      priceStr,
      listing,
      listingUuid: listingUuid ?? null,
      scenarioType,
      anchorDec,
      trustOfficialApi: true,
      officialFeeAmountBrl,
      listingPricesLogisticsBrl,
      listingPricesPayoutBrl,
    });
    if (fromItem?.amount_brl != null) return fromItem;
  }

  if (accessToken && id && priceStr) {
    const fromListingPrices = await resolverFreteListingPricesPorPreco({
      accessToken,
      listing,
      priceStr,
      itemId: id,
      listingUuid: listingUuid ?? null,
      scenarioType,
    });
    if (fromListingPrices?.amount_brl != null) {
      anchorDec = new Decimal(fromListingPrices.amount_brl);
      if (!preferItemShippingOptionsByPrice) {
        return fromListingPrices;
      }
    }

    const fromFree = await resolverFreteShippingOptionsFree({
      accessToken,
      listing,
      priceStr,
      itemId: id,
      listingUuid: listingUuid ?? null,
      scenarioType,
    });
    if (fromFree?.amount_brl != null && !preferItemShippingOptionsByPrice) {
      if (anchorDec == null) anchorDec = new Decimal(fromFree.amount_brl);
      return fromFree;
    }
  }

  if (accessToken && id && zip && priceStr && !preferItemShippingOptionsByPrice) {
    const fromItem = await resolverFreteItemShippingOptionsPorPreco({
      accessToken,
      id,
      zip,
      priceStr,
      listing,
      listingUuid: listingUuid ?? null,
      scenarioType,
      anchorDec,
      trustOfficialApi: false,
    });
    if (fromItem?.amount_brl != null) return fromItem;
  }

  if (preferItemShippingOptionsByPrice && listingPricesLogisticsBrl != null && officialFeeAmountBrl != null && priceStr) {
    const fee = new Decimal(String(officialFeeAmountBrl).trim());
    const sale = new Decimal(priceStr);
    const ship = new Decimal(listingPricesLogisticsBrl);
    const payoutCalc = sale.minus(fee).minus(ship);
    const payoutOk =
      listingPricesPayoutBrl != null &&
      payoutCalc.minus(new Decimal(listingPricesPayoutBrl)).abs().lte(new Decimal("0.02"));
    if (payoutOk) {
      logOfficialShippingResolver({
        listing_id: listingUuid ?? null,
        sale_price: priceStr,
        source: "ml_listing_prices_logistics_validated",
        shipping_cost_brl: listingPricesLogisticsBrl,
        buyer_shipping_context: inferMercadoLivreShippingContext(npRec, healthOriginal),
        raw_reference: "listing_prices_logistics_payout_validated",
      });
      return {
        amount_brl: listingPricesLogisticsBrl,
        source: "ml_listing_prices_logistics_validated",
        shipping_context: inferMercadoLivreShippingContext(npRec, healthOriginal),
        shipping_subsidy_amount_brl: null,
        is_shipping_estimated: false,
        warning: null,
      };
    }
  }

  const sync = resolveMercadoLivreScenarioShipping({
    scenarioSaleDec,
    npRec,
    healthOriginal,
  });

  const isFallback =
    sync.source === "unresolved" ||
    sync.source === "health_column" ||
    sync.source === "ml_shipping_options_free_simulation" ||
    (typeof sync.source === "string" && sync.source.includes("simulation"));

  if (sync.source === "net_receivable_gap") {
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_SCENARIO_SHIPPING_FALLBACK_NET_PROCEEDS, {
      marketplace: "mercado_livre",
      item_id: id || null,
      listing_id: listingUuid ?? null,
      scenario_type: scenarioType,
      sale_price_brl: priceStr,
      source: sync.source,
    });
  } else if (isFallback) {
    logPricingEvent(PRICING_LOG_LEVEL.INFO, PRICING_EVENT_CODE.ML_SCENARIO_SHIPPING_ESTIMATED, {
      marketplace: "mercado_livre",
      item_id: id || null,
      listing_id: listingUuid ?? null,
      scenario_type: scenarioType,
      sale_price_brl: priceStr,
      source: sync.source,
    });
  }

  const ctxFallback = inferMercadoLivreShippingContext(npRec, healthOriginal);

  if (preferItemShippingOptionsByPrice || piFreteViaShippingOptionsFree) {
    console.info("[ml-official-shipping-resolver]", {
      listing_id: listingUuid ?? null,
      sale_price: priceStr,
      source: "fallback_blocked",
      shipping_cost_brl: null,
      buyer_shipping_context: ctxFallback,
      raw_reference: sync.source,
      warning: "Frete oficial indisponível — health stale bloqueado em modo PI/Raio-X oficial.",
    });
    return {
      amount_brl: null,
      source: "official_unresolved",
      shipping_context: ctxFallback,
      shipping_subsidy_amount_brl: null,
      is_shipping_estimated: true,
      warning:
        "Frete oficial indisponível para este preço — sincronize o anúncio ou verifique token/conta ML.",
    };
  }

  console.info("[ml-official-shipping-resolver]", {
    listing_id: listingUuid ?? null,
    sale_price: priceStr,
    source: isFallback ? "fallback" : sync.source,
    shipping_cost_brl: sync.amount_brl,
    buyer_shipping_context: ctxFallback,
    raw_reference: sync.source,
  });

  return {
    amount_brl: sync.amount_brl,
    source: sync.source,
    shipping_context: ctxFallback,
    shipping_subsidy_amount_brl: null,
    is_shipping_estimated: isFallback,
    warning: isFallback
      ? "Frete via fallback — sincronize o anúncio ou verifique token/conta ML."
      : null,
  };
}
