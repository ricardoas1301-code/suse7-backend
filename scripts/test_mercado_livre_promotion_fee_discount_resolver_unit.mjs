// ======================================================================
// Testes unitários — S1.PROMO-FEE-DISCOUNT-ML (redução de tarifa ≠ subsídio preço)
// ======================================================================

import assert from "node:assert/strict";

import { resolveMercadoLivrePromotionFeeDiscount } from "../src/domain/promotions/marketplaces/mercadoLivrePromotionFeeDiscountResolver.js";
import {
  enrichPromotionContractWithFunding,
  resolveMercadoLivrePromotionFunding,
} from "../src/domain/promotions/marketplaces/mercadoLivrePromotionFundingResolver.js";

function testSemReducaoTarifa() {
  const out = resolveMercadoLivrePromotionFeeDiscount({
    buyer_final_price_brl: "270.54",
    gross_sale_fee_brl: "36.52",
    shipping_cost_brl: "49.35",
    official_amount_to_receive_brl: "184.67",
    rawPromotion: { fee_discount_amount: "0" },
  });
  assert.equal(out.marketplace_fee_discount_brl, "0.00");
  assert.equal(out.has_marketplace_fee_discount, false);
  assert.equal(out.calculated_amount_to_receive_brl, "184.67");
}

function testReducaoTarifaExplicita() {
  const out = resolveMercadoLivrePromotionFeeDiscount({
    buyer_final_price_brl: "223.92",
    gross_sale_fee_brl: "30.23",
    shipping_cost_brl: "49.35",
    rawPromotion: { fee_discount_amount: "12.32", amount_to_receive: "156.66" },
  });
  assert.equal(out.marketplace_fee_discount_brl, "12.32");
  assert.equal(out.has_marketplace_fee_discount, true);
  assert.equal(out.official_amount_to_receive_brl, "156.66");
  assert.equal(out.calculated_amount_to_receive_brl, "156.66");
}

function testInferenciaPorAmountToReceive() {
  const out = resolveMercadoLivrePromotionFeeDiscount({
    buyer_final_price_brl: "223.92",
    gross_sale_fee_brl: "30.23",
    shipping_cost_brl: "49.35",
    official_amount_to_receive_brl: "156.66",
    rawPromotion: {},
  });
  assert.equal(out.marketplace_fee_discount_brl, "12.32");
  assert.equal(out.fee_discount_source, "amount_to_receive_reconciliation");
}

function testNaoConfundirComSubsidiPreco() {
  const contract = enrichPromotionContractWithFunding(
    {
      original_price_brl: "279.90",
      real_promotion_final_price_brl: "223.92",
      marketplace_fee_gross_brl: "30.23",
      freight_cost_brl: "49.35",
      seller_receives_brl: "156.66",
    },
    {
      seller_percentage: "20",
      meli_percentage: "5.3",
      fee_discount_amount: "12.32",
      amount_to_receive: "156.66",
    },
    { listing_id: "MLB6086602390", promotion_name: "7/7 SUPER Oferta CASA" },
  );
  const adj = /** @type {Record<string, unknown>} */ (contract.promotion_financial_adjustments ?? {});
  assert.equal(adj.marketplace_fee_discount_brl, "12.32");
  assert.equal(adj.marketplace_price_subsidy_brl, "0.00");
  assert.equal(adj.has_marketplace_fee_discount, true);
  assert.equal(adj.has_marketplace_price_subsidy, false);
  assert.equal(contract.has_marketplace_subsidy, false);

  const funding = resolveMercadoLivrePromotionFunding({
    originalPrice: "279.90",
    buyerFinalPrice: "223.92",
    rawPromotion: { seller_percentage: 20, meli_percentage: 5.3, fee_discount_amount: "12.32" },
  });
  assert.equal(funding.marketplace_subsidy_brl, "0.00");
  assert.equal(funding.has_marketplace_subsidy, false);
}

const tests = [
  ["sem redução de tarifa", testSemReducaoTarifa],
  ["redução explícita 12,32", testReducaoTarifaExplicita],
  ["inferência amount_to_receive", testInferenciaPorAmountToReceive],
  ["fee discount ≠ price subsidy", testNaoConfundirComSubsidiPreco],
];

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed += 1;
  console.info(`OK — ${name}`);
}
console.info(`\n${passed}/${tests.length} testes PROMO-FEE-DISCOUNT passaram.`);
