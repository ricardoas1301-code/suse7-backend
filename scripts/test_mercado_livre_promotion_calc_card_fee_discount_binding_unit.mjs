// ======================================================================
// Testes — binding redução de tarifa nos cards centrais PI (cenário simulado)
// ======================================================================

import assert from "node:assert/strict";

import {
  aplicarReducaoTarifaPromocaoNoCenarioSimulado,
  obterAjustesFinanceirosPromocao,
  resolverAjustesFinanceirosPromocaoComOrigem,
} from "../../suse7-frontend/src/features/pricing/promotions/aplicarReducaoTarifaPromocaoNoCenario.js";
import { resolverCenarioPromocaoPorListingType } from "../../suse7-frontend/src/components/pricing/pricingPromotionClassicPremiumScenario.js";

function testCaso777SuperOfertaPremium() {
  const promo = {
    promotion_id: "P-777",
    promotion_name: "7/7 SUPER Oferta CASA",
    promotion_card_contract: {
      real_promotion_final_price_brl: "223.92",
      promotion_financial_adjustments: {
        marketplace_fee_discount_brl: "12.32",
        has_marketplace_fee_discount: true,
        official_amount_to_receive_brl: "156.66",
      },
      seller_receives_brl: "156.66",
    },
  };

  const sim = {
    sale_price_brl: "223.92",
    marketplace: {
      sale_price_brl: "223.92",
      sale_fee_amount_brl: "30.23",
      shipping_cost_amount_brl: "49.35",
      marketplace_payout_amount_brl: "144.34",
    },
    internal_costs: {
      product_cost_brl: "158.84",
      tax_amount_brl: "26.60",
      operational_packaging_total_brl: "0.66",
    },
    pricing_intelligence_extras: { extras_total_brl: "32.52" },
    result: { profit_brl: "-28.37", margin_pct: "-12.67" },
  };

  aplicarReducaoTarifaPromocaoNoCenarioSimulado(sim, promo, { listingType: "premium" });

  const m = /** @type {Record<string, unknown>} */ (sim.marketplace ?? {});
  assert.equal(m.marketplace_payout_amount_brl, "156.66");
  assert.equal(m.fee_discount_brl, "12.32");
  assert.equal(m.has_fee_subsidy, true);

  const res = /** @type {Record<string, unknown>} */ (sim.result ?? {});
  const profit = Number(res.profit_brl);
  assert.ok(profit > -17 && profit < -15, `lucro esperado ~-16.05, obteve ${profit}`);
}

function testSemReducaoTarifa() {
  const promo = {
    promotion_name: "07.07 e Descontaço",
    promotion_card_contract: {
      real_promotion_final_price_brl: "270.54",
      promotion_financial_adjustments: {
        marketplace_fee_discount_brl: "0.00",
        has_marketplace_fee_discount: false,
      },
    },
  };
  const sim = {
    sale_price_brl: "270.54",
    marketplace: {
      sale_price_brl: "270.54",
      sale_fee_amount_brl: "36.52",
      shipping_cost_amount_brl: "49.35",
      marketplace_payout_amount_brl: "184.67",
    },
    result: { profit_brl: "10.00", margin_pct: "3.70" },
  };

  aplicarReducaoTarifaPromocaoNoCenarioSimulado(sim, promo, { listingType: "premium" });
  const m = /** @type {Record<string, unknown>} */ (sim.marketplace ?? {});
  assert.equal(m.marketplace_payout_amount_brl, "184.67");
  assert.notEqual(m.has_fee_subsidy, true);
}

function testObterAjustesDoOfferContract() {
  const promo = {
    promotion_offer_contract: {
      marketplace_fee_reduction_brl: "6.20",
      seller_receives_brl: "156.67",
    },
  };
  const adj = obterAjustesFinanceirosPromocao(promo);
  assert.equal(adj?.marketplace_fee_discount_brl, "6.20");
  assert.equal(adj?.has_marketplace_fee_discount, true);
}

function testPrioridadeCardContractSobreTopLevelZerado() {
  const promo = {
    promotion_financial_adjustments: {
      marketplace_fee_discount_brl: "0.00",
      has_marketplace_fee_discount: false,
    },
    promotion_card_contract: {
      marketplace_fee_reduction_brl: "12.32",
      seller_receives_brl: "156.66",
    },
  };
  const { ajustes, sourcePath } = resolverAjustesFinanceirosPromocaoComOrigem(promo);
  assert.equal(ajustes?.marketplace_fee_discount_brl, "12.32");
  assert.equal(sourcePath, "promotion_card_contract.fee_discount_fields");
}

function testCenarioFinalAsyncNaoPerdeReducaoTarifa() {
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
    promotion_card_contract: {
      real_promotion_final_price_brl: "223.92",
      seller_receives_brl: "144.34",
    },
    marketplace: {
      sale_price_brl: "223.92",
      sale_fee_amount_brl: "30.23",
      shipping_cost_amount_brl: "49.35",
      marketplace_payout_amount_brl: "144.34",
      fee_discount_brl: "0.00",
      has_fee_subsidy: false,
    },
    internal_costs: {
      product_cost_brl: "158.84",
      tax_amount_brl: "26.60",
      operational_packaging_total_brl: "0.66",
    },
    pricing_intelligence_extras: { extras_total_brl: "32.52" },
    result: { profit_brl: "-28.37", margin_pct: "-12.67" },
  };

  const final = resolverCenarioPromocaoPorListingType(promo, "premium", simBrutoApi, "MLB6086602390");
  assert.ok(final != null, "cenário final deve existir");

  const m = /** @type {Record<string, unknown>} */ (final.marketplace ?? {});
  assert.equal(m.marketplace_payout_amount_brl, "156.66");
  assert.equal(m.fee_discount_brl, "12.32");

  const adj = /** @type {Record<string, unknown>} */ (final.promotion_financial_adjustments ?? {});
  assert.equal(adj.has_marketplace_fee_discount, true);
  assert.equal(adj.marketplace_fee_discount_brl, "12.32");
}

const tests = [
  ["7/7 SUPER binding Premium", testCaso777SuperOfertaPremium],
  ["sem redução tarifa", testSemReducaoTarifa],
  ["obter ajustes offer contract", testObterAjustesDoOfferContract],
  ["card contract vence top-level zerado", testPrioridadeCardContractSobreTopLevelZerado],
  ["cenário async final preserva redução tarifa", testCenarioFinalAsyncNaoPerdeReducaoTarifa],
];

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed += 1;
  console.info(`OK — ${name}`);
}
console.info(`\n${passed}/${tests.length} testes FEE_DISCOUNT_BINDING passaram.`);
