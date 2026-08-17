// ======================================================================
// Testes unitários — SSOT promoções ML (original − final_price oficial)
// ======================================================================

import assert from "node:assert/strict";
import Decimal from "decimal.js";
import {
  buildCanonicalPromotionOfferContract,
  buildStructuralAnonymousPriceDenylist,
  buildPromotionCardContract,
  buildLiquidaFullOutletCaseAuditPayload,
  buildOfficialSellerPromotionListDedupeKey,
  buildPromotionFinancialSsotFields,
  buildPromotionScenarioSsotAuditPayload,
  mergeEnrichedOfficialSellerPromotionRow,
  normalizeOfficialSellerPromotionsFromApi,
  promotionRowNeedsPriceEnrichment,
  pickOfficialPromotionFinalPrice,
  resolveOfficialSellerPromotionFinancials,
  resolvePromotionUiFinancials,
  tipoIndicaRelampagoPromocao,
  isBoostedOfferTruthy,
  isStructuralAnonymousPriceDiscountRow,
} from "../src/domain/pricing/mercadoLivreOfficialSellerPromotions.js";
import {
  buildListingVariationContextForPromotions,
  listingHasMultipleVariations,
} from "../src/domain/pricing/mercadoLivrePromotionVariationRangeAudit.js";
import { applyMercadoLivreMlPanelCurrencyRounding } from "../src/domain/pricing/strategies/mercadoLivrePromotionPanelParityResolver.js";
import {
  buildPromotionLivePayloadMeta,
  evaluateModalOpenPromotionFreshnessGuard,
  PROMOTION_LIVE_PAYLOAD_TTL_MS,
} from "../src/domain/pricing/mercadoLivrePromotionLivePayloadAudit.js";
import { extractSellerPromotionRowsFromItemPromotionsJson } from "../src/handlers/ml/_helpers/mercadoLibreItemsApi.js";

function testBuildListingVariationContextFromRawJsonVariations() {
  const listing = {
    variations_count: 0,
    raw_json: {
      variations: [{ id: 1 }, { id: 2 }, { id: 3 }],
    },
  };
  const ctx = buildListingVariationContextForPromotions(listing);
  assert.equal(ctx.variations_count, 3);
  assert.equal(ctx.has_listing_variations, true);
  assert.equal(ctx.listingContext_source, "raw_json.variations.length");
  assert.equal(ctx.raw_variations_length, 3);
  assert.equal(listingHasMultipleVariations(ctx), true);
}

function testBuildListingVariationContextFallbackVariationsCount() {
  const listing = { variations_count: 4, raw_json: {} };
  const ctx = buildListingVariationContextForPromotions(listing);
  assert.equal(ctx.variations_count, 4);
  assert.equal(ctx.has_listing_variations, true);
  assert.equal(ctx.listingContext_source, "variations_count");
}

function testBuildListingVariationContextSemEvidenciaNaoInventa() {
  const ctx = buildListingVariationContextForPromotions({ variations_count: 0, raw_json: {} });
  assert.equal(ctx.variations_count, null);
  assert.equal(ctx.has_listing_variations, false);
  assert.equal(ctx.listingContext_source, null);
}

function testNormalizeOfficialPromotionsPropagaListingContextVariacao() {
  const rawRows = [
    {
      id: "P-MLB17625056",
      type: "SMART",
      name: "Aumente suas vendas",
      status: "candidate",
      original_price: 98.6,
      price: 78,
      seller_percentage: 18.8,
      meli_percentage: 2.1,
    },
  ];
  const listingContext = buildListingVariationContextForPromotions({
    variations_count: 0,
    raw_json: { variations: [{ id: 1 }, { id: 2 }, { id: 3 }] },
  });
  const pack = normalizeOfficialSellerPromotionsFromApi(rawRows, {
    listingId: "MLB4578041035",
    listingContext,
  });
  assert.equal(pack.promotions[0].financials.seller_discount_amount_brl, "18.54");
}

function testBoostedOfferBooleanTrueRelampagoCase3() {
  const row = {
    id: "LIGHT",
    name: "Oferta relâmpago",
    status: "candidate",
    original_price: 299.9,
    price: 264.96,
    boosted_offer: true,
    total_price_for_boosted_offer: 252.36,
    seller_percentage: 12,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "252.36");
  assert.equal(ui.final_price_source, "total_price_for_boosted_offer");
  assert.equal(ui.discount_amount_brl, "47.54");
  assert.equal(ui.discount_percent_display, "16");
}

function testBoostedOfferStringTrue() {
  const row = {
    original_price: 299.9,
    price: 264.96,
    boosted_offer: "true",
    total_price_for_boosted_offer: 252.36,
    status: "candidate",
  };
  assert.equal(isBoostedOfferTruthy(row), true);
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "252.36");
  assert.equal(ui.discount_percent_display, "16");
}

function testLightningSemBoostedFlagUsaTotalPriceForBoostedOffer() {
  const row = {
    type: "LIGHTNING",
    status: "candidate",
    original_price: 299.9,
    price: 269.91,
    total_price_for_boosted_offer: 252.36,
    seller_percentage: 10,
  };
  assert.equal(tipoIndicaRelampagoPromocao("LIGHTNING"), true);
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "252.36");
  assert.equal(ui.final_price_source, "total_price_for_boosted_offer");
  assert.equal(ui.discount_percent_display, "16");
}

function testCandidateTopOfertaEnrichmentPriceNaoMax() {
  const base = {
    id: "TOP",
    name: "Top Oferta Papelaria",
    status: "candidate",
    original_price: 78.6,
    price: 67.6,
    max_discounted_price: 75.64,
    seller_percentage: 14,
  };
  assert.equal(promotionRowNeedsPriceEnrichment(base), true);
  const enriched = mergeEnrichedOfficialSellerPromotionRow(base, {
    price: 75.64,
    original_price: 78.6,
  });
  const ui = resolvePromotionUiFinancials(enriched);
  assert.equal(ui.final_price_brl, "75.64");
  assert.equal(ui.final_price_source, "price");
  assert.equal(ui.discount_percent_display, "4");
}

function testCandidateSellerPercentage14PriceCorretoGera4() {
  const row = {
    status: "candidate",
    original_price: 78.6,
    price: 75.64,
    seller_percentage: 14,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.discount_percent_display, "4");
}

function testCandidateLiquidaIgnoraMaxDiscountedUsaPrice() {
  const row = {
    status: "candidate",
    original_price: 299.9,
    price: 231,
    max_discounted_price: 269.91,
    seller_percentage: 10,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "231.00");
  assert.equal(ui.final_price_source, "price");
  assert.equal(ui.discount_percent_display, "23");
}

function testStartedUsaPriceNaoMaxDiscounted() {
  const row = {
    status: "started",
    original_price: 78.6,
    price: 76.24,
    max_discounted_price: 75.64,
  };
  const picked = pickOfficialPromotionFinalPrice(row);
  assert.equal(picked.finalPriceSource, "price");
  assert.equal(picked.finalPriceDec?.toFixed(2), "76.24");
}

function testPriceZeroNaoUsaSellerPercentage() {
  const row = {
    status: "candidate",
    original_price: 78.6,
    price: 0,
    seller_percentage: 23,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.discount_percent_display, null);
  assert.equal(ui.source_confidence, "missing_price_fields");
  assert.ok(ui.source_warnings.includes("missing_original_or_final_price"));
}

function testCandidateSuggestedQuandoPriceZero() {
  const row = {
    status: "candidate",
    original_price: 78.6,
    price: 0,
    suggested_discounted_price: 74.67,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "74.67");
  assert.equal(ui.discount_percent_display, "5");
}

function testCase2OfertaRelampagoPreco6039() {
  const row = {
    type: "LIGHTNING",
    status: "candidate",
    original_price: 78.6,
    price: 60.39,
    seller_percentage: 22,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.discount_amount_brl, "18.21");
  // ML UI pode exibir 24%; matematicamente (78.60 − 60.39) / 78.60 ≈ 23,17% → arredonda 23
  assert.equal(ui.discount_percent_display, "23");
}

function testContratoCanonicoFestivalEnrichedPrice() {
  const raw = {
    id: "PROMO",
    type: "DEAL",
    name: "Festival Casa Nova",
    status: "candidate",
    original_price: 299.9,
    price: 254.91,
    max_discounted_price: 269.91,
  };
  const normalized = normalizeOfficialSellerPromotionsFromApi([raw], { source: "live" });
  const pr = normalized.promotions[0];
  const fin = resolveOfficialSellerPromotionFinancials(raw, pr.final_price_brl, null);
  const contract = buildCanonicalPromotionOfferContract({
    promotionRow: raw,
    normalizedPromotion: pr,
    financials: fin,
  });
  assert.equal(contract.discount_percent_display, "15");
  assert.equal(fin.seller_discount_percent_display, contract.discount_percent_display);
  assert.equal(fin.seller_discount_amount_brl, contract.discount_amount_brl);
}

function testMissaoMLB6086602390FestivalCasaNovaSuggestedEqualsMaxSemPriceGap() {
  const row = {
    status: "candidate",
    original_price: 299.9,
    price: 254.91,
    max_discounted_price: 254.91,
    suggested_discounted_price: 254.91,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "254.91");
  assert.equal(ui.final_price_source, "suggested_discounted_price");
  assert.equal(ui.discount_amount_brl, "44.99");
  assert.equal(ui.discount_percent_display, "15");
}

function testMissaoMLB6086602390Descontaco0707() {
  const row = { status: "candidate", original_price: 299.9, price: 270.54, max_discounted_price: 299.9 };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "270.54");
  assert.equal(ui.discount_amount_brl, "29.36");
  assert.equal(ui.discount_percent_display, "10");
}

function testMissaoMLB6086602390SuperOfertaCasa() {
  const row = { status: "candidate", original_price: 299.9, price: 239.92, max_discounted_price: 269.91 };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "239.92");
  assert.equal(ui.discount_amount_brl, "59.98");
  assert.equal(ui.discount_percent_display, "20");
}

function testMissaoMLB6086602390AumenteSuasVendas() {
  const row = { status: "candidate", original_price: 299.9, price: 231, max_discounted_price: 269.91 };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "231.00");
  assert.equal(ui.discount_amount_brl, "68.90");
  assert.equal(ui.discount_percent_display, "23");
}

function testMissaoMLB6086602390VendaCasaDecor() {
  const row = {
    status: "candidate",
    original_price: 299.9,
    price: 231,
    max_discounted_price: 269.91,
    name: "Venda Casa e Decor",
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "231.00");
  assert.equal(ui.discount_amount_brl, "68.90");
  assert.equal(ui.discount_percent_display, "23");
}

function testMergeEnrichedPreservaSuggestedMaxDaListagem() {
  const base = {
    id: "FEST",
    status: "candidate",
    original_price: 299.9,
    price: 245.92,
    max_discounted_price: 254.91,
    suggested_discounted_price: 254.91,
  };
  const enriched = { price: 245.92, original_price: 299.9 };
  const merged = mergeEnrichedOfficialSellerPromotionRow(base, enriched);
  assert.equal(merged.suggested_discounted_price, 254.91);
  assert.equal(merged.max_discounted_price, 254.91);
  const ui = resolvePromotionUiFinancials(merged);
  assert.equal(ui.final_price_brl, "254.91");
  assert.equal(ui.discount_percent_display, "15");
}

function testMergeEnrichedPreservaPriceListagemQuandoEnrichmentZeraLiquida() {
  const base = {
    id: "P-MLB17759006",
    name: "Liquida Full - Outlet",
    type: "DEAL",
    status: "candidate",
    original_price: 199.9,
    price: 164.8,
    suggested_discounted_price: 164.8,
    max_discounted_price: 189.9,
  };
  const enriched = {
    price: 0,
    suggested_discounted_price: 164.8,
    original_price: 199.9,
  };
  const merged = mergeEnrichedOfficialSellerPromotionRow(base, enriched);
  assert.equal(merged.price, 164.8);
  assert.equal(merged.max_discounted_price, 189.9);
  const ui = resolvePromotionUiFinancials(merged, {
    sameListingOtherPromotionPrices: ["164.80"],
    skipLiquidaCaseAudit: true,
  });
  assert.equal(ui.final_price_brl, "189.90");
  assert.equal(ui.final_price_source, "max_discounted_price");
}

function testMissaoMLB6086602390FestivalSemSuggestedUsaMaxAmbiguo() {
  const row = {
    status: "candidate",
    original_price: 299.9,
    price: 245.92,
    max_discounted_price: 254.91,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "254.91");
  assert.equal(ui.final_price_source, "max_discounted_price");
  assert.equal(ui.discount_percent_display, "15");
}

function testFinancialSsotSuperOfertaCasaFeeReduction() {
  const row = {
    status: "candidate",
    original_price: 299.9,
    price: 239.92,
    discount_meli_boost_amount: 14.99,
  };
  const ssot = buildPromotionFinancialSsotFields({
    rawRow: row,
    grossFeeBrl: "32.39",
    freightCostBrl: "49.35",
    feeRatePercent: "13.50",
  });
  assert.equal(ssot.buyer_final_price_brl, "239.92");
  assert.equal(ssot.marketplace_fee_gross_brl, "32.39");
  assert.equal(ssot.marketplace_fee_reduction_brl, "14.99");
  assert.equal(ssot.marketplace_fee_net_brl, "17.40");
  assert.equal(ssot.seller_receives_brl, "173.17");
}

function testFinancialSsotLiquidaSemReducaoTarifa() {
  const row = { status: "candidate", original_price: 299.9, price: 231 };
  const ssot = buildPromotionFinancialSsotFields({
    rawRow: row,
    grossFeeBrl: "31.18",
    freightCostBrl: "49.35",
  });
  assert.equal(ssot.marketplace_fee_reduction_brl, "0.00");
  assert.equal(ssot.marketplace_fee_net_brl, "31.18");
  assert.equal(ssot.seller_receives_brl, "150.47");
}

function testMergeEnrichedPreservaIdentidade() {
  const base = { id: "P-1", type: "DEAL", name: "Base", status: "candidate", price: 0 };
  const enriched = { id: "OTHER", price: 76.24, original_price: 78.6 };
  const merged = mergeEnrichedOfficialSellerPromotionRow(base, enriched);
  assert.equal(merged.id, "P-1");
  assert.equal(merged.price, 76.24);
  assert.equal(merged.original_price, 78.6);
  assert.equal(merged._suse7_price_enriched, true);
}

// —— Cases de aceite missão final ——

function testMissaoMLB6086602390LiquidaFull() {
  const row = { status: "candidate", original_price: 299.9, price: 231, max_discounted_price: 269.91 };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "231.00");
  assert.equal(ui.discount_percent_display, "23");
}

function testMissaoMLB6086602390FestivalCasaNova() {
  const row = { status: "candidate", original_price: 299.9, price: 254.91, max_discounted_price: 245.92 };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "254.91");
  assert.equal(ui.discount_percent_display, "15");
}

function testMissaoMLB6086602390FestivalCasaNovaRawListagemAmbigua() {
  const row = {
    id: "FESTIVAL",
    name: "Festival Casa Nova",
    status: "candidate",
    original_price: 299.9,
    price: 245.92,
    max_discounted_price: 254.91,
    suggested_discounted_price: 254.91,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "254.91");
  assert.equal(ui.final_price_source, "suggested_discounted_price");
  assert.equal(ui.discount_amount_brl, "44.99");
  assert.equal(ui.discount_percent_display, "15");
  const contract = buildCanonicalPromotionOfferContract({
    promotionRow: row,
    normalizedPromotion: { promotion_id: "FESTIVAL", promotion_name: "Festival Casa Nova", promotion_type: "DEAL" },
    financials: resolveOfficialSellerPromotionFinancials(row, ui.final_price_brl, "299.90"),
  });
  assert.equal(contract.discount_percent_display, "15");
  assert.equal(contract.final_price_brl, "254.91");
}

function testMissaoMLB6086602390OfertaRelampago() {
  const row = {
    type: "LIGHTNING",
    status: "candidate",
    original_price: 279.9,
    price: 264.96,
    max_discounted_price: 251.9,
    suggested_discounted_price: 237.92,
    min_discounted_price: 83.97,
    _suse7_list_min_discounted_price: 55.98,
    _suse7_price_enriched: true,
  };
  const ui = resolvePromotionUiFinancials(row, { listingId: "MLB6086602390" });
  assert.equal(ui.final_price_brl, "252.36");
  assert.equal(ui.discount_amount_brl, "27.54");
  assert.equal(ui.discount_percent_display, "10");
  assert.equal(ui.panel_parity?.selected_rule, "panel:lightning_modest_official_tier");
}

function testPanelParityMLB5742272490OfertaRelampagoModestTier() {
  const row = {
    id: "LGH-MLB1000",
    type: "LIGHTNING",
    status: "candidate",
    original_price: 338.6,
    price: 289.5,
    max_discounted_price: 304.74,
    suggested_discounted_price: 287.81,
    min_discounted_price: 101.58,
    _suse7_list_min_discounted_price: 67.72,
    _suse7_price_enriched: true,
  };
  const ui = resolvePromotionUiFinancials(row, { listingId: "MLB5742272490" });
  assert.equal(ui.final_price_brl, "286.60");
  assert.equal(ui.discount_amount_brl, "52.00");
  assert.equal(ui.discount_percent_display, "16");
  assert.equal(ui.panel_parity?.selected_rule, "panel:lightning_modest_official_tier");
  assert.equal(ui.panel_parity?.selected_source_path, "suggested_discounted_price");
}

function testPanelParityMLB4578041035AumenteSellerDiscountSsot() {
  const row = {
    id: "P-MLB17625056",
    type: "SMART",
    name: "Aumente suas vendas",
    status: "candidate",
    original_price: 98.6,
    price: 78,
    seller_percentage: 18.8,
    meli_percentage: 2.1,
    _suse7_price_enriched: true,
  };
  const ui = resolvePromotionUiFinancials(row, {
    listingId: "MLB4578041035",
    listingContext: { variations_count: 3 },
  });
  assert.equal(ui.final_price_brl, "78.00");
  assert.equal(ui.discount_amount_brl, "18.54");
}

function testPanelParityOfficialDiscountAmountPrevailsOverComputed() {
  const row = {
    type: "SMART",
    name: "Promo teste faixa",
    status: "candidate",
    original_price: 98.6,
    price: 78,
    discount_amount: 18.54,
  };
  const ui = resolvePromotionUiFinancials(row, { listingId: "MLB4578041035" });
  assert.equal(ui.final_price_brl, "78.00");
  assert.equal(ui.discount_amount_brl, "18.54");
}

function testPanelParityMLB4578041035NormalizeMissingImpulsioneAudit() {
  const rawRows = [
    { id: "P-MLB17625056", name: "Aumente suas vendas", type: "SMART", status: "candidate", price: 78, original_price: 98.6 },
    { id: "P-MLB17695018", name: "Festival Casa Nova", type: "SMART", status: "candidate", price: 87.44, original_price: 98.6 },
    { id: "P-MLB17755360", name: "Venda Casa e Decor", type: "SMART", status: "candidate", price: 78, original_price: 98.6 },
    { id: "P-MLB17765096", name: "7/7 SUPER Oferta CASA", type: "SMART", status: "candidate", price: 78.88, original_price: 98.6 },
    { name: "", type: "PRICE_DISCOUNT", status: "candidate", price: 0, original_price: 98.6 },
    { id: "P-MLB17489058", name: "07.07 e Descontaco", type: "DEAL", status: "candidate", price: 0, original_price: 98.6 },
  ];
  const pack = normalizeOfficialSellerPromotionsFromApi(rawRows, { listingId: "MLB4578041035" });
  assert.equal(pack.normalized_total, 5);
  assert.equal(
    pack.promotions.some((p) => String(p.promotion_name).toLowerCase().includes("impulsione")),
    false
  );
}

function testMissaoMLB6487881250TopOfertaPapelaria() {
  const deal0707 = {
    id: "P-MLB17489058",
    type: "DEAL",
    name: "07.07 e Descontaco",
    status: "candidate",
    original_price: 78.9,
    price: 0,
    max_discounted_price: 65.05,
    suggested_discounted_price: 57.16,
  };
  const topOferta = {
    id: "P-MLB17639246",
    type: "SMART",
    name: "Top Oferta Papelaria",
    status: "candidate",
    original_price: 78.9,
    price: 53.8,
    seller_percentage: 27.7,
    meli_percentage: 4.1,
  };
  const ui = resolvePromotionUiFinancials(topOferta, {
    sameListingSiblingRows: [deal0707, topOferta],
    listingId: "MLB6487881250",
  });
  assert.equal(ui.final_price_brl, "65.05");
  assert.equal(ui.final_price_source, "sibling_deal_max_discounted_price");
  assert.equal(ui.discount_amount_brl, "13.85");
  assert.equal(ui.discount_percent_display, "18");
}

function testMissaoMLB3734084847LiquidaFullOutlet() {
  const descontaco = {
    id: "P-MLB17489058",
    type: "DEAL",
    name: "07.07 e Descontaco",
    status: "started",
    original_price: 145,
    price: 115.99,
  };
  const liquida = {
    id: "P-MLB17759006",
    type: "DEAL",
    name: "Liquida Full - Outlet",
    status: "candidate",
    original_price: 145,
    price: 0,
    min_discounted_price: 58,
    max_discounted_price: 137.75,
    suggested_discounted_price: 115.99,
  };
  const ui = resolvePromotionUiFinancials(liquida, {
    sameListingOtherPromotionPrices: ["115.99"],
    sameListingSiblingRows: [descontaco, liquida],
    listingId: "MLB3734084847",
    skipLiquidaCaseAudit: true,
  });
  assert.equal(ui.final_price_brl, "115.99");
  assert.equal(ui.final_price_source, "suggested_discounted_price");
  assert.equal(ui.discount_amount_brl, "29.01");
  assert.equal(ui.discount_percent_display, "20");
}

function testMissaoMLB6415546858OfertaRelampagoTopDealPrice() {
  const row = {
    type: "LIGHTNING",
    status: "candidate",
    original_price: 78.6,
    price: 61.04,
    top_deal_price: 60.39,
    max_discounted_price: 70.74,
    suggested_discounted_price: 66.81,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "60.39");
  assert.equal(ui.final_price_source, "top_deal_price");
  assert.equal(ui.discount_amount_brl, "18.21");
  assert.equal(ui.discount_percent_display, "23");
}

function testMissaoMLB6415546858OfertaRelampago() {
  const row = { type: "LIGHTNING", status: "candidate", original_price: 78.6, price: 60.39 };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "60.39");
  assert.equal(ui.discount_percent_display, "23");
}

function testMissaoMLB6415546858LiquidaFull() {
  const row = { status: "candidate", original_price: 78.6, price: 61, max_discounted_price: 74.67 };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "61.00");
  // (78.60 − 61.00) / 78.60 ≈ 22,39% → arredonda 22; UI ML pode exibir 23% (mesma regra do relâmpago case 2)
  assert.equal(ui.discount_percent_display, "22");
}

function testMissaoMLB6415478372TopOfertaPapelaria() {
  const row = { status: "candidate", original_price: 78.6, price: 75.64, max_discounted_price: 67.6, seller_percentage: 14 };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "75.64");
  assert.equal(ui.discount_percent_display, "4");
}

function testMissaoMLB6415478372OfertaRelampago() {
  const row = { type: "LIGHTNING", status: "candidate", original_price: 78.6, price: 64.53 };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "64.53");
  assert.equal(ui.discount_percent_display, "18");
}

function testPromotionCardContractFestivalCasaNova() {
  const row = {
    id: "FESTIVAL",
    name: "Festival Casa Nova",
    type: "DEAL",
    status: "candidate",
    original_price: 299.9,
    price: 245.92,
    max_discounted_price: 254.91,
    suggested_discounted_price: 254.91,
  };
  const card = buildPromotionCardContract({
    listingExternalId: "MLB6086602390",
    marketplaceAccountId: "acc-test",
    promotionRow: row,
    normalizedPromotion: {
      promotion_id: "FESTIVAL",
      promotion_name: "Festival Casa Nova",
      promotion_type: "DEAL",
    },
  });
  assert.equal(card.listing_id, "MLB6086602390");
  assert.equal(card.promotion_name, "Festival Casa Nova");
  assert.equal(card.original_price_brl, "299.90");
  assert.equal(card.real_promotion_final_price_brl, "254.91");
  assert.equal(card.final_price_source, "suggested_discounted_price");
  assert.equal(card.discount_amount_brl, "44.99");
  assert.equal(card.discount_percent_display, "15");
  assert.equal(card.source_fields?.suggested_discounted_price_raw, 254.91);
}

function testPromotionCardContractTodosCasesMLB6086602390() {
  const cases = [
    { name: "07.07 e Descontaço", price: "270.54", pct: "10", disc: "29.36" },
    { name: "7/7 SUPER Oferta CASA", price: "239.92", pct: "20", disc: "59.98" },
    { name: "Aumente suas vendas", price: "231.00", pct: "23", disc: "68.90" },
    { name: "Venda Casa e Decor", price: "231.00", pct: "23", disc: "68.90" },
    { name: "Liquida Full - Outlet", price: "231.00", pct: "23", disc: "68.90", suggested: null },
  ];
  for (const c of cases) {
    const row = {
      name: c.name,
      status: "candidate",
      original_price: 299.9,
      price: Number(c.price),
      max_discounted_price: Number(c.price),
      suggested_discounted_price: c.suggested === null ? undefined : Number(c.price),
    };
    const card = buildPromotionCardContract({
      listingExternalId: "MLB6086602390",
      promotionRow: row,
      normalizedPromotion: { promotion_name: c.name },
    });
    assert.equal(card.real_promotion_final_price_brl, c.price, `${c.name} final`);
    assert.equal(card.discount_percent_display, c.pct, `${c.name} pct`);
    assert.equal(card.discount_amount_brl, c.disc, `${c.name} disc`);
  }
}

function testExtractSellerPromotionRowsPaginado() {
  const page1 = {
    results: [
      { id: "P1", type: "DEAL", name: "07.07 e Descontaço", status: "candidate", price: 64.01 },
      { id: "P2", type: "DEAL", name: "Top Oferta Construcao", status: "candidate", price: 53.29 },
    ],
    paging: { total: 4, limit: 2, offset: 0 },
  };
  const parsed1 = extractSellerPromotionRowsFromItemPromotionsJson(page1);
  assert.equal(parsed1.rows.length, 2);
  assert.equal(parsed1.paging?.total, 4);

  const page2 = {
    results: [
      { id: "P3", type: "SMART", ref_id: "OFFER-SMART", name: "Aumente suas vendas", status: "candidate", price: 56 },
      { id: "P4", type: "UNHEALTHY_STOCK", ref_id: "OFFER-LIQ", name: "Liquida Full - Outlet", status: "candidate", price: 56 },
    ],
    paging: { total: 4, limit: 2, offset: 2 },
  };
  const parsed2 = extractSellerPromotionRowsFromItemPromotionsJson(page2);
  assert.equal(parsed2.rows.length, 2);
}

function testNormalizeListaCompletaMLB6784329822() {
  const promos = [
    {
      id: "P-0707",
      type: "DEAL",
      name: "07.07 e Descontaço",
      status: "candidate",
      original_price: 74.99,
      price: 64.01,
      max_discounted_price: 64.01,
      suggested_discounted_price: 64.01,
    },
    {
      id: "P-TOP",
      type: "DEAL",
      name: "Top Oferta Construcao",
      status: "candidate",
      original_price: 74.99,
      price: 53.29,
      max_discounted_price: 53.29,
      suggested_discounted_price: 53.29,
    },
    {
      id: "P-SMART",
      type: "SMART",
      ref_id: "OFFER-SMART",
      name: "Aumente suas vendas",
      status: "candidate",
      original_price: 74.99,
      price: 56,
    },
    {
      id: "P-LIQ",
      type: "UNHEALTHY_STOCK",
      ref_id: "OFFER-LIQ",
      name: "Liquida Full - Outlet",
      status: "candidate",
      original_price: 74.99,
      price: 56,
    },
  ];
  const normalized = normalizeOfficialSellerPromotionsFromApi(promos, { source: "live" });
  assert.equal(normalized.normalized_total, 4);
  const cards = promos.map((row) =>
    buildPromotionCardContract({
      listingExternalId: "MLB6784329822",
      promotionRow: row,
      normalizedPromotion: { promotion_name: row.name, promotion_type: row.type, promotion_id: row.id },
    })
  );
  assert.equal(cards[0].real_promotion_final_price_brl, "64.01");
  assert.equal(cards[1].real_promotion_final_price_brl, "53.29");
  assert.equal(cards[2].real_promotion_final_price_brl, "56.00");
  assert.equal(cards[3].real_promotion_final_price_brl, "56.00");
  assert.equal(cards[0].discount_percent_display, "15");
  assert.equal(cards[1].discount_percent_display, "29");
}

function testListaDedupeKeyPreservaMesmoPrecoNomesDiferentes() {
  const a = { id: "A", type: "SMART", ref_id: "R1", name: "Aumente suas vendas", price: 56 };
  const b = { id: "B", type: "UNHEALTHY_STOCK", ref_id: "R2", name: "Liquida Full - Outlet", price: 56 };
  assert.notEqual(buildOfficialSellerPromotionListDedupeKey(a), buildOfficialSellerPromotionListDedupeKey(b));
  const normalized = normalizeOfficialSellerPromotionsFromApi([a, b], { source: "live" });
  assert.equal(normalized.normalized_total, 2);
}

function testMissaoMLB6784329822Descontaco0707SemContaminacao() {
  const anonymous = {
    type: "PRICE_DISCOUNT",
    status: "candidate",
    original_price: 74.99,
    price: 0,
    suggested_discounted_price: 56,
    max_discounted_price: 71.24,
  };
  const row = {
    id: "P-MLB17489058",
    type: "DEAL",
    name: "07.07 e Descontaco",
    status: "candidate",
    original_price: 74.99,
    price: 0,
    min_discounted_price: 15,
    max_discounted_price: 64.01,
    suggested_discounted_price: 56.51,
  };
  const denylist = buildStructuralAnonymousPriceDenylist([anonymous, row]);
  const ui = resolvePromotionUiFinancials(row, { structuralAnonymousPriceDenylist: denylist });
  assert.equal(ui.final_price_brl, "64.01");
  assert.equal(ui.final_price_source, "max_discounted_price");
  assert.equal(ui.discount_amount_brl, "10.98");
  assert.equal(ui.discount_percent_display, "15");
  const card = buildPromotionCardContract({
    listingExternalId: "MLB6784329822",
    promotionRow: row,
    structuralAnonymousPriceDenylist: denylist,
  });
  assert.equal(card.real_promotion_final_price_brl, "64.01");
  assert.equal(card.source_identity_key.includes("07.07 e Descontaco"), true);
}

function testMissaoMLB6784329822LiquidaFullSemRegressaoContaminacao() {
  const anonymous = {
    type: "PRICE_DISCOUNT",
    status: "candidate",
    original_price: 74.99,
    suggested_discounted_price: 56,
    max_discounted_price: 71.24,
  };
  const row = {
    id: "P-MLB17759006",
    type: "DEAL",
    name: "Liquida Full - Outlet",
    status: "candidate",
    original_price: 74.99,
    price: 0,
    suggested_discounted_price: 56,
    max_discounted_price: 71.24,
  };
  const denylist = buildStructuralAnonymousPriceDenylist([anonymous, row]);
  const ui = resolvePromotionUiFinancials(row, { structuralAnonymousPriceDenylist: denylist });
  assert.equal(ui.final_price_brl, "56.00");
  assert.equal(ui.discount_amount_brl, "18.99");
}

function testMissaoMLB6248404078LiquidaFullOutletSemHerancaCrossPromo() {
  const campingRow = {
    id: "P-CAMP",
    type: "DEAL",
    name: "Camping e Pesca Junho",
    status: "candidate",
    original_price: 199.9,
    price: 164.8,
    suggested_discounted_price: 164.8,
  };
  const rowListagem = {
    id: "P-MLB17759006",
    type: "DEAL",
    name: "Liquida Full - Outlet",
    status: "candidate",
    original_price: 199.9,
    price: 0,
    suggested_discounted_price: 164.8,
    max_discounted_price: 189.9,
  };
  const rowEnrichedPrice = {
    ...rowListagem,
    price: 164.8,
  };
  for (const row of [rowListagem, rowEnrichedPrice]) {
    const picked = pickOfficialPromotionFinalPrice(row, {
      sameListingOtherPromotionPrices: ["164.80"],
    });
    assert.equal(picked.finalPriceSource, "max_discounted_price", row === rowListagem ? "listagem" : "enriched");
    assert.equal(picked.finalPriceDec?.toFixed(2), "189.90", row === rowListagem ? "listagem" : "enriched");
  }
  const picked = pickOfficialPromotionFinalPrice(rowListagem, {
    sameListingOtherPromotionPrices: ["164.80"],
  });

  const ui = resolvePromotionUiFinancials(rowListagem, {
    sameListingOtherPromotionPrices: ["164.80"],
    listingId: "MLB6248404078",
  });
  assert.equal(ui.final_price_brl, "189.90");
  assert.equal(ui.final_price_source, "max_discounted_price");
  assert.equal(ui.discount_amount_brl, "10.00");
  assert.equal(ui.discount_percent_display, "5");

  const card = buildPromotionCardContract({
    listingExternalId: "MLB6248404078",
    promotionRow: rowListagem,
    sameListingPromotionRows: [campingRow, rowListagem],
  });
  assert.equal(card.real_promotion_final_price_brl, "189.90");
  assert.equal(card.discount_amount_brl, "10.00");
  assert.equal(card.discount_percent_display, "5");

  const audit = buildLiquidaFullOutletCaseAuditPayload(
    rowListagem,
    { finalPriceDec: picked.finalPriceDec, finalPriceSource: picked.finalPriceSource },
    { listingId: "MLB6248404078", sameListingOtherPromotionPrices: ["164.80"] }
  );
  assert.equal(audit.picked_final_price_brl, "189.90");
  assert.equal(audit.picked_final_price_source, "max_discounted_price");
  assert.equal(audit.contaminated_by_other_promotion, true);
  assert.ok(Array.isArray(audit.rejected_candidate_prices));
  assert.ok(audit.rejected_candidate_prices.some((c) => c.price_brl === "164.80"));
}

function testMissaoMLB6248404078LiquidaFullOutletNormalizeComContextoListing() {
  const campingRow = {
    id: "P-CAMP",
    type: "DEAL",
    name: "Camping e Pesca Junho",
    status: "candidate",
    original_price: 199.9,
    price: 164.8,
    suggested_discounted_price: 164.8,
  };
  const row = {
    id: "P-MLB17759006",
    type: "DEAL",
    name: "Liquida Full - Outlet",
    status: "candidate",
    original_price: 199.9,
    price: 0,
    suggested_discounted_price: 164.8,
    max_discounted_price: 189.9,
  };
  const normalized = normalizeOfficialSellerPromotionsFromApi([campingRow, row], { source: "live" });
  const liquida = normalized.promotions.find((p) => p.promotion_name === "Liquida Full - Outlet");
  assert.equal(liquida?.final_price_brl, "189.90");
}

function testStructuralAnonymousPriceDiscountExcluded() {
  const row = {
    type: "PRICE_DISCOUNT",
    status: "candidate",
    original_price: 74.99,
    price: 0,
    suggested_discounted_price: 56,
  };
  assert.equal(isStructuralAnonymousPriceDiscountRow(row), true);
  const normalized = normalizeOfficialSellerPromotionsFromApi([row], { source: "live" });
  assert.equal(normalized.normalized_total, 0);
}

function testVariationRangeAuditListingComVariacoes() {
  const row = {
    id: "P-MLB17759006",
    type: "DEAL",
    name: "Liquida Full - Outlet",
    status: "candidate",
    original_price: 129.9,
    price: 110.42,
    min_discounted_price: 90,
    max_discounted_price: 123.4,
  };
  const ui = resolvePromotionUiFinancials(row, {
    listingId: "MLB6526137900",
    listingContext: { variations_count: 4, raw_json: { variations: [{ id: 1 }, { id: 2 }] } },
    skipLiquidaCaseAudit: true,
  });
  assert.equal(ui.variation_range_audit?.has_listing_variations, true);
  assert.equal(ui.variation_range_audit?.has_price_range, true);
  assert.equal(ui.variation_range_audit?.silent_single_price_selected, true);
  assert.ok(ui.source_warnings.includes("variation_range_ambiguous_single_price_selected"));
  assert.equal(ui.variation_linkage_v1?.price_range_min_brl, "90.00");
  assert.equal(ui.variation_linkage_v1?.price_range_max_brl, "123.40");
}

function testContratoSsotAuditPayloadCompleto() {
  const row = {
    external_listing_id: "MLB6086602390",
    promotion_id: "P-1",
    promotion_name: "Liquida Full - Outlet",
    promotion_type: "DEAL",
    ml_promotion_raw_status: "candidate",
    promotion_offer_contract: {
      marketplace: "mercado_livre",
      marketplace_account_id: "acc-1",
      listing_id: "MLB6086602390",
      promotion_id: "P-1",
      promotion_name: "Liquida Full - Outlet",
      promotion_type: "DEAL",
      original_price_brl: "299.90",
      base_price_source: "original_price",
      final_price_brl: "231.00",
      final_price_source: "price",
      discount_percent_display: "23",
      discount_percent_decimal: "22.97",
      discount_amount_brl: "68.90",
    },
    marketplace: {
      listing_type_label: "Clássico",
      sale_price_brl: "231.00",
      original_price_brl: "299.90",
      sale_fee_amount_brl: "34.65",
      shipping_cost_amount_brl: "0.00",
      marketplace_payout_amount_brl: "196.35",
      margin_amount_brl: "120.00",
      margin_percent: "51.95",
    },
    result: { profit_brl: "120.00", margin_pct: "51.95" },
  };
  const audit = buildPromotionScenarioSsotAuditPayload(row, {
    marketplace_account_id: "acc-1",
    listing_external_id: "MLB6086602390",
  });
  assert.equal(audit.discount_percent, "23");
  assert.equal(audit.base_price, "299.90");
  assert.equal(audit.promotion_price, "231.00");
  assert.equal(audit.base_price_source, "original_price");
  assert.equal(audit.promotion_price_source, "price");
  assert.equal(audit.fee, "34.65");
  assert.equal(audit.profit, "120.00");
}

function testPanelParityMLB6784329822LiquidaPercent26() {
  const row = {
    id: "P-MLB17759006",
    type: "DEAL",
    name: "Liquida Full - Outlet",
    status: "candidate",
    original_price: 74.99,
    price: 56,
    _suse7_price_enriched: true,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.final_price_brl, "56.00");
  assert.equal(ui.discount_amount_brl, "18.99");
  assert.equal(ui.discount_percent_display, "26");
  const card = buildPromotionCardContract({
    listingExternalId: "MLB6784329822",
    promotionRow: row,
  });
  assert.equal(card.selected_discount_percent, "26");
  assert.equal(card.selected_source_path, "price");
}

function testPanelParityMLB6086986228Descontaco0707() {
  const row = {
    id: "P-MLB17489058",
    type: "DEAL",
    name: "07.07 e Descontaco",
    status: "candidate",
    original_price: 269.9,
    price: 0,
    suggested_discounted_price: 234.8,
    max_discounted_price: 261.79,
    min_discounted_price: 53.98,
    _suse7_price_enriched: true,
  };
  const ui = resolvePromotionUiFinancials(row, { listingId: "MLB6086986228" });
  assert.equal(ui.final_price_brl, "261.80");
  assert.equal(ui.final_price_source, "max_discounted_price");
  assert.equal(ui.discount_amount_brl, "8.10");
  assert.equal(ui.discount_percent_display, "4");
  assert.equal(ui.panel_parity?.selected_final_price, "261.80");
  assert.equal(ui.panel_parity?.raw_final_price_from_ml, "261.79");
  assert.equal(ui.panel_parity?.selected_discount_amount, "8.10");
  assert.equal(ui.panel_parity?.raw_discount_amount_from_ml, "8.11");
  assert.equal(ui.panel_parity?.selected_discount_percent, "4");
  assert.equal(ui.panel_parity?.selected_rule, "ml_panel_currency_rounding");
  assert.equal(ui.panel_parity?.selected_source_path, "max_discounted_price");
  assert.ok(ui.panel_parity?.warning_codes?.includes("ML_PANEL_CURRENCY_ROUNDING_APPLIED"));
  assert.ok(ui.panel_parity?.source_trace?.some((t) => String(t).includes("currency_rounding")));
  assert.equal(ui.panel_parity?.is_ambiguous, true);

  const card = buildPromotionCardContract({
    listingExternalId: "MLB6086986228",
    promotionRow: row,
  });
  assert.equal(card.selected_final_price, "261.80");
  assert.equal(card.raw_final_price_from_ml, "261.79");
  assert.equal(card.selected_discount_amount, "8.10");
  assert.equal(card.raw_discount_amount_from_ml, "8.11");
  assert.equal(card.selected_discount_percent, "4");
  assert.equal(card.selected_rule, "ml_panel_currency_rounding");
  assert.ok(card.warning_codes?.includes("ML_PANEL_CURRENCY_ROUNDING_APPLIED"));
  assert.equal(card.real_promotion_final_price_brl, "261.80");
}

function testPanelParityMLB6086986228LiquidaFull() {
  const aumente = {
    id: "P-MLB17625056",
    type: "SMART",
    name: "Aumente suas vendas",
    status: "candidate",
    original_price: 269.9,
    price: 231,
    seller_percentage: 13,
    meli_percentage: 1.4,
    _suse7_price_enriched: true,
  };
  const row = {
    id: "P-MLB17759006",
    type: "DEAL",
    name: "Liquida Full - Outlet",
    status: "candidate",
    original_price: 269.9,
    price: 0,
    suggested_discounted_price: 231,
    max_discounted_price: 256.4,
    min_discounted_price: 112.77,
    _suse7_price_enriched: true,
  };
  const ui = resolvePromotionUiFinancials(row, {
    sameListingOtherPromotionPrices: ["231.00"],
    sameListingSiblingRows: [aumente, row],
    listingId: "MLB6086986228",
    skipLiquidaCaseAudit: true,
  });
  assert.equal(ui.final_price_brl, "231.00");
  assert.equal(ui.final_price_source, "suggested_discounted_price");
  assert.equal(ui.discount_amount_brl, "38.90");
  assert.equal(ui.discount_percent_display, "15");
}

function testPanelParityDecimalFallbackSemPercentualOficial() {
  const row = {
    status: "candidate",
    original_price: 100,
    price: 85,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.equal(ui.discount_percent_display, "15");
  assert.equal(ui.discount_source, "calculated:original_minus_final");
}

function testPanelParityFaixaAmbiguaMantemWarning() {
  const row = {
    id: "P-RANGE",
    type: "DEAL",
    name: "07.07 e Descontaco",
    status: "candidate",
    original_price: 269.9,
    price: 0,
    suggested_discounted_price: 234.8,
    max_discounted_price: 261.79,
    min_discounted_price: 53.98,
  };
  const ui = resolvePromotionUiFinancials(row);
  assert.ok(ui.source_warnings.includes("variation_range_detected"));
  assert.ok(Array.isArray(ui.panel_parity?.source_trace));
  assert.equal(ui.panel_parity?.is_ambiguous, true);
}

function testPanelParityMLB6086602390LiquidaFullAggressiveSuggested() {
  const aumente = {
    id: "P-MLB17625056",
    type: "SMART",
    name: "Aumente suas vendas",
    status: "candidate",
    original_price: 279.9,
    price: 231,
  };
  const row = {
    id: "P-MLB17759006",
    type: "DEAL",
    name: "Liquida Full - Outlet",
    status: "candidate",
    original_price: 279.9,
    price: 0,
    suggested_discounted_price: 231,
    max_discounted_price: 265.9,
    min_discounted_price: 111.57,
    _suse7_price_enriched: true,
  };
  const ui = resolvePromotionUiFinancials(row, {
    listingId: "MLB6086602390",
    sameListingSiblingRows: [aumente, row],
    sameListingOtherPromotionPrices: ["231.00"],
  });
  assert.equal(ui.final_price_brl, "231.00");
  assert.equal(ui.discount_amount_brl, "48.90");
  assert.equal(ui.discount_percent_display, "18");
  assert.equal(ui.panel_parity?.selected_rule, "panel:liquida_suggested_aggressive_tier");

  const card = buildPromotionCardContract({
    listingExternalId: "MLB6086602390",
    promotionRow: row,
    sameListingPromotionRows: [aumente, row],
    liveFetchOk: true,
    promotionPayloadSource: "live",
  });
  assert.equal(card.real_promotion_final_price_brl, "231.00");
  assert.equal(card.discount_amount_brl, "48.90");
  assert.equal(card.promotion_payload_source, "live");
}

function testPanelParityMLB6784329822OfertaRelampagoLiveTier() {
  const row = {
    id: "LGH-MLB1000",
    type: "LIGHTNING",
    status: "candidate",
    original_price: 74.99,
    price: 62.69,
    max_discounted_price: 67.5,
    suggested_discounted_price: 63.75,
    min_discounted_price: 22.49,
    _suse7_list_min_discounted_price: 15,
    _suse7_price_enriched: true,
  };
  const ui = resolvePromotionUiFinancials(row, { listingId: "MLB6784329822" });
  assert.equal(ui.final_price_brl, "52.75");
  assert.equal(ui.discount_amount_brl, "22.24");
  assert.equal(ui.discount_percent_display, "30");
  assert.equal(ui.panel_parity?.selected_rule, "panel:lightning_max_minus_list_min_tier");
  assert.equal(ui.panel_parity?.selected_source_path, "max_discounted_price");

  const card = buildPromotionCardContract({
    listingExternalId: "MLB6784329822",
    promotionRow: row,
    liveFetchOk: true,
  });
  assert.equal(card.selected_final_price, "52.75");
  assert.equal(card.raw_final_price_from_ml, "52.75");
  assert.equal(card.selected_discount_amount, "22.24");
}

function testPromotionLivePayloadStaleBlockedMeta() {
  const receivedAt = new Date(Date.now() - PROMOTION_LIVE_PAYLOAD_TTL_MS - 1000).toISOString();
  const meta = buildPromotionLivePayloadMeta({
    rawRow: { id: "P1", type: "DEAL", price: 10, original_price: 100 },
    pipelinePromoSource: "db_snapshot",
    liveFetchOk: false,
    payloadReceivedAt: receivedAt,
    cacheHit: true,
    blockedStale: true,
  });
  assert.equal(meta.promotion_payload_source, "cache_stale_blocked");
  assert.equal(meta.promotion_payload_stale_blocked, true);
}

function testModalOpenFreshnessGuardStaleForcesLiveBypass() {
  const staleAt = new Date(Date.now() - PROMOTION_LIVE_PAYLOAD_TTL_MS - 5000).toISOString();
  const guard = evaluateModalOpenPromotionFreshnessGuard({
    listingExternalId: "MLB999",
    dbSnapshotUpdatedAt: staleAt,
    dbSnapshotRows: [{ id: "P1", type: "DEAL", price: 10, original_price: 100 }],
    persistedPromoCount: 3,
  });
  assert.equal(guard.force_live_bypass, true);
  assert.equal(guard.cache_stale_by_age, true);
  assert.equal(guard.promotion_payload_source, "cache_stale_candidate");
  assert.ok(guard.promotion_payload_age_ms != null);
  assert.ok(guard.promotion_payload_age_ms > PROMOTION_LIVE_PAYLOAD_TTL_MS);
}

function testModalOpenFreshnessGuardFreshWithinTtl() {
  const freshAt = new Date(Date.now() - 30_000).toISOString();
  const guard = evaluateModalOpenPromotionFreshnessGuard({
    listingExternalId: "MLB999",
    dbSnapshotUpdatedAt: freshAt,
    dbSnapshotRows: [{ id: "P1", type: "DEAL", price: 10, original_price: 100 }],
    persistedPromoCount: 2,
  });
  assert.equal(guard.cache_stale_by_age, false);
  assert.equal(guard.promotion_payload_source, "cache_fresh_candidate");
  assert.ok(guard.promotion_payload_age_ms != null);
  assert.ok(guard.promotion_payload_age_ms <= PROMOTION_LIVE_PAYLOAD_TTL_MS);
}

function testCacheFreshMetaWithinTtlWhenLiveFails() {
  const receivedAt = new Date(Date.now() - 30_000).toISOString();
  const meta = buildPromotionLivePayloadMeta({
    rawRow: { id: "P1", type: "DEAL", price: 10, original_price: 100 },
    pipelinePromoSource: "db_snapshot",
    liveFetchOk: false,
    payloadReceivedAt: receivedAt,
    cacheHit: true,
    blockedStale: false,
  });
  assert.equal(meta.promotion_payload_source, "cache_fresh");
  assert.equal(meta.promotion_payload_stale_blocked, false);
}

function testPromotionCardContractSelectedSourceNeverEmpty() {
  const row = { id: "P1", type: "DEAL", status: "candidate", original_price: 100, price: 90 };
  const card = buildPromotionCardContract({
    listingExternalId: "MLB1",
    promotionRow: row,
    liveFetchOk: true,
  });
  assert.ok(card.selected_source != null && String(card.selected_source).trim() !== "");
  assert.ok(card.selected_source_path != null && String(card.selected_source_path).trim() !== "");
}

function testPromotionCardContractDecimalDiscountFields() {
  const row = {
    id: "P1",
    type: "DEAL",
    status: "candidate",
    original_price: 279.9,
    price: 231,
    suggested_discounted_price: 231,
  };
  const card = buildPromotionCardContract({
    listingExternalId: "MLB6086602390",
    promotionRow: row,
    liveFetchOk: true,
  });
  assert.match(String(card.discount_amount_brl ?? ""), /^\d+\.\d{2}$/);
  assert.match(String(card.selected_discount_amount ?? card.discount_amount_brl ?? ""), /^\d+\.\d{2}$/);
  assert.match(String(card.discount_percent_display ?? ""), /^\d+$/);
}

function testPanelCurrencyRoundingRestrictedToDealModestMax() {
  const roundingRelampago = applyMercadoLivreMlPanelCurrencyRounding({
    rawFinalDec: new Decimal("60.39"),
    originalDec: new Decimal("78.6"),
    selectedRule: "registry:family_strategy",
    selectedSourcePath: "price",
    hasAmbiguousVariationWithoutId: false,
  });
  assert.equal(roundingRelampago.applied, false);

  const roundingDeal = applyMercadoLivreMlPanelCurrencyRounding({
    rawFinalDec: new Decimal("261.79"),
    originalDec: new Decimal("269.9"),
    selectedRule: "panel:deal_modest_max_tier",
    selectedSourcePath: "max_discounted_price",
    hasAmbiguousVariationWithoutId: true,
  });
  assert.equal(roundingDeal.applied, true);
  assert.equal(roundingDeal.finalPriceDec?.toFixed(2), "261.80");
}

function testPanelParityMLB4684020397Descontaco0707IntermediateMax() {
  const row = {
    id: "P-MLB17489058",
    type: "DEAL",
    name: "07.07 e Descontaco",
    status: "candidate",
    original_price: 74.9,
    price: 0,
    suggested_discounted_price: 47.35,
    max_discounted_price: 54.84,
    min_discounted_price: 14.98,
    _suse7_price_enriched: true,
  };
  const ui = resolvePromotionUiFinancials(row, { listingId: "MLB4684020397" });
  assert.equal(ui.final_price_brl, "54.84");
  assert.equal(ui.discount_amount_brl, "20.06");
  assert.equal(ui.discount_percent_display, "27");
  assert.equal(ui.panel_parity?.selected_rule, "panel:deal_intermediate_max_tier");
  assert.equal(ui.panel_parity?.selected_source_path, "max_discounted_price");
}

function testPanelParityMLB4684020397LiquidaModestMaxUnanimousCross() {
  const aumente = {
    id: "P-MLB17625056",
    type: "SMART",
    name: "Aumente suas vendas",
    status: "candidate",
    original_price: 74.9,
    price: 54.5,
    _suse7_price_enriched: true,
  };
  const top = {
    id: "P-MLB17637260",
    type: "SMART",
    name: "Top Oferta Construcao",
    status: "candidate",
    original_price: 74.9,
    price: 54.5,
    _suse7_price_enriched: true,
  };
  const row = {
    id: "P-MLB17759006",
    type: "DEAL",
    name: "Liquida Full - Outlet",
    status: "candidate",
    original_price: 74.9,
    price: 0,
    suggested_discounted_price: 54.5,
    max_discounted_price: 71.15,
    min_discounted_price: 28.46,
    _suse7_price_enriched: true,
  };
  const siblings = [aumente, top, row];
  const ui = resolvePromotionUiFinancials(row, {
    listingId: "MLB4684020397",
    sameListingSiblingRows: siblings,
    sameListingOtherPromotionPrices: ["54.50"],
  });
  assert.equal(ui.final_price_brl, "71.15");
  assert.equal(ui.discount_amount_brl, "3.75");
  assert.equal(ui.discount_percent_display, "5");
  assert.equal(ui.panel_parity?.selected_rule, "panel:liquida_modest_max_unanimous_cross_tier");
}

function testPanelParityMLB5742272490LiquidaModestMaxConservative() {
  const aumente = {
    id: "P-MLB17625056",
    type: "SMART",
    name: "Aumente suas vendas",
    status: "candidate",
    original_price: 338.6,
    price: 295.6,
    _suse7_price_enriched: true,
  };
  const festival = {
    id: "P-MLB17695018",
    type: "SMART",
    name: "Festival Casa Nova",
    status: "candidate",
    original_price: 338.6,
    price: 295.6,
    _suse7_price_enriched: true,
  };
  const anonymous = {
    type: "PRICE_DISCOUNT",
    status: "candidate",
    original_price: 338.6,
    price: 0,
    suggested_discounted_price: 304.74,
    max_discounted_price: 321.67,
    min_discounted_price: 135.44,
  };
  const row = {
    id: "P-MLB17759006",
    type: "DEAL",
    name: "Liquida Full - Outlet",
    status: "candidate",
    original_price: 338.6,
    price: 0,
    suggested_discounted_price: 304.74,
    max_discounted_price: 321.67,
    min_discounted_price: 135.44,
    _suse7_price_enriched: true,
  };
  const siblings = [aumente, festival, anonymous, row];
  const ui = resolvePromotionUiFinancials(row, {
    listingId: "MLB5742272490",
    sameListingSiblingRows: siblings,
    sameListingOtherPromotionPrices: ["295.60", "304.74"],
  });
  assert.equal(ui.final_price_brl, "321.67");
  assert.equal(ui.discount_amount_brl, "16.93");
  assert.equal(ui.discount_percent_display, "5");
  assert.equal(ui.panel_parity?.selected_rule, "panel:liquida_modest_max_conservative_tier");
  assert.equal(ui.panel_parity?.selected_source_path, "max_discounted_price");
}

function testPanelParityMLB3303235755LiquidaSuggestedCrossTier() {
  const impulsione = {
    id: "P-MLB17625058",
    type: "SMART",
    name: "Impulsione suas vendas",
    status: "candidate",
    original_price: 186.14,
    price: 162.16,
    _suse7_price_enriched: true,
  };
  const anonymous = {
    type: "PRICE_DISCOUNT",
    status: "candidate",
    original_price: 186.14,
    price: 0,
    suggested_discounted_price: 167.18,
    max_discounted_price: 176.83,
    min_discounted_price: 37.23,
  };
  const row = {
    id: "P-MLB17759006",
    type: "DEAL",
    name: "Liquida Full - Outlet",
    status: "candidate",
    original_price: 186.14,
    price: 0,
    suggested_discounted_price: 167.18,
    max_discounted_price: 176.83,
    min_discounted_price: 37.23,
    _suse7_price_enriched: true,
  };
  const siblings = [impulsione, anonymous, row];
  const ui = resolvePromotionUiFinancials(row, {
    listingId: "MLB3303235755",
    sameListingSiblingRows: siblings,
    sameListingOtherPromotionPrices: ["162.16", "167.18"],
  });
  assert.equal(ui.final_price_brl, "167.18");
  assert.equal(ui.discount_amount_brl, "18.96");
  assert.equal(ui.discount_percent_display, "11");
  assert.equal(ui.panel_parity?.selected_rule, "panel:liquida_suggested_cross_promo_tier");
}

function testPanelParityMLB5742272490AumenteSellerMeliDecimalPercent() {
  const row = {
    id: "P-MLB17625056",
    type: "SMART",
    name: "Aumente suas vendas",
    status: "candidate",
    original_price: 338.6,
    price: 295.6,
    seller_percentage: 10.2,
    meli_percentage: 2.5,
    _suse7_price_enriched: true,
  };
  const ui = resolvePromotionUiFinancials(row, { listingId: "MLB5742272490" });
  assert.equal(ui.final_price_brl, "295.60");
  assert.equal(ui.discount_amount_brl, "43.00");
  assert.equal(ui.discount_percent_display, "12.7");
  assert.equal(ui.discount_source, "ml_payload:seller_plus_meli_percentage");
}

function testPanelParityMLB4684020397OfertaRelampagoHighPriceTier() {
  const row = {
    id: "LGH-MLB1000",
    type: "LIGHTNING",
    status: "candidate",
    original_price: 74.9,
    price: 53.71,
    suggested_discounted_price: 63.67,
    max_discounted_price: 67.41,
    min_discounted_price: 22.47,
    _suse7_list_min_discounted_price: 14.98,
    _suse7_price_enriched: true,
  };
  const ui = resolvePromotionUiFinancials(row, { listingId: "MLB4684020397" });
  assert.equal(ui.final_price_brl, "53.17");
  assert.equal(ui.discount_amount_brl, "21.73");
  assert.equal(ui.discount_percent_display, "30");
  assert.equal(ui.panel_parity?.selected_rule, "panel:lightning_min_spread_high_price_tier");
}

const tests = [
  testBuildListingVariationContextFromRawJsonVariations,
  testBuildListingVariationContextFallbackVariationsCount,
  testBuildListingVariationContextSemEvidenciaNaoInventa,
  testNormalizeOfficialPromotionsPropagaListingContextVariacao,
  testBoostedOfferBooleanTrueRelampagoCase3,
  testBoostedOfferStringTrue,
  testLightningSemBoostedFlagUsaTotalPriceForBoostedOffer,
  testCandidateTopOfertaEnrichmentPriceNaoMax,
  testCandidateSellerPercentage14PriceCorretoGera4,
  testCandidateLiquidaIgnoraMaxDiscountedUsaPrice,
  testStartedUsaPriceNaoMaxDiscounted,
  testPriceZeroNaoUsaSellerPercentage,
  testCandidateSuggestedQuandoPriceZero,
  testCase2OfertaRelampagoPreco6039,
  testContratoCanonicoFestivalEnrichedPrice,
  testMergeEnrichedPreservaIdentidade,
  testMissaoMLB6086602390LiquidaFull,
  testMissaoMLB6086602390FestivalCasaNova,
  testMissaoMLB6086602390FestivalCasaNovaRawListagemAmbigua,
  testMissaoMLB6086602390FestivalSemSuggestedUsaMaxAmbiguo,
  testMissaoMLB6086602390FestivalCasaNovaSuggestedEqualsMaxSemPriceGap,
  testFinancialSsotSuperOfertaCasaFeeReduction,
  testFinancialSsotLiquidaSemReducaoTarifa,
  testMissaoMLB6086602390Descontaco0707,
  testMissaoMLB6086602390SuperOfertaCasa,
  testMissaoMLB6086602390AumenteSuasVendas,
  testMissaoMLB6086602390VendaCasaDecor,
  testMergeEnrichedPreservaSuggestedMaxDaListagem,
  testMergeEnrichedPreservaPriceListagemQuandoEnrichmentZeraLiquida,
  testMissaoMLB6086602390OfertaRelampago,
  testPanelParityMLB5742272490OfertaRelampagoModestTier,
  testPanelParityMLB4578041035AumenteSellerDiscountSsot,
  testPanelParityOfficialDiscountAmountPrevailsOverComputed,
  testPanelParityMLB4578041035NormalizeMissingImpulsioneAudit,
  testMissaoMLB6415546858OfertaRelampagoTopDealPrice,
  testMissaoMLB6415546858OfertaRelampago,
  testMissaoMLB6415546858LiquidaFull,
  testMissaoMLB6487881250TopOfertaPapelaria,
  testMissaoMLB3734084847LiquidaFullOutlet,
  testMissaoMLB6415478372TopOfertaPapelaria,
  testMissaoMLB6415478372OfertaRelampago,
  testPromotionCardContractFestivalCasaNova,
  testPromotionCardContractTodosCasesMLB6086602390,
  testExtractSellerPromotionRowsPaginado,
  testNormalizeListaCompletaMLB6784329822,
  testMissaoMLB6784329822Descontaco0707SemContaminacao,
  testMissaoMLB6784329822LiquidaFullSemRegressaoContaminacao,
  testMissaoMLB6248404078LiquidaFullOutletSemHerancaCrossPromo,
  testMissaoMLB6248404078LiquidaFullOutletNormalizeComContextoListing,
  testListaDedupeKeyPreservaMesmoPrecoNomesDiferentes,
  testStructuralAnonymousPriceDiscountExcluded,
  testVariationRangeAuditListingComVariacoes,
  testContratoSsotAuditPayloadCompleto,
  testPanelParityMLB6784329822LiquidaPercent26,
  testPanelParityMLB6086986228Descontaco0707,
  testPanelParityMLB6086986228LiquidaFull,
  testPanelParityDecimalFallbackSemPercentualOficial,
  testPanelParityFaixaAmbiguaMantemWarning,
  testPanelParityMLB6086602390LiquidaFullAggressiveSuggested,
  testPanelParityMLB6784329822OfertaRelampagoLiveTier,
  testPromotionLivePayloadStaleBlockedMeta,
  testModalOpenFreshnessGuardStaleForcesLiveBypass,
  testModalOpenFreshnessGuardFreshWithinTtl,
  testCacheFreshMetaWithinTtlWhenLiveFails,
  testPromotionCardContractSelectedSourceNeverEmpty,
  testPromotionCardContractDecimalDiscountFields,
  testPanelCurrencyRoundingRestrictedToDealModestMax,
  testPanelParityMLB4684020397Descontaco0707IntermediateMax,
  testPanelParityMLB4684020397LiquidaModestMaxUnanimousCross,
  testPanelParityMLB5742272490LiquidaModestMaxConservative,
  testPanelParityMLB3303235755LiquidaSuggestedCrossTier,
  testPanelParityMLB5742272490AumenteSellerMeliDecimalPercent,
  testPanelParityMLB4684020397OfertaRelampagoHighPriceTier,
];

let failed = 0;
for (const fn of tests) {
  try {
    fn();
    console.log(`OK ${fn.name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL ${fn.name}`, e);
  }
}

if (failed > 0) process.exit(1);
console.log(`\n${tests.length} testes OK — SSOT promoções runtime`);
