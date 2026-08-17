// ======================================================================
// Testes unitários — buckets Central de Saúde da Concorrência
// ======================================================================

import assert from "node:assert/strict";
import Decimal from "decimal.js";
import {
  montarDistribuicaoCoberturaMonitoramento,
  montarDistribuicaoPosicaoPreco,
  montarDistribuicaoReputacaoConcorrentes,
  montarSummaryCardsCentralSaudeConcorrencia,
  somarBucketsDistribuicao,
} from "../src/domain/competition/health/competitionHealthBucketEngine.js";
import {
  deduplicarConcorrentesAtivosAnalisaveis,
  isConcorrenteLogisticaFull,
  isFreteGratisConcorrente,
  resolverChaveReputacaoConcorrente,
} from "../src/domain/competition/health/competitionHealthCompetitorHelpers.js";
import { COMPETITION_HEALTH_ALERT_CORAL } from "../src/domain/competition/health/competitionHealthConstants.js";
import {
  calcularMaiorPressaoPreco,
  filtrarSnapshotsComComparacaoValida,
  resolverChaveCoberturaMonitoramento,
  resolverChavePosicaoPreco,
  temConcorrenteAbaixoDoPreco,
} from "../src/domain/competition/health/competitionHealthPriceHelpers.js";
import { formatDecimalFixed } from "../src/domain/products/health/productHealthNumericHelpers.js";

function competitor(id, price, extras = {}) {
  return {
    id,
    is_active: true,
    competitor_listing_status: "active",
    is_competitor_listing_active: true,
    last_seen_price: price,
    last_seen_currency: "BRL",
    ...extras,
  };
}

function snapshot(listingId, competitorsCount, ownPrice, competitorRows = []) {
  return {
    marketplace_listing_id: listingId,
    monitored_listing_id: competitorsCount > 0 ? `mon-${listingId}` : null,
    product_id: `product-${listingId}`,
    competitors_count: competitorsCount,
    own_listing: ownPrice != null ? { price: ownPrice, currency: "BRL" } : null,
    competitors: competitorRows,
  };
}

function testCoberturaMonitoramentoFechaComTotalSeller() {
  const rows = [
    snapshot("1", 0, "100.00"),
    snapshot("2", 2, "100.00", [competitor("c-2-0", "90.00")]),
    snapshot("3", 6, "100.00", [
      competitor("c-3-0", "90.00"),
      competitor("c-3-1", "91.00"),
      competitor("c-3-2", "92.00"),
      competitor("c-3-3", "93.00"),
      competitor("c-3-4", "94.00"),
      competitor("c-3-5", "95.00"),
    ]),
    snapshot("4", 0, "100.00"),
    snapshot("5", 0, "100.00"),
  ];
  const dist = montarDistribuicaoCoberturaMonitoramento(rows);
  assert.equal(dist.total_listings, 5);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 5);
  assert.equal(dist.distribution.find((b) => b.key === "no_competitors")?.count, 3);
  assert.equal(dist.distribution.find((b) => b.key === "incomplete_monitoring")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "complete_monitoring")?.count, 1);
}

function testCoberturaMonitoramentoChartFecha100() {
  const rows = [
    snapshot("1", 0, "100.00"),
    snapshot("2", 1, "100.00", [competitor("c-2-0", "90.00")]),
    snapshot("3", 6, "100.00", [
      competitor("c-3-0", "90.00"),
      competitor("c-3-1", "91.00"),
      competitor("c-3-2", "92.00"),
      competitor("c-3-3", "93.00"),
      competitor("c-3-4", "94.00"),
      competitor("c-3-5", "95.00"),
    ]),
    snapshot("4", 3, "100.00", [
      competitor("c-4-0", "90.00"),
      competitor("c-4-1", "91.00"),
      competitor("c-4-2", "92.00"),
    ]),
  ];
  const dist = montarDistribuicaoCoberturaMonitoramento(rows);
  const segments = dist.chart?.segments ?? [];
  const sum = segments.reduce(
    (acc, row) => acc.plus(new Decimal(String(row.mix_share_percent ?? "0"))),
    new Decimal(0),
  );
  assert.ok(sum.minus(100).abs().lte(0.05), `esperado ~100, recebido ${sum.toString()}`);
  assert.equal(dist.chart?.mix_segments_sum_percent, formatDecimalFixed(sum));
}

function testPosicaoPrecoMaisBarato() {
  const key = resolverChavePosicaoPreco({ price: "80.00" }, [competitor("c-1", "100.00")]);
  assert.equal(key, "cheaper");
}

function testPosicaoPrecoSemComparacaoForaDoCard() {
  const rows = [
    snapshot("1", 0, "100.00"),
    snapshot("2", 1, "80.00", [competitor("c-2", "100.00")]),
    snapshot("3", 1, "110.00", [competitor("c-3", "100.00")]),
  ];
  const dist = montarDistribuicaoPosicaoPreco(rows, 547);
  assert.equal(dist.base_count, 2);
  assert.equal(dist.total_listings, 547);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 2);
  assert.equal(dist.distribution.some((b) => b.key === "no_comparison"), false);
}

function testPosicaoPrecoPercentualSobreBase() {
  const rows = [
    snapshot("1", 1, "80.00", [competitor("c-1", "100.00")]),
    snapshot("2", 1, "110.00", [competitor("c-2", "100.00")]),
    snapshot("3", 1, "110.00", [competitor("c-3", "100.00")]),
  ];
  const dist = montarDistribuicaoPosicaoPreco(rows, 100);
  assert.equal(dist.base_count, 3);
  const sum = dist.distribution.reduce(
    (acc, row) => acc.plus(new Decimal(String(row.share_percent ?? "0"))),
    new Decimal(0),
  );
  assert.ok(sum.minus(100).abs().lte(0.05));
}

function testReputacaoConcorrentesBucketsMutuamenteExclusivos() {
  assert.equal(
    resolverChaveReputacaoConcorrente({ power_seller_status: "platinum", level_id: "5_green" }),
    "platinum",
  );
  assert.equal(resolverChaveReputacaoConcorrente({ power_seller_status: "gold" }), "gold");
  assert.equal(resolverChaveReputacaoConcorrente({ power_seller_status: "silver" }), "mercado_lider");
  assert.equal(resolverChaveReputacaoConcorrente({ level_id: "5_green" }), "green_reputation");
  assert.equal(resolverChaveReputacaoConcorrente({}), "no_reputation");
}

function testReputacaoConcorrentesDistribuicao() {
  const rows = [
    snapshot("1", 2, "100.00", [
      competitor("c-1", "90.00", { reputation: { power_seller_status: "platinum" } }),
      competitor("c-2", "91.00", { reputation: { power_seller_status: "gold" } }),
    ]),
    snapshot("2", 2, "100.00", [
      competitor("c-3", "92.00", { reputation: { power_seller_status: "silver" } }),
      competitor("c-4", "93.00", { reputation: { level_id: "5_green" } }),
    ]),
  ];
  const dist = montarDistribuicaoReputacaoConcorrentes(rows);
  assert.equal(dist.total_competitors, 4);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 4);
  assert.equal(dist.distribution.find((b) => b.key === "platinum")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "gold")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "mercado_lider")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "green_reputation")?.count, 1);
}

function testReputacaoConcorrentesDedupe() {
  const rows = [
    snapshot("1", 1, "100.00", [
      competitor("c-shared", "90.00", { reputation: { power_seller_status: "gold" } }),
    ]),
    snapshot("2", 1, "100.00", [
      competitor("c-shared", "90.00", { reputation: { power_seller_status: "gold" } }),
    ]),
  ];
  const dist = montarDistribuicaoReputacaoConcorrentes(rows);
  assert.equal(dist.total_competitors, 1);
}

function testSummaryCardsNovosKpis() {
  const rows = [
    snapshot("1", 2, "100.00", [
      competitor("c-1", "90.00", {
        shipping: { free_shipping: true, logistic_type: "fulfillment" },
        official_store_id: "123",
      }),
      competitor("c-2", "91.00", {
        shipping: { free_shipping: false, logistic_type: "xd_drop_off" },
        competitor_listing_status: "paused",
      }),
    ]),
    snapshot("2", 1, "100.00", [
      competitor("c-3", "92.00", {
        shipping: { free_shipping: true, logistic_type: "fulfillment" },
      }),
    ]),
  ];
  const cards = montarSummaryCardsCentralSaudeConcorrencia(rows, 547);
  assert.equal(cards.free_shipping_competitors.count, 2);
  assert.equal(cards.full_competitors.count, 2);
  assert.equal(cards.inactive_competitors.count, 1);
  assert.equal(cards.max_price_pressure.has_value, true);
  assert.equal(cards.max_price_pressure.amount_brl, "10.00");
  assert.equal(cards.max_price_pressure.display_value, "R$ 10,00");
}

function testMaiorPressaoPrecoSemConcorrenteAbaixo() {
  const rows = [
    snapshot("1", 1, "80.00", [competitor("c-1", "100.00")]),
    snapshot("2", 1, "100.00", [competitor("c-2", "100.00")]),
  ];
  const pressure = calcularMaiorPressaoPreco(rows);
  assert.equal(pressure.has_value, false);
  assert.equal(pressure.display_value, null);
  assert.match(pressure.subtitle, /Nenhum concorrente abaixo/);
}

function testMaiorPressaoPrecoPegaMaiorGap() {
  const rows = [
    snapshot("1", 1, "219.90", [competitor("c-1", "129.00")]),
    snapshot("2", 1, "150.00", [competitor("c-2", "140.00")]),
  ];
  const pressure = calcularMaiorPressaoPreco(rows);
  assert.equal(pressure.has_value, true);
  assert.equal(pressure.amount_brl, "90.90");
  assert.equal(pressure.display_value, "R$ 90,90");
  assert.equal(pressure.competitor_id, "c-1");
}

function testSummaryCardsSemLojaOficial() {
  const rows = [
    snapshot("1", 1, "100.00", [competitor("c-1", "90.00", { shipping: { free_shipping: true } })]),
  ];
  const cards = montarSummaryCardsCentralSaudeConcorrencia(rows, 10);
  assert.equal(cards.official_stores, undefined);
  assert.ok(cards.max_price_pressure);
}

function testFreteGratisEFullHelpers() {
  assert.equal(isFreteGratisConcorrente({ free_shipping: true }), true);
  assert.equal(isConcorrenteLogisticaFull({ logistic_type: "fulfillment" }), true);
  assert.equal(isConcorrenteLogisticaFull({ logistic_type: "xd_drop_off" }), false);
}

function testCoralPadronizado() {
  const noCompetitors = montarDistribuicaoCoberturaMonitoramento([snapshot("1", 0, "100.00")])
    .distribution.find((b) => b.key === "no_competitors");
  const moreExpensive = montarDistribuicaoPosicaoPreco(
    [snapshot("1", 1, "110.00", [competitor("c-1", "100.00")])],
    1,
  ).distribution.find((b) => b.key === "more_expensive");
  assert.equal(noCompetitors?.chart_color, COMPETITION_HEALTH_ALERT_CORAL);
  assert.equal(moreExpensive?.chart_color, COMPETITION_HEALTH_ALERT_CORAL);
}

function testConcorrenteInativoIgnoradoNaComparacao() {
  const key = resolverChavePosicaoPreco(
    { price: "100.00" },
    [competitor("c-1", "50.00", { competitor_listing_status: "paused" })],
  );
  assert.equal(key, "no_comparison");
}

function testResolverChaveCobertura() {
  assert.equal(resolverChaveCoberturaMonitoramento(0), "no_competitors");
  assert.equal(resolverChaveCoberturaMonitoramento(1), "incomplete_monitoring");
  assert.equal(resolverChaveCoberturaMonitoramento(6), "complete_monitoring");
}

function testTemConcorrenteAbaixo() {
  assert.equal(
    temConcorrenteAbaixoDoPreco({ price: "100.00" }, [competitor("c-1", "90.00")]),
    true,
  );
  assert.equal(
    temConcorrenteAbaixoDoPreco({ price: "100.00" }, [competitor("c-1", "110.00")]),
    false,
  );
}

function testFiltrarComparacaoValida() {
  const rows = [
    snapshot("1", 0, "100.00"),
    snapshot("2", 1, "80.00", [competitor("c-2", "100.00")]),
  ];
  assert.equal(filtrarSnapshotsComComparacaoValida(rows).length, 1);
}

function testOrdemBucketsCobertura() {
  const dist = montarDistribuicaoCoberturaMonitoramento([snapshot("1", 0, "100.00")]);
  assert.equal(dist.distribution[0]?.key, "complete_monitoring");
  assert.equal(dist.distribution[1]?.key, "incomplete_monitoring");
  assert.equal(dist.distribution[2]?.key, "no_competitors");
}

function testDeduplicarConcorrentesAtivos() {
  const rows = [
    snapshot("1", 1, "100.00", [competitor("c-1", "90.00")]),
    snapshot("2", 1, "100.00", [competitor("c-1", "90.00")]),
    snapshot("3", 1, "100.00", [competitor("c-2", "90.00", { competitor_listing_status: "paused" })]),
  ];
  assert.equal(deduplicarConcorrentesAtivosAnalisaveis(rows).length, 1);
}

const tests = [
  testCoberturaMonitoramentoFechaComTotalSeller,
  testCoberturaMonitoramentoChartFecha100,
  testPosicaoPrecoMaisBarato,
  testPosicaoPrecoSemComparacaoForaDoCard,
  testPosicaoPrecoPercentualSobreBase,
  testReputacaoConcorrentesBucketsMutuamenteExclusivos,
  testReputacaoConcorrentesDistribuicao,
  testReputacaoConcorrentesDedupe,
  testSummaryCardsNovosKpis,
  testMaiorPressaoPrecoSemConcorrenteAbaixo,
  testMaiorPressaoPrecoPegaMaiorGap,
  testSummaryCardsSemLojaOficial,
  testFreteGratisEFullHelpers,
  testCoralPadronizado,
  testConcorrenteInativoIgnoradoNaComparacao,
  testResolverChaveCobertura,
  testTemConcorrenteAbaixo,
  testFiltrarComparacaoValida,
  testOrdemBucketsCobertura,
  testDeduplicarConcorrentesAtivos,
];

let passed = 0;
for (const test of tests) {
  test();
  passed += 1;
  console.log(`OK ${test.name}`);
}

console.log(`\n${passed}/${tests.length} testes OK — competition health buckets`);
