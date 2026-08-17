// ======================================================================
// Testes unitários — buckets exaustivos da Central de Saúde dos Anúncios
// ======================================================================

import assert from "node:assert/strict";
import Decimal from "decimal.js";
import {
  resolverChaveBucketOperacionalExclusivo,
  resolverChaveBucketComercialExclusivo,
  somarBucketsDistribuicao,
  validarTotaisBuckets,
} from "../src/domain/listings/health/listingHealthBucketEngine.js";
import { montarDistribuicaoSaudeOperacional } from "../src/domain/listings/health/listingOperationalDistribution.js";
import { montarSummaryCardsCentralSaude } from "../src/domain/dashboard/buildListingsHealthSummary.js";
import {
  montarDistribuicaoSaudeComercial,
  resolverChaveFaixaMargemComercial,
  anuncioAtivoComVendaHistorica,
  anuncioAtivoSemVendaHistorica,
} from "../src/domain/listings/health/listingCommercialDistribution.js";
import { montarDistribuicaoSaudeCadastro } from "../src/domain/listings/health/listingRegistrationDistribution.js";

function testOperacionalUnknownVaiParaBucket() {
  const key = resolverChaveBucketOperacionalExclusivo({
    status_normalized: "unknown",
    status: "under_review",
    available_quantity: 10,
  });
  assert.equal(key, "paused");
}

function testOperacionalAtivoSemEstoquePriorizaZeroStock() {
  const key = resolverChaveBucketOperacionalExclusivo({
    status_normalized: "active",
    status: "active",
    available_quantity: 0,
  });
  assert.equal(key, "zero_stock");
}

function testOperacionalParticaoExaustiva() {
  const snapshots = [
    { listing_id: "1", status_normalized: "active", available_quantity: 20 },
    { listing_id: "2", status_normalized: "paused", available_quantity: 5 },
    { listing_id: "3", status_normalized: "inactive", available_quantity: 0 },
    { listing_id: "4", status_normalized: "unknown", status: "weird", available_quantity: 8 },
    { listing_id: "5", status_normalized: "active", available_quantity: 2 },
  ];
  const dist = montarDistribuicaoSaudeOperacional(snapshots);
  assert.equal(dist.total_listings, 5);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 5);
  assert.equal(dist.unclassified_count, 0);
  assert.equal(dist.offline_count, dist.paused_count + dist.inactive_count);
}

function testOperacionalOfflineUsaBucketsNaoStatusBruto() {
  const snapshots = [
    { listing_id: "1", status_normalized: "paused", status: "paused", available_quantity: 5 },
    { listing_id: "2", status_normalized: "active", status: "under_review", available_quantity: 10 },
    { listing_id: "3", status_normalized: "inactive", status: "closed", available_quantity: 0 },
  ];
  const dist = montarDistribuicaoSaudeOperacional(snapshots);
  assert.equal(dist.paused_count, 2, "under_review deve entrar no bucket pausado");
  assert.equal(dist.inactive_count, 1);
  assert.equal(dist.offline_count, 3);
  const pausedFromDistribution = dist.distribution.find((row) => row.key === "paused")?.count ?? 0;
  const inactiveFromDistribution = dist.distribution.find((row) => row.key === "inactive")?.count ?? 0;
  assert.equal(dist.paused_count, pausedFromDistribution);
  assert.equal(dist.inactive_count, inactiveFromDistribution);
}

function testSummaryCardsFechamTotalListings() {
  const snapshots = [
    { listing_id: "1", status_normalized: "active", status: "active", available_quantity: 10, sales_count: 5 },
    { listing_id: "2", status_normalized: "active", status: "active", available_quantity: 8, sales_count: 0 },
    { listing_id: "3", status_normalized: "paused", status: "paused", available_quantity: 5, sales_count: 0 },
    { listing_id: "4", status_normalized: "unknown", status: "under_review", available_quantity: 3, sales_count: 0 },
    { listing_id: "5", status_normalized: "inactive", status: "closed", available_quantity: 0, sales_count: 0 },
  ];
  const operationalDistribution = montarDistribuicaoSaudeOperacional(snapshots);
  const commercialDistribution = montarDistribuicaoSaudeComercial(snapshots);
  const summaryCards = montarSummaryCardsCentralSaude({
    totalListings: snapshots.length,
    operationalDistribution,
    commercialDistribution,
    attentionCount: 0,
  });

  assert.equal(summaryCards.offline_count, summaryCards.paused_count + summaryCards.inactive_count);
  assert.equal(
    summaryCards.active_count,
    summaryCards.active_with_sales_count + summaryCards.active_without_sales_count,
  );
  assert.equal(
    summaryCards.active_with_sales_count +
      summaryCards.active_without_sales_count +
      summaryCards.offline_count,
    snapshots.length,
  );
  assert.equal(summaryCards.paused_count, operationalDistribution.paused_count);
  assert.equal(summaryCards.inactive_count, operationalDistribution.inactive_count);
  assert.equal(summaryCards.offline_count, operationalDistribution.offline_count);
}

function testComercialSemVendaVaiParaSemDados() {
  const key = resolverChaveBucketComercialExclusivo({
    status_normalized: "active",
    sales_count: 0,
  });
  assert.equal(key, "no_commercial_data");
}

function testComercialPrejuizoNaoEntraEmZeroANove() {
  const margin = new Decimal("-5");
  assert.equal(resolverChaveFaixaMargemComercial(margin), "negative_margin");
  assert.notEqual(resolverChaveFaixaMargemComercial(margin), "critical_margin");
}

function testComercialParticaoExaustiva() {
  const snapshots = [
    {
      listing_id: "1",
      status_normalized: "active",
      sales_count: 10,
      profit_brl: "100",
      gross_revenue_brl: "200",
    },
    { listing_id: "2", status_normalized: "active", sales_count: 0 },
    { listing_id: "3", status_normalized: "paused", sales_count: 0 },
    {
      listing_id: "4",
      status_normalized: "active",
      sales_count: 3,
      profit_margin_percent: "35",
    },
    {
      listing_id: "5",
      status_normalized: "active",
      sales_count: 2,
      profit_brl: "-1",
      gross_revenue_brl: "10",
    },
  ];
  const dist = montarDistribuicaoSaudeComercial(snapshots);
  assert.equal(dist.total_listings, 5);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 5);
  assert.equal(dist.unclassified_count, 0);
}

function testSummaryCardsNaoZeradoQuandoBucketsTemDados() {
  const snapshots = Array.from({ length: 547 }, (_, index) => ({
    listing_id: String(index + 1),
    status_normalized: index < 397 ? "active" : index < 546 ? "paused" : "inactive",
    status: index < 397 ? "active" : index < 546 ? "paused" : "closed",
    available_quantity: 10,
    sales_count: index < 239 ? 3 : 0,
  }));

  const operationalDistribution = montarDistribuicaoSaudeOperacional(snapshots);
  const commercialDistribution = montarDistribuicaoSaudeComercial(snapshots);
  const summaryCards = montarSummaryCardsCentralSaude({
    totalListings: snapshots.length,
    operationalDistribution,
    commercialDistribution,
    attentionCount: 522,
  });

  assert.ok(summaryCards.active_count > 0, "active_count não pode zerar com dados");
  assert.ok(summaryCards.offline_count > 0, "offline_count não pode zerar com dados");
  assert.ok(summaryCards.active_with_sales_count > 0, "active_with_sales_count não pode zerar");
  assert.equal(summaryCards.active_count, summaryCards.active_with_sales_count + summaryCards.active_without_sales_count);
  assert.equal(summaryCards.offline_count, summaryCards.paused_count + summaryCards.inactive_count);
  assert.equal(
    summaryCards.active_with_sales_count + summaryCards.active_without_sales_count + summaryCards.offline_count,
    snapshots.length,
  );
}

function testAtivosComESemVendaFechamTotalAtivos() {
  const snapshots = [
    { listing_id: "1", status_normalized: "active", sales_count: 5 },
    { listing_id: "2", status_normalized: "active", sales_count: 0 },
    { listing_id: "3", status_normalized: "paused", sales_count: 0 },
  ];
  const withSales = snapshots.filter(anuncioAtivoComVendaHistorica).length;
  const withoutSales = snapshots.filter(anuncioAtivoSemVendaHistorica).length;
  const activeTotal = snapshots.filter((s) => s.status_normalized === "active").length;
  assert.equal(withSales + withoutSales, activeTotal);
}

function testCadastroParticaoExaustiva() {
  const snapshots = [
    { listing_id: "1", health_score: 100 },
    { listing_id: "2", health_score: 95 },
    { listing_id: "3", health_score: 80 },
    { listing_id: "4", health_score: 60 },
    { listing_id: "5", health_score: 20 },
  ];
  const dist = montarDistribuicaoSaudeCadastro(snapshots);
  assert.equal(dist.total_listings, 5);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 5);
  const validation = validarTotaisBuckets(5, dist.distribution, "cadastro");
  assert.equal(validation.valid, true);
}

const tests = [
  testOperacionalUnknownVaiParaBucket,
  testOperacionalAtivoSemEstoquePriorizaZeroStock,
  testOperacionalParticaoExaustiva,
  testOperacionalOfflineUsaBucketsNaoStatusBruto,
  testSummaryCardsFechamTotalListings,
  testSummaryCardsNaoZeradoQuandoBucketsTemDados,
  testComercialSemVendaVaiParaSemDados,
  testComercialPrejuizoNaoEntraEmZeroANove,
  testComercialParticaoExaustiva,
  testAtivosComESemVendaFechamTotalAtivos,
  testCadastroParticaoExaustiva,
];

let failed = 0;
for (const fn of tests) {
  try {
    fn();
    console.log(`OK ${fn.name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${fn.name}`, error);
  }
}

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} testes OK`);
}
