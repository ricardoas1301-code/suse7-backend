// ======================================================================
// Testes unitários — S1.PROMO-CALC-CARDS-SELECTION-PARITY
// Case principal: MLB5742272490
// ======================================================================

import assert from "node:assert/strict";

import { aplicarExtrasPrecificacaoInteligente } from "../src/domain/pricing/aplicarExtrasPrecificacaoInteligente.js";
import {
  calcularLucroPromocaoComCustosExibidos,
  recalcularContratoFinanceiroPromocaoSelecionada,
  toDec,
} from "../src/domain/pricing/mercadoLivrePromotionCalcCardSelectionParity.js";

async function testLightningTituloAmigavel() {
  const { resolverNomePromocaoExibicao } = await import(
    "../../suse7-frontend/src/components/pricing/pricingPromotionClassicPremiumScenario.js"
  );
  const nome = resolverNomePromocaoExibicao({
    promotion_name: "LIGHTNING",
    promotion_type: "LIGHTNING",
    promotion_card_contract: {
      promotion_name: "LIGHTNING",
      promotion_type: "LIGHTNING",
    },
  });
  assert.equal(nome, "Oferta relâmpago");
}

async function testPercentualDesconto127NoMerge() {
  const { mesclarMetadadosPromocaoNoCenario } = await import(
    "../../suse7-frontend/src/components/pricing/pricingPromotionClassicPremiumScenario.js"
  );
  const sim = {
    marketplace: { sale_price_brl: "295.60", marketplace_payout_amount_brl: "198.48" },
    result: { profit_brl: "-20.14", margin_pct: "-6.81" },
  };
  const promo = {
    promotion_card_contract: {
      promotion_name: "Aumente suas vendas",
      real_promotion_final_price_brl: "295.60",
      discount_amount_brl: "43.00",
      discount_percent_display: "12.7",
    },
  };
  const out = mesclarMetadadosPromocaoNoCenario(sim, promo);
  const m = /** @type {Record<string, unknown>} */ (out?.marketplace ?? {});
  assert.equal(m.seller_discount_percent, "12,7");
}

/** @param {string} salePrice @param {string} payout @param {Record<string, string>} ic */
function cenarioBase(salePrice, payout, ic) {
  return {
    promotion_id: "P-TEST",
    promotion_name: "07.07 e Descontaço",
    marketplace: {
      sale_price_brl: salePrice,
      sale_fee_amount_brl: "39.91",
      shipping_cost_amount_brl: "66.08",
      marketplace_payout_amount_brl: payout,
      net_receivable_brl: payout,
    },
    internal_costs: {
      product_cost_brl: ic.product_cost_brl,
      tax_amount_brl: ic.tax_amount_brl,
      operational_packaging_total_brl: ic.operational_packaging_total_brl,
    },
    result: {
      profit_brl: "3.51",
      margin_pct: "1.19",
    },
  };
}

const EXTRAS_MLB5742272490 = {
  mlAdsEnabled: true,
  mlAdsPercent: "10",
  operationalCostEnabled: true,
  operationalCostPercent: "1",
};

const CUSTOS_INTERNOS = {
  product_cost_brl: "158.84",
  tax_amount_brl: "26.60",
  operational_packaging_total_brl: "0.66",
};

function testPremium29560IncluiMlAdsECustosOperacionaisNoLucro() {
  const scenario = cenarioBase("295.60", "189.61", {
    ...CUSTOS_INTERNOS,
    tax_amount_brl: "26.60",
  });
  const out = recalcularContratoFinanceiroPromocaoSelecionada(scenario, EXTRAS_MLB5742272490, {
    listing_id: "MLB5742272490",
    listing_type_id: "gold_pro",
    promotion_id: "P-0707",
    promotion_name: "07.07 e Descontaço",
    selected_final_price: "295.60",
  });
  const res = /** @type {Record<string, unknown>} */ (out.result ?? {});
  assert.equal(res.profit_brl, "-29.01");
  assert.equal(res.margin_pct, "-9.81");
  const contract = /** @type {Record<string, unknown>} */ (out.promotion_calc_card_selection_contract ?? {});
  assert.equal(contract.profit_after_fix, "-29.01");
  assert.equal(contract.ml_ads_cost, "29.56");
  assert.equal(contract.operational_costs, "2.96");
}

function testPremiumRelampago28660FallbackConservador() {
  const scenario = cenarioBase("286.60", "181.83", {
    product_cost_brl: "158.84",
    tax_amount_brl: "25.79",
    operational_packaging_total_brl: "0.66",
  });
  scenario.marketplace.sale_fee_amount_brl = "38.69";
  scenario.promotion_name = "Oferta relâmpago";

  const out = recalcularContratoFinanceiroPromocaoSelecionada(
    scenario,
    { mlAdsEnabled: true, mlAdsPercent: "10", operationalCostEnabled: false, operationalCostPercent: "0" },
    {
      listing_id: "MLB5742272490",
      listing_type_id: "gold_pro",
      promotion_name: "Oferta relâmpago",
      selected_final_price: "286.60",
    },
  );
  const res = /** @type {Record<string, unknown>} */ (out.result ?? {});
  assert.equal(res.profit_brl, "-32.12");
  assert.equal(res.margin_pct, "-11.21");
}

function testClassicRelampago28660ComExtras() {
  const scenario = cenarioBase("286.60", "190.43", {
    product_cost_brl: "158.84",
    tax_amount_brl: "25.79",
    operational_packaging_total_brl: "0.66",
  });
  scenario.marketplace.sale_fee_amount_brl = "30.09";
  scenario.promotion_name = "Oferta relâmpago";

  const out = recalcularContratoFinanceiroPromocaoSelecionada(scenario, EXTRAS_MLB5742272490, {
    listing_id: "MLB5742272490",
    listing_type_id: "gold_special",
    promotion_name: "Oferta relâmpago",
    selected_final_price: "286.60",
  });
  const res = /** @type {Record<string, unknown>} */ (out.result ?? {});
  assert.equal(res.profit_brl, "-26.39");
  assert.equal(res.margin_pct, "-9.21");
}

function testClassic777Super27088ConsistenciaPayoutLucro() {
  const payout = "176.36";
  const scenario = cenarioBase("270.88", payout, {
    product_cost_brl: "158.84",
    tax_amount_brl: "24.38",
    operational_packaging_total_brl: "0.66",
  });
  scenario.marketplace.sale_fee_amount_brl = "28.44";
  scenario.promotion_name = "7/7 SUPER Oferta CASA";

  const out = recalcularContratoFinanceiroPromocaoSelecionada(scenario, EXTRAS_MLB5742272490, {
    listing_id: "MLB5742272490",
    listing_type_id: "gold_special",
    promotion_name: "7/7 SUPER Oferta CASA",
    selected_final_price: "270.88",
  });
  const contract = /** @type {Record<string, unknown>} */ (out.promotion_calc_card_selection_contract ?? {});
  assert.equal(contract.amount_to_receive, payout);
  const res = /** @type {Record<string, unknown>} */ (out.result ?? {});
  assert.equal(res.profit_brl, "-37.32");
  assert.equal(res.margin_pct, "-13.78");
}

function testClassic29560NaoRegrediuSemIgnorarMlAds() {
  const scenario = cenarioBase("295.60", "198.48", {
    ...CUSTOS_INTERNOS,
  });
  scenario.marketplace.sale_fee_amount_brl = "31.04";

  const out = recalcularContratoFinanceiroPromocaoSelecionada(scenario, EXTRAS_MLB5742272490, {
    listing_id: "MLB5742272490",
    listing_type_id: "gold_special",
    selected_final_price: "295.60",
  });
  const res = /** @type {Record<string, unknown>} */ (out.result ?? {});
  assert.equal(res.profit_brl, "-20.14");
}

function testCalcularLucroFormulaObrigatoria() {
  const lucro = calcularLucroPromocaoComCustosExibidos({
    payout: toDec("189.61"),
    productCost: toDec("158.84"),
    tax: toDec("26.60"),
    packaging: toDec("0.66"),
    mlAds: toDec("29.56"),
    operational: toDec("2.96"),
  });
  assert.equal(lucro.toFixed(2), "-29.01");
}

function testAplicarExtrasIdempotenteNoContrato() {
  const scenario = cenarioBase("295.60", "189.61", CUSTOS_INTERNOS);
  const once = aplicarExtrasPrecificacaoInteligente(scenario, EXTRAS_MLB5742272490);
  const twice = recalcularContratoFinanceiroPromocaoSelecionada(once, EXTRAS_MLB5742272490, {
    listing_id: "MLB5742272490",
  });
  const res = /** @type {Record<string, unknown>} */ (twice.result ?? {});
  assert.equal(res.profit_brl, "-29.01");
}

const tests = [
  ["Premium 295,60 inclui ML Ads + custos operacionais", testPremium29560IncluiMlAdsECustosOperacionaisNoLucro],
  ["Premium relâmpago 286,60 fallback conservador", testPremiumRelampago28660FallbackConservador],
  ["Clássico relâmpago 286,60 com extras", testClassicRelampago28660ComExtras],
  ["Clássico 7/7 SUPER 270,88 payout × lucro", testClassic777Super27088ConsistenciaPayoutLucro],
  ["Clássico 295,60 não ignora ML Ads", testClassic29560NaoRegrediuSemIgnorarMlAds],
  ["Fórmula lucro obrigatória", testCalcularLucroFormulaObrigatoria],
  ["Extras idempotentes no contrato", testAplicarExtrasIdempotenteNoContrato],
  ["LIGHTNING → Oferta relâmpago", testLightningTituloAmigavel],
  ["Desconto 12,7% propagado no merge", testPercentualDesconto127NoMerge],
];

let passed = 0;
for (const [name, fn] of tests) {
  await fn();
  passed += 1;
  console.info(`OK — ${name}`);
}
console.info(`\n${passed}/${tests.length} testes CARD_SELECTION_PARITY passaram.`);