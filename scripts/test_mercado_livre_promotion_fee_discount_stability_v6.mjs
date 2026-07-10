// ======================================================================
// v6 — estabilidade fee discount: snapshot congelado não zera após async
// ======================================================================

import assert from "node:assert/strict";

import {
  capturarESalvarSnapshotsFinanceirosPromocao,
  obterSnapshotFinanceiroPromocao,
  salvarSnapshotFinanceiroPromocao,
} from "../../suse7-frontend/src/features/pricing/promotions/capturarSnapshotFinanceiroPromocaoSelecionada.js";
import {
  PI_PROMO_REVENUE_RENDER_VERSION,
  buildPromotionRevenueRowsFinal,
  resolverPropsPrimitivasReceitaPromocao,
} from "../../suse7-frontend/src/features/pricing/promotions/buildPromotionRevenueRowsFinal.js";
import { congelarFeeDiscountSnapshotSePositivo } from "../../suse7-frontend/src/features/pricing/promotions/promotionFeeDiscountFinalStabilityV6.js";

function testSnapshotNaoZeraFeeAposAsyncEnvenenado() {
  const promoClick = {
    promotion_id: "P-777",
    promotion_name: "7/7 SUPER Oferta CASA",
    promotion_card_contract: {
      real_promotion_final_price_brl: "223.92",
      promotion_financial_adjustments: {
        marketplace_fee_discount_brl: "6.29",
        has_marketplace_fee_discount: true,
      },
      seller_receives_brl: "144.34",
    },
  };

  const store = /** @type {Record<string, Record<string, unknown>>} */ ({});
  capturarESalvarSnapshotsFinanceirosPromocao(store, {
    row: { scenario: promoClick, group: "available" },
    listingExternalId: "MLB6086602390",
    selectionId: "promo:P-777||",
    requestId: "1",
  });

  const snap = obterSnapshotFinanceiroPromocao(store, {
    listing_id: "MLB6086602390",
    selection_id: "promo:P-777||",
    listing_type: "premium",
  });

  assert.equal(snap?.marketplace_fee_discount_brl, "6.29");

  const promoAsyncSemFee = {
    promotion_id: "P-777",
    promotion_name: "7/7 SUPER Oferta CASA",
    promotion_card_contract: { real_promotion_final_price_brl: "223.92" },
    promotion_financial_adjustments: {
      marketplace_fee_discount_brl: "0.00",
      has_marketplace_fee_discount: false,
    },
  };

  const snapshotRegravacao = {
    ...snap,
    marketplace_fee_discount_brl: null,
    promotion_id: promoAsyncSemFee.promotion_id,
  };
  salvarSnapshotFinanceiroPromocao(store, snapshotRegravacao);

  const snapPreservado = obterSnapshotFinanceiroPromocao(store, {
    listing_id: "MLB6086602390",
    selection_id: "promo:P-777||",
    listing_type: "premium",
  });

  assert.equal(snapPreservado?.marketplace_fee_discount_brl, "6.29");

  const props = resolverPropsPrimitivasReceitaPromocao(snapPreservado);
  assert.equal(props.promotionFeeDiscountBrl, "6.29");
  assert.equal(props.snapshotFeeDiscountBrl, "6.29");

  const rows = buildPromotionRevenueRowsFinal({
    salePriceBrl: "223.92",
    grossSaleFeeBrl: "30.23",
    shippingCostBrl: "49.35",
    promotionFeeDiscountBrl: props.promotionFeeDiscountBrl,
    snapshotFeeDiscountBrl: props.snapshotFeeDiscountBrl,
    promotionOfficialAmountToReceiveBrl: "144.34",
    promotionSelectedKey: props.promotionSelectedKey,
    allowOfficialInference: false,
  });

  assert.equal(rows.finalFeeDiscountBrl, "6.29");
  assert.equal(rows.shouldRenderFeeDiscountLine, true);
  assert.equal(rows.finalAmountToReceiveBrl, "144.34");
  assert.ok(
    rows.preservedFromSnapshot === true ||
      rows.feeDiscountSource === "promotion_fee_discount_brl_prop" ||
      rows.feeDiscountSource === "immutable_click_snapshot_preserved_after_async",
  );
}

function testCongelarFeeNaPrimeiraDeteccaoPositiva() {
  const store = /** @type {Record<string, Record<string, unknown>>} */ ({});
  const key = "MLB6086602390:sel:promo:test:premium";
  store[key] = {
    snapshot_key: key,
    promotion_selected_key: key,
    has_snapshot: true,
    marketplace_fee_discount_brl: null,
    request_id: "2",
  };

  congelarFeeDiscountSnapshotSePositivo(store, key, "6.29", "2");
  assert.equal(store[key].marketplace_fee_discount_brl, "6.29");

  congelarFeeDiscountSnapshotSePositivo(store, key, "0.00", "3");
  assert.equal(store[key].marketplace_fee_discount_brl, "6.29");
}

function testVersaoRenderV6() {
  assert.equal(PI_PROMO_REVENUE_RENDER_VERSION, "promo-fee-discount-final-stability-v6");
}

function testInferenciaNaoZeraQuandoSnapshotTemFee() {
  const rows = buildPromotionRevenueRowsFinal({
    salePriceBrl: "223.92",
    grossSaleFeeBrl: "30.23",
    shippingCostBrl: "49.35",
    snapshotFeeDiscountBrl: "6.29",
    promotionOfficialAmountToReceiveBrl: "144.34",
    allowOfficialInference: false,
  });

  assert.equal(rows.finalFeeDiscountBrl, "6.29");
  assert.ok(rows.rows.some((r) => r.label === "Reduzimos sua tarifa"));
}

const tests = [
  ["snapshot preserva fee após async", testSnapshotNaoZeraFeeAposAsyncEnvenenado],
  ["congelar fee na 1ª detecção", testCongelarFeeNaPrimeiraDeteccaoPositiva],
  ["versão render v6", testVersaoRenderV6],
  ["inferência não zera snapshot", testInferenciaNaoZeraQuandoSnapshotTemFee],
];

let passed = 0;
for (const [name, fn] of tests) {
  fn();
  passed += 1;
  console.info(`OK — ${name}`);
}
console.info(`\n${passed}/${tests.length} testes FEE_DISCOUNT_STABILITY_V6 passaram.`);
