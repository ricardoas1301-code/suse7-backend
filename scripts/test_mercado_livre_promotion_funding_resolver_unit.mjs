// ======================================================================
// Testes unitários — S1.PROMO-FUNDING-ML (subsídio de preço Mercado Livre)
// ======================================================================

import assert from "node:assert/strict";

import { resolveMercadoLivrePromotionFunding } from "../src/domain/promotions/marketplaces/mercadoLivrePromotionFundingResolver.js";
import { recalcularContratoFinanceiroPromocaoSelecionada } from "../src/domain/pricing/mercadoLivrePromotionCalcCardSelectionParity.js";

/** @param {Record<string, unknown>} funding @param {Record<string, string>} esperado */
function assertFunding(funding, esperado) {
  assert.equal(funding.total_discount_brl, esperado.total_discount_brl, "total_discount_brl");
  assert.equal(funding.seller_discount_brl, esperado.seller_discount_brl, "seller_discount_brl");
  assert.equal(funding.marketplace_subsidy_brl, esperado.marketplace_subsidy_brl, "marketplace_subsidy_brl");
  assert.equal(
    funding.seller_effective_price_brl,
    esperado.seller_effective_price_brl,
    "seller_effective_price_brl",
  );
  assert.equal(funding.has_marketplace_subsidy, esperado.has_marketplace_subsidy === "true", "has_marketplace_subsidy");
}

function testSemSubsidio() {
  const out = resolveMercadoLivrePromotionFunding({
    marketplace: "mercado_livre",
    originalPrice: "100.00",
    buyerFinalPrice: "90.00",
    rawPromotion: {},
  });
  assertFunding(out, {
    total_discount_brl: "10.00",
    seller_discount_brl: "10.00",
    marketplace_subsidy_brl: "0.00",
    seller_effective_price_brl: "90.00",
    has_marketplace_subsidy: "false",
  });
}

function testMeliPercentageIgnoradoSemCoFinanciamentoPreco() {
  const out = resolveMercadoLivrePromotionFunding({
    marketplace: "mercado_livre",
    originalPrice: "100.00",
    buyerFinalPrice: "92.00",
    rawPromotion: {
      seller_percentage: 5,
      meli_percentage: 3,
    },
  });
  assertFunding(out, {
    total_discount_brl: "8.00",
    seller_discount_brl: "5.00",
    marketplace_subsidy_brl: "0.00",
    seller_effective_price_brl: "92.00",
    has_marketplace_subsidy: "false",
  });
}

function testValoresDiretosCoFinanciamentoPreco() {
  const out = resolveMercadoLivrePromotionFunding({
    marketplace: "mercado_livre",
    originalPrice: "250.00",
    buyerFinalPrice: "220.00",
    rawPromotion: {
      seller_amount: "18.00",
      meli_amount: "12.00",
    },
  });
  assertFunding(out, {
    total_discount_brl: "30.00",
    seller_discount_brl: "18.00",
    marketplace_subsidy_brl: "12.00",
    seller_effective_price_brl: "232.00",
    has_marketplace_subsidy: "true",
  });
  assert.equal(out.subsidy_source, "direct_amounts");
}

function testMargemUsaPrecoEfetivoSeller() {
  const funding = resolveMercadoLivrePromotionFunding({
    marketplace: "mercado_livre",
    originalPrice: "250.00",
    buyerFinalPrice: "220.00",
    rawPromotion: { seller_amount: "18.00", meli_amount: "12.00" },
  });
  const scenario = {
    marketplace: { sale_price_brl: "220.00", marketplace_payout_amount_brl: "70.00" },
    internal_costs: { product_cost_brl: "50.00", tax_amount_brl: "10.00" },
    result: { profit_brl: "10.00", margin_pct: "4.55" },
    promotion_card_contract: {
      promotion_funding: funding,
      promotion_financial_adjustments: {
        has_marketplace_price_subsidy: true,
        marketplace_price_subsidy_brl: "12.00",
      },
    },
  };
  const out = recalcularContratoFinanceiroPromocaoSelecionada(scenario, null, {});
  const res = /** @type {Record<string, unknown>} */ (out.result ?? {});
  assert.equal(res.margin_pct, "4.31");
  assert.equal(res.offer_status_margin_basis, "seller_effective_price_brl");
}

const tests = [
  ["sem subsídio", testSemSubsidio],
  ["meli_percentage ignorado (fee discount ≠ preço)", testMeliPercentageIgnoradoSemCoFinanciamentoPreco],
  ["valores diretos co-financiamento preço", testValoresDiretosCoFinanciamentoPreco],
  ["margem com preço efetivo seller", testMargemUsaPrecoEfetivoSeller],
];

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed += 1;
  console.info(`OK — ${name}`);
}
console.info(`\n${passed}/${tests.length} testes PROMO-FUNDING-ML passaram.`);
