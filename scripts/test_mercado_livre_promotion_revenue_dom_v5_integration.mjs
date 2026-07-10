// ======================================================================
// Integração DOM v5 — rows finais + marcador data-s7-render-version
// Simula HTML emitido por PromotionPiRevenueMarketplaceSection
// ======================================================================

import assert from "node:assert/strict";

import {
  PI_PROMO_REVENUE_RENDER_VERSION,
  buildPromotionRevenueRowsFinal,
} from "../../suse7-frontend/src/features/pricing/promotions/buildPromotionRevenueRowsFinal.js";
import {
  capturarESalvarSnapshotsFinanceirosPromocao,
  capturarSnapshotFinanceiroPromocaoSelecionada,
  obterSnapshotFinanceiroPromocao,
} from "../../suse7-frontend/src/features/pricing/promotions/capturarSnapshotFinanceiroPromocaoSelecionada.js";
import { resolverPropsPrimitivasReceitaPromocao } from "../../suse7-frontend/src/features/pricing/promotions/buildPromotionRevenueRowsFinal.js";

function montarHtmlReceitaPiPromocaoV5({
  rowsBundle,
  promotionRevenueSource = "selectedPromotionSnapshot",
}) {
  const rowsHtml = rowsBundle.rows
    .map(
      (row) =>
        `<div data-s7-revenue-row-key="${row.key}"><span>${row.label}</span><strong>${row.value}</strong></div>`,
    )
    .join("");

  return [
    `<div data-s7-render-version="${PI_PROMO_REVENUE_RENDER_VERSION}" data-s7-promotion-revenue-source="${promotionRevenueSource}">`,
    rowsHtml,
    `<pre>S7 DEBUG PROMO: feeDiscountFinal=${rowsBundle.feeDiscountBrl} finalReceive=${rowsBundle.amountToReceiveBrl}</pre>`,
    `</div>`,
  ].join("");
}

function simularFluxoDom777SuperOfertaCasaPremium() {
  const promo = {
    promotion_id: "P-777",
    promotion_name: "7/7 SUPER Oferta CASA",
    promotion_card_contract: {
      real_promotion_final_price_brl: "223.92",
      promotion_financial_adjustments: {
        marketplace_fee_discount_brl: "12.32",
        has_marketplace_fee_discount: true,
      },
      seller_receives_brl: "156.66",
    },
  };

  const store = /** @type {Record<string, Record<string, unknown>>} */ ({});
  capturarESalvarSnapshotsFinanceirosPromocao(store, {
    row: { scenario: promo, group: "available" },
    listingExternalId: "MLB6086602390",
    selectionId: "promo:P-777||",
    currentListingType: "premium",
  });

  const snapshot = obterSnapshotFinanceiroPromocao(store, {
    listing_id: "MLB6086602390",
    promotion_id: "P-777",
    listing_type: "premium",
  });

  const propsReceita = resolverPropsPrimitivasReceitaPromocao(snapshot);

  assert.equal(propsReceita.promotionFeeDiscountBrl, "12.32");
  assert.equal(propsReceita.promotionOfficialAmountToReceiveBrl, "156.66");

  const scenarioFinalEnvenenado = {
    marketplace: {
      sale_price_brl: "223.92",
      sale_fee_amount_brl: "30.23",
      shipping_cost_amount_brl: "49.35",
      marketplace_payout_amount_brl: "144.34",
    },
  };

  const rowsBundle = buildPromotionRevenueRowsFinal({
    salePriceBrl: scenarioFinalEnvenenado.marketplace.sale_price_brl,
    grossSaleFeeBrl: scenarioFinalEnvenenado.marketplace.sale_fee_amount_brl,
    shippingCostBrl: scenarioFinalEnvenenado.marketplace.shipping_cost_amount_brl,
    promotionFeeDiscountBrl: propsReceita.promotionFeeDiscountBrl,
    promotionOfficialAmountToReceiveBrl: propsReceita.promotionOfficialAmountToReceiveBrl,
  });

  const html = montarHtmlReceitaPiPromocaoV5({
    rowsBundle,
    promotionRevenueSource: propsReceita.promotionRevenueSource,
  });

  assert.ok(html.includes(`data-s7-render-version="${PI_PROMO_REVENUE_RENDER_VERSION}"`));
  assert.ok(html.includes("Reduzimos sua tarifa"));
  assert.ok(html.includes("+R$ 12,32"));
  assert.ok(html.includes("Você recebe"));
  assert.ok(html.includes("R$ 156,66"));
  assert.equal(rowsBundle.amountToReceiveBrl, "156.66");
  assert.equal(rowsBundle.shouldRenderFeeDiscountLine, true);

  const labels = rowsBundle.rows.map((r) => r.label);
  assert.ok(labels.includes("Reduzimos sua tarifa"));
}

function simularFluxoDomTopOfertaConstrucao() {
  const promo = {
    promotion_id: "P-TOP",
    promotion_name: "Top Oferta Construção",
    promotion_card_contract: {
      real_promotion_final_price_brl: "53.29",
      marketplace_fee_reduction_brl: "2.17",
      seller_receives_brl: "30.92",
    },
  };

  const propsReceita = resolverPropsPrimitivasReceitaPromocao(
    capturarSnapshotFinanceiroPromocaoSelecionada({
      row: { scenario: promo, group: "available" },
      listingExternalId: "MLB6784329822",
      listingType: "premium",
    }),
  );

  const rowsBundle = buildPromotionRevenueRowsFinal({
    salePriceBrl: "53.29",
    grossSaleFeeBrl: "8.79",
    shippingCostBrl: "15.75",
    promotionFeeDiscountBrl: propsReceita.promotionFeeDiscountBrl,
    promotionOfficialAmountToReceiveBrl: propsReceita.promotionOfficialAmountToReceiveBrl,
  });

  const html = montarHtmlReceitaPiPromocaoV5({ rowsBundle });

  assert.ok(html.includes("R$ 30,92"));
  assert.ok(html.includes("+R$ 2,17"));
}

function simularSemReducaoTarifa() {
  const rowsBundle = buildPromotionRevenueRowsFinal({
    salePriceBrl: "270.54",
    grossSaleFeeBrl: "36.52",
    shippingCostBrl: "49.35",
    promotionFeeDiscountBrl: "0.00",
    promotionOfficialAmountToReceiveBrl: "184.67",
  });

  const html = montarHtmlReceitaPiPromocaoV5({ rowsBundle });

  assert.ok(!html.includes("Reduzimos sua tarifa"));
  assert.ok(html.includes("R$ 184,67"));
}

const tests = [
  ["DOM v5 / MLB6086602390 / 7/7 SUPER / Premium", simularFluxoDom777SuperOfertaCasaPremium],
  ["DOM v5 / Top Oferta Construção", simularFluxoDomTopOfertaConstrucao],
  ["DOM v5 / sem redução", simularSemReducaoTarifa],
];

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed += 1;
  console.info(`OK — ${name}`);
}
console.info(`\n${passed}/${tests.length} testes integração DOM v5 passaram.`);
