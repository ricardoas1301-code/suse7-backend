// ======================================================================
// Integração — ViewModel final dos cards centrais PI (loading → render final)
// Simula: promo selecionada + cenário bruto async + resolver + view model
// ======================================================================

import assert from "node:assert/strict";

import { resolverCenarioPromocaoPorListingType } from "../../suse7-frontend/src/components/pricing/pricingPromotionClassicPremiumScenario.js";
import { buildPromotionCardViewModel } from "../../suse7-frontend/src/features/pricing/promotions/buildPromotionMarketplaceRevenueViewModel.js";

function simularFluxoCardCentralFinal(promo, simBrutoApi, listingId, listingType = "premium") {
  const scenarioMerged = resolverCenarioPromocaoPorListingType(promo, listingType, simBrutoApi, listingId);
  assert.ok(scenarioMerged != null, "cenário merged deve existir após simulação");

  const viewModel = buildPromotionCardViewModel({
    selectedPromotion: promo,
    scenario: scenarioMerged,
    listingType,
    listingExternalId: listingId,
    componentName: "MercadoLivrePricingScenarioCompareCard",
    renderPhase: "final",
  });

  return { scenarioMerged, viewModel };
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
    result: { profit_brl: "-28.37", margin_pct: "-12.67" },
  };

  const { viewModel } = simularFluxoCardCentralFinal(promo, simBrutoApi, "MLB6086602390");
  const rev = viewModel.revenue;

  assert.equal(rev.sale_price_brl, "223.92");
  assert.equal(rev.gross_sale_fee_brl, "30.23");
  assert.equal(rev.shipping_cost_brl, "49.35");
  assert.equal(rev.marketplace_fee_discount_brl, "12.32");
  assert.equal(rev.amount_to_receive_before_fee_discount_brl, "144.34");
  assert.equal(rev.amount_to_receive_brl, "156.66");
  assert.equal(rev.should_render_fee_discount_line, true);
  assert.equal(rev.viewmodel_fee_discount_brl, "12.32");

  const profit = Number(viewModel.profit_brl);
  assert.ok(profit > -17 && profit < -15, `lucro esperado ~-16.05, obteve ${profit}`);
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
    sale_price_brl: "53.29",
    marketplace: {
      sale_price_brl: "53.29",
      sale_fee_amount_brl: "8.79",
      shipping_cost_amount_brl: "15.75",
      marketplace_payout_amount_brl: "28.75",
    },
    result: { profit_brl: "5.00", margin_pct: "9.39" },
  };

  const { viewModel } = simularFluxoCardCentralFinal(promo, simBrutoApi, "MLB6784329822");
  const rev = viewModel.revenue;

  assert.equal(rev.amount_to_receive_brl, "30.92");
  assert.equal(rev.marketplace_fee_discount_brl, "2.17");
  assert.equal(rev.should_render_fee_discount_line, true);

  const profit = Number(viewModel.profit_brl);
  assert.ok(Math.abs(profit - 7.17) < 0.02, `lucro esperado ~7.17 (+2.17), obteve ${profit}`);
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
    sale_price_brl: "64.01",
    marketplace: {
      sale_price_brl: "64.01",
      sale_fee_amount_brl: "10.56",
      shipping_cost_amount_brl: "15.75",
      marketplace_payout_amount_brl: "37.70",
    },
    result: { profit_brl: "10.00", margin_pct: "15.62" },
  };

  const { viewModel } = simularFluxoCardCentralFinal(promo, simBrutoApi, "MLB6784329822");
  const rev = viewModel.revenue;

  assert.equal(rev.should_render_fee_discount_line, false);
  assert.equal(rev.amount_to_receive_brl, "37.70");
  assert.equal(rev.marketplace_fee_discount_brl, "0.00");
}

function testViewModelIgnoraPayoutCruDaSimulacao() {
  const promo = {
    promotion_name: "7/7 SUPER Oferta CASA",
    promotion_card_contract: {
      marketplace_fee_reduction_brl: "12.32",
      seller_receives_brl: "156.66",
    },
  };

  const simBrutoApi = {
    marketplace: {
      sale_price_brl: "223.92",
      sale_fee_amount_brl: "30.23",
      shipping_cost_amount_brl: "49.35",
      marketplace_payout_amount_brl: "144.34",
      net_receivable_brl: "144.34",
      marketplace_payout_source: "motor_marketplace_payout",
    },
    net_receivable_brl: "144.34",
    result: { profit_brl: "-28.37", margin_pct: "-12.67" },
  };

  const viewModel = buildPromotionCardViewModel({
    selectedPromotion: promo,
    scenario: simBrutoApi,
    listingType: "premium",
    listingExternalId: "MLB6086602390",
    renderPhase: "final",
  });

  assert.equal(viewModel.revenue.amount_to_receive_brl, "156.66");
  assert.equal(viewModel.auditPayload.should_render_fee_discount_line, true);
  assert.equal(viewModel.auditPayload.viewmodel_fee_discount_brl, "12.32");
}

const tests = [
  ["MLB6086602390 / 7/7 SUPER / Premium", testCaso777SuperOfertaCasaPremium],
  ["MLB6784329822 / Top Oferta Construção / Premium", testCasoTopOfertaConstrucaoPremium],
  ["MLB6784329822 / sem redução tarifa", testCasoSemReducaoTarifa],
  ["ViewModel ignora payout cru da simulação", testViewModelIgnoraPayoutCruDaSimulacao],
];

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed += 1;
  console.info(`OK — ${name}`);
}
console.info(`\n${passed}/${tests.length} testes integração CARD_RENDER_VIEWMODEL passaram.`);
