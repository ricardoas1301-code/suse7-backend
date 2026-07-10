// ======================================================================
// Testes unitários — S1.PROMO-CALC-CARDS-UX-ORIGINAL-PRICE
// Case principal: MLB6086562408 — preço original R$ 269,90
// ======================================================================

import assert from "node:assert/strict";

/** Espelha a condição de MercadoLivrePricingScenarioRaiox (Receita do Marketplace). */
function deveExibirBlocoDescontoSellerReceitaMarketplace({
  ocultarDescontoPromocaoReceitaMarketplace,
  sellerDiscExibicao,
  sellerDisc,
  forcarLinhaDescontoSellerPromocao,
}) {
  return (
    !ocultarDescontoPromocaoReceitaMarketplace &&
    sellerDiscExibicao != null &&
    (sellerDisc != null || forcarLinhaDescontoSellerPromocao)
  );
}

/** Espelha wiring de MercadoLivrePricingScenarioCompareGrid para cards centrais PI. */
function ocultarDescontoQuandoLayoutCabecalhoPromocaoPi(layoutCabecalhoPromocaoPi) {
  return layoutCabecalhoPromocaoPi === true;
}

async function testPrecoOriginalMlb6086562408() {
  const {
    resolverPrecoOriginalPromocaoMonetario,
    resolverPrecoOriginalPromocaoExibicao,
  } = await import("../../suse7-frontend/src/components/pricing/pricingPromotionCardContract.js");

  const scenario = {
    promotion_id: "P-0707",
    promotion_name: "07.07 e Descontaço",
    promotion_card_contract: {
      promotion_name: "07.07 e Descontaço",
      original_price_brl: "269.90",
      real_promotion_final_price_brl: "261.80",
      discount_amount_brl: "8.10",
      discount_percent_display: "4",
    },
    marketplace: {
      sale_price_brl: "261.80",
      seller_discount_amount_brl: "8.10",
      seller_discount_percent: "4",
    },
  };

  const hit = resolverPrecoOriginalPromocaoMonetario(scenario);
  assert.ok(hit != null);
  assert.equal(hit.valor, 269.9);
  assert.equal(hit.source, "promotion_card_contract.original_price_brl");

  const exibicao = resolverPrecoOriginalPromocaoExibicao(scenario);
  assert.ok(exibicao != null);
  assert.match(exibicao.replace(/\u00a0/g, " "), /^Preço R\$ 269,90$/);
  assert.doesNotMatch(exibicao, /Preço original/i);
}

async function testPrecoOriginalFallbackCatalogRow() {
  const { resolverPrecoOriginalPromocaoMonetario } = await import(
    "../../suse7-frontend/src/components/pricing/pricingPromotionCardContract.js"
  );

  const scenario = {
    promotion_name: "Festival Casa Nova",
    marketplace: { sale_price_brl: "247.26" },
  };
  const catalogRow = { externalId: "MLB6086562408", price: "269,90" };

  const hit = resolverPrecoOriginalPromocaoMonetario(scenario, catalogRow);
  assert.ok(hit != null);
  assert.equal(hit.valor, 269.9);
  assert.equal(hit.source, "catalogRow.price");
}

async function testDescontoOcultoNoCardCentralPi() {
  assert.equal(
    deveExibirBlocoDescontoSellerReceitaMarketplace({
      ocultarDescontoPromocaoReceitaMarketplace: true,
      sellerDiscExibicao: "R$ 8,10",
      sellerDisc: "R$ 8,10",
      forcarLinhaDescontoSellerPromocao: true,
    }),
    false,
  );

  assert.equal(
    deveExibirBlocoDescontoSellerReceitaMarketplace({
      ocultarDescontoPromocaoReceitaMarketplace: false,
      sellerDiscExibicao: "R$ 8,10",
      sellerDisc: "R$ 8,10",
      forcarLinhaDescontoSellerPromocao: true,
    }),
    true,
  );

  assert.equal(ocultarDescontoQuandoLayoutCabecalhoPromocaoPi(true), true);
  assert.equal(ocultarDescontoQuandoLayoutCabecalhoPromocaoPi(false), false);
}

async function testLightningTituloAmigavelCardCentral() {
  const { resolverNomePromocaoExibicao } = await import(
    "../../suse7-frontend/src/components/pricing/pricingPromotionClassicPremiumScenario.js"
  );

  const nome = resolverNomePromocaoExibicao({
    promotion_name: "LIGHTNING",
    promotion_type: "LIGHTNING",
    promotion_card_contract: {
      promotion_name: "LIGHTNING",
      promotion_type: "LIGHTNING",
      original_price_brl: "269.90",
    },
  });
  assert.equal(nome, "Oferta relâmpago");
  assert.notEqual(nome, "LIGHTNING");
}

async function testCabecalhoOriginalPriceFormato() {
  const { resolverPrecoOriginalPromocaoExibicao } = await import(
    "../../suse7-frontend/src/components/pricing/pricingPromotionCardContract.js"
  );

  const exibicao = resolverPrecoOriginalPromocaoExibicao({
    promotion_card_contract: { original_price: "269.90" },
  });
  assert.match((exibicao ?? "").replace(/\u00a0/g, " "), /^Preço R\$ 269,90$/);
  assert.doesNotMatch(exibicao ?? "", /Preço original/i);
}

const TESTS = [
  ["preco original MLB6086562408 via contrato", testPrecoOriginalMlb6086562408],
  ["fallback preco original catalogRow.price", testPrecoOriginalFallbackCatalogRow],
  ["desconto oculto no card central PI", testDescontoOcultoNoCardCentralPi],
  ["LIGHTNING traduzido no cabecalho central", testLightningTituloAmigavelCardCentral],
  ["formato Preço R$ no cabecalho", testCabecalhoOriginalPriceFormato],
];

let passed = 0;
for (const [label, fn] of TESTS) {
  await fn();
  passed += 1;
  console.log(`OK — ${label}`);
}

console.log(`\n${passed}/${TESTS.length} testes UX ORIGINAL-PRICE passaram.`);
