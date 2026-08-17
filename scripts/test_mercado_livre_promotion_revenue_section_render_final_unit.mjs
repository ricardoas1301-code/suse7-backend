// ======================================================================
// Testes — cálculo final inline da receita PI (RevenueSection render)
// Fonte autoritativa: selectedPromotion (mini card)
// ======================================================================

import assert from "node:assert/strict";

import { calcularReceitaPiPromocaoRenderFinal } from "../../suse7-frontend/src/features/pricing/promotions/calcularReceitaPiPromocaoRenderFinal.js";
import { resolverCenarioPromocaoPorListingType } from "../../suse7-frontend/src/components/pricing/pricingPromotionClassicPremiumScenario.js";

function simularRenderFinalRevenueSection(promo, simBrutoApi, listingId, listingType = "premium") {
  const scenarioMerged = resolverCenarioPromocaoPorListingType(promo, listingType, simBrutoApi, listingId);
  assert.ok(scenarioMerged != null, "cenário merged deve existir");

  return calcularReceitaPiPromocaoRenderFinal({
    selectedPromotion: promo,
    scenario: scenarioMerged,
    listingType,
    listingExternalId: listingId,
  });
}

function testCaso777SuperOfertaCasaPremium() {
  const promo = {
    promotion_id: "P-777",
    promotion_name: "7/7 SUPER Oferta CASA",
    promotion_financial_adjustments: {
      marketplace_fee_discount_brl: "0.00",
      has_marketplace_fee_discount: false,
    },
    promotion_card_contract: {
      real_promotion_final_price_brl: "223.92",
      promotion_financial_adjustments: {
        marketplace_fee_discount_brl: "12.32",
        has_marketplace_fee_discount: true,
      },
      seller_receives_brl: "156.66",
    },
  };

  const simBrutoApi = {
    sale_price_brl: "223.92",
    promotion_financial_adjustments: {
      marketplace_fee_discount_brl: "0.00",
      has_marketplace_fee_discount: false,
    },
    marketplace: {
      sale_price_brl: "223.92",
      sale_fee_amount_brl: "30.23",
      shipping_cost_amount_brl: "49.35",
      marketplace_payout_amount_brl: "144.34",
    },
  };

  const render = simularRenderFinalRevenueSection(promo, simBrutoApi, "MLB6086602390");

  assert.equal(render.sale_price_brl, "223.92");
  assert.equal(render.gross_sale_fee_brl, "30.23");
  assert.equal(render.shipping_cost_brl, "49.35");
  assert.equal(render.raw_amount_to_receive_brl, "144.34");
  assert.equal(render.selected_promotion_fee_discount_brl, "12.32");
  assert.equal(render.final_amount_to_receive_brl, "156.66");
  assert.equal(render.should_render_fee_discount_line, true);
  assert.equal(render.component_name, "MercadoLivrePricingScenarioRevenueSection");
  assert.ok(render.selected_promotion_source_path != null);
}

function testCasoVendaCasaEDecorPremium() {
  const promo = {
    promotion_id: "P-VCD",
    promotion_name: "Venda Casa e Decor",
    promotion_offer_contract: {
      marketplace_fee_reduction_brl: "6.20",
      seller_receives_brl: "156.67",
    },
    promotion_card_contract: {
      real_promotion_final_price_brl: "231.00",
    },
  };

  const simBrutoApi = {
    marketplace: {
      sale_price_brl: "231.00",
      sale_fee_amount_brl: "31.18",
      shipping_cost_amount_brl: "49.35",
      marketplace_payout_amount_brl: "150.47",
    },
  };

  const render = simularRenderFinalRevenueSection(promo, simBrutoApi, "MLB6086602390");

  assert.equal(render.sale_price_brl, "231.00");
  assert.equal(render.selected_promotion_fee_discount_brl, "6.20");
  assert.equal(render.final_amount_to_receive_brl, "156.67");
  assert.equal(render.should_render_fee_discount_line, true);
}

function testCasoTopOfertaConstrucaoPremium() {
  const promo = {
    promotion_id: "P-TOP",
    promotion_name: "Top Oferta Construção",
    promotion_card_contract: {
      real_promotion_final_price_brl: "53.29",
      marketplace_fee_reduction_brl: "2.17",
      seller_receives_brl: "30.92",
    },
  };

  const simBrutoApi = {
    marketplace: {
      sale_price_brl: "53.29",
      sale_fee_amount_brl: "8.79",
      shipping_cost_amount_brl: "15.75",
      marketplace_payout_amount_brl: "28.75",
    },
  };

  const render = simularRenderFinalRevenueSection(promo, simBrutoApi, "MLB6784329822");

  assert.equal(render.final_amount_to_receive_brl, "30.92");
  assert.equal(render.selected_promotion_fee_discount_brl, "2.17");
  assert.equal(render.should_render_fee_discount_line, true);
}

function testCasoSemReducaoTarifa() {
  const promo = {
    promotion_name: "07.07 e Descontaço",
    promotion_card_contract: {
      real_promotion_final_price_brl: "64.01",
      promotion_financial_adjustments: {
        marketplace_fee_discount_brl: "0.00",
        has_marketplace_fee_discount: false,
      },
    },
  };

  const simBrutoApi = {
    marketplace: {
      sale_price_brl: "64.01",
      sale_fee_amount_brl: "10.56",
      shipping_cost_amount_brl: "15.75",
      marketplace_payout_amount_brl: "37.70",
    },
  };

  const render = simularRenderFinalRevenueSection(promo, simBrutoApi, "MLB6784329822");

  assert.equal(render.should_render_fee_discount_line, false);
  assert.equal(render.selected_promotion_fee_discount_brl, "0.00");
  assert.equal(render.final_amount_to_receive_brl, "37.70");
}

function testRenderFinalIgnoraPayoutCruSemSelectedPromotion() {
  const simBrutoApi = {
    marketplace: {
      sale_price_brl: "223.92",
      sale_fee_amount_brl: "30.23",
      shipping_cost_amount_brl: "49.35",
      marketplace_payout_amount_brl: "144.34",
    },
  };

  const render = calcularReceitaPiPromocaoRenderFinal({
    selectedPromotion: null,
    scenario: simBrutoApi,
    listingExternalId: "MLB6086602390",
  });

  assert.equal(render.has_selected_promotion, false);
  assert.equal(render.should_render_fee_discount_line, false);
  assert.equal(render.final_amount_to_receive_brl, "144.34");
}

const tests = [
  ["MLB6086602390 / 7/7 SUPER / Premium", testCaso777SuperOfertaCasaPremium],
  ["MLB6086602390 / Venda Casa e Decor / Premium", testCasoVendaCasaEDecorPremium],
  ["MLB6784329822 / Top Oferta Construção / Premium", testCasoTopOfertaConstrucaoPremium],
  ["MLB6784329822 / sem redução tarifa", testCasoSemReducaoTarifa],
  ["Sem selectedPromotion — payout cru", testRenderFinalIgnoraPayoutCruSemSelectedPromotion],
];

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed += 1;
  console.info(`OK — ${name}`);
}
console.info(`\n${passed}/${tests.length} testes REVENUE_SECTION_RENDER_FINAL passaram.`);
