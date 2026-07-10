// ======================================================================
// Integração async — clique mini card → loading → render final (snapshot imutável)
// Simula perda de redução no cenário final da simulação.
// ======================================================================

import assert from "node:assert/strict";

import {
  capturarESalvarSnapshotsFinanceirosPromocao,
  obterSnapshotFinanceiroPromocao,
} from "../../suse7-frontend/src/features/pricing/promotions/capturarSnapshotFinanceiroPromocaoSelecionada.js";
import { calcularReceitaPiPromocaoRenderFinal } from "../../suse7-frontend/src/features/pricing/promotions/calcularReceitaPiPromocaoRenderFinal.js";
import { resolverCenarioPromocaoPorListingType } from "../../suse7-frontend/src/components/pricing/pricingPromotionClassicPremiumScenario.js";

const LISTING_ID = "MLB6086602390";

function formatBrlPtBr(value) {
  const n = Number(value);
  return `R$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function simularFluxoAsyncPromocaoComReducaoTarifa() {
  const promoNoClique = {
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

  const row = { scenario: promoNoClique, group: "available" };
  const store = /** @type {Record<string, Record<string, unknown>>} */ ({});

  capturarESalvarSnapshotsFinanceirosPromocao(store, {
    row,
    listingExternalId: LISTING_ID,
    currentListingType: "premium",
  });

  const snapshot = obterSnapshotFinanceiroPromocao(store, {
    listing_id: LISTING_ID,
    promotion_id: "P-777",
    listing_type: "premium",
  });

  assert.ok(snapshot != null, "snapshot deve existir após clique");
  assert.equal(snapshot.marketplace_fee_discount_brl, "12.32");
  assert.equal(snapshot.official_amount_to_receive_brl, "156.66");
  assert.equal(snapshot.has_snapshot, true);

  const simBrutoLoading = {
    sale_price_brl: "223.92",
    marketplace: {
      sale_price_brl: "223.92",
      sale_fee_amount_brl: "30.23",
      shipping_cost_amount_brl: "49.35",
      fee_discount_brl: "12.32",
      marketplace_payout_amount_brl: "156.66",
    },
  };

  const renderLoading = calcularReceitaPiPromocaoRenderFinal({
    financialSnapshot: snapshot,
    selectedPromotion: null,
    scenario: simBrutoLoading,
    listingType: "premium",
    listingExternalId: LISTING_ID,
  });

  assert.equal(renderLoading.should_render_fee_discount_line, true);
  assert.equal(renderLoading.final_amount_to_receive_brl, "156.66");

  const simBrutoFinalEnvenenado = {
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
      net_receivable_brl: "144.34",
    },
    net_receivable_brl: "144.34",
  };

  const promoMutadaPosAsync = {
    ...promoNoClique,
    promotion_card_contract: {
      real_promotion_final_price_brl: "223.92",
    },
    promotion_financial_adjustments: {
      marketplace_fee_discount_brl: "0.00",
      has_marketplace_fee_discount: false,
    },
  };

  const scenarioFinal = resolverCenarioPromocaoPorListingType(
    promoMutadaPosAsync,
    "premium",
    simBrutoFinalEnvenenado,
    LISTING_ID,
  );

  assert.equal(
    /** @type {Record<string, unknown>} */ (scenarioFinal?.marketplace ?? {}).marketplace_payout_amount_brl,
    "144.34",
    "cenário merged final ainda traz payout cru sem redução",
  );

  const renderFinal = calcularReceitaPiPromocaoRenderFinal({
    financialSnapshot: snapshot,
    selectedPromotion: promoMutadaPosAsync,
    scenario: scenarioFinal,
    listingType: "premium",
    listingExternalId: LISTING_ID,
  });

  assert.equal(renderFinal.has_snapshot, true);
  assert.equal(renderFinal.scenario_raw_amount_to_receive_brl, "144.34");
  assert.equal(renderFinal.snapshot_fee_discount_brl, "12.32");
  assert.equal(renderFinal.final_fee_discount_brl, "12.32");
  assert.equal(renderFinal.final_amount_to_receive_brl, "156.66");
  assert.equal(renderFinal.should_render_fee_discount_line, true);

  const linhaReducao = `+${formatBrlPtBr(renderFinal.final_fee_discount_brl)}`;
  const linhaRecebe = formatBrlPtBr(renderFinal.final_amount_to_receive_brl);

  assert.ok(linhaReducao.includes("12,32"), `esperado +R$ 12,32, obteve ${linhaReducao}`);
  assert.ok(linhaRecebe.includes("156,66"), `esperado R$ 156,66, obteve ${linhaRecebe}`);

  return { renderLoading, renderFinal, snapshot };
}

function simularFluxoAsyncTopOfertaConstrucao() {
  const promoNoClique = {
    promotion_id: "P-TOP",
    promotion_name: "Top Oferta Construção",
    promotion_card_contract: {
      real_promotion_final_price_brl: "53.29",
      marketplace_fee_reduction_brl: "2.17",
      seller_receives_brl: "30.92",
    },
  };

  const store = /** @type {Record<string, Record<string, unknown>>} */ ({});
  capturarESalvarSnapshotsFinanceirosPromocao(store, {
    row: { scenario: promoNoClique, group: "available" },
    listingExternalId: "MLB6784329822",
    currentListingType: "premium",
  });

  const snapshot = obterSnapshotFinanceiroPromocao(store, {
    listing_id: "MLB6784329822",
    promotion_id: "P-TOP",
    listing_type: "premium",
  });

  const simFinal = {
    marketplace: {
      sale_price_brl: "53.29",
      sale_fee_amount_brl: "8.79",
      shipping_cost_amount_brl: "15.75",
      marketplace_payout_amount_brl: "28.75",
    },
  };

  const renderFinal = calcularReceitaPiPromocaoRenderFinal({
    financialSnapshot: snapshot,
    selectedPromotion: { promotion_name: "Top Oferta Construção" },
    scenario: simFinal,
    listingType: "premium",
    listingExternalId: "MLB6784329822",
  });

  assert.equal(renderFinal.final_amount_to_receive_brl, "30.92");
  assert.equal(renderFinal.final_fee_discount_brl, "2.17");
  assert.equal(renderFinal.should_render_fee_discount_line, true);
}

function simularReconciliacaoQuandoSnapshotSoTemPayoutOficial() {
  const promoNoClique = {
    promotion_id: "P-VCD",
    promotion_name: "Venda Casa e Decor",
    promotion_offer_contract: {
      seller_receives_brl: "156.67",
      buyer_final_price_brl: "231.00",
    },
    promotion_card_contract: {
      real_promotion_final_price_brl: "231.00",
    },
  };

  const store = /** @type {Record<string, Record<string, unknown>>} */ ({});
  capturarESalvarSnapshotsFinanceirosPromocao(store, {
    row: { scenario: promoNoClique, group: "available" },
    listingExternalId: LISTING_ID,
    currentListingType: "premium",
  });

  const snapshot = obterSnapshotFinanceiroPromocao(store, {
    listing_id: LISTING_ID,
    promotion_id: "P-VCD",
    listing_type: "premium",
  });

  const simFinal = {
    marketplace: {
      sale_price_brl: "231.00",
      sale_fee_amount_brl: "31.18",
      shipping_cost_amount_brl: "49.35",
      marketplace_payout_amount_brl: "150.47",
    },
  };

  const renderFinal = calcularReceitaPiPromocaoRenderFinal({
    financialSnapshot: snapshot,
    scenario: simFinal,
    listingType: "premium",
    listingExternalId: LISTING_ID,
  });

  assert.equal(renderFinal.inferred_fee_discount_brl, "6.20");
  assert.equal(renderFinal.final_amount_to_receive_brl, "156.67");
  assert.equal(renderFinal.should_render_fee_discount_line, true);
}

const tests = [
  ["click → loading → final / 7/7 SUPER / Premium", simularFluxoAsyncPromocaoComReducaoTarifa],
  ["click → final / Top Oferta Construção", simularFluxoAsyncTopOfertaConstrucao],
  ["reconciliação payout oficial / Venda Casa e Decor", simularReconciliacaoQuandoSnapshotSoTemPayoutOficial],
];

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed += 1;
  console.info(`OK — ${name}`);
}
console.info(`\n${passed}/${tests.length} testes integração SNAPSHOT_ASYNC passaram.`);
