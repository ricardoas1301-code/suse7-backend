// ======================================================================
// Testes unitários — buckets Central de Saúde da Precificação
// ======================================================================

import assert from "node:assert/strict";
import Decimal from "decimal.js";
import {
  montarDistribuicaoMargemProjetada,
  montarDistribuicaoPromocoesAnuncios,
  montarDistribuicaoStatusOferta,
  montarSummaryCardsCentralSaudePrecificacao,
  resolverChaveMargemProjetada,
  resolverChavePromocaoAnuncioBucket,
  resolverChaveStatusOferta,
  somarBucketsDistribuicao,
} from "../src/domain/pricing/health/pricingHealthBucketEngine.js";
import {
  anuncioTemFreteGratis,
  enriquecerSnapshotPrecificacaoAnuncio,
  resolverChavePromocaoAnuncio,
  resolverChaveTipoAnuncio,
} from "../src/domain/pricing/health/pricingHealthListingAttributes.js";
import { montarSnapshotPrecificacaoAnuncio } from "../src/domain/pricing/health/pricingHealthFinancialHelpers.js";

function snapshotBase(overrides = {}) {
  return {
    has_result: true,
    margin_pct_decimal: new Decimal("12"),
    listing_type_key: "classic",
    free_shipping: false,
    promotion_bucket_key: "no_promotion",
    has_active_promotion: false,
    ...overrides,
  };
}

function testStatusOfertaReguaMargemSimples() {
  assert.equal(resolverChaveStatusOferta(snapshotBase({ margin_pct_decimal: new Decimal("6") })), "healthy");
  assert.equal(resolverChaveStatusOferta(snapshotBase({ margin_pct_decimal: new Decimal("5") })), "attention");
  assert.equal(resolverChaveStatusOferta(snapshotBase({ margin_pct_decimal: new Decimal("0") })), "attention");
  assert.equal(resolverChaveStatusOferta(snapshotBase({ margin_pct_decimal: new Decimal("-1") })), "critical");
  assert.equal(resolverChaveStatusOferta(snapshotBase({ has_result: false, margin_pct_decimal: null })), "no_data");
}

function testStatusOfertaFechaComTotal() {
  const rows = [
    snapshotBase({ margin_pct_decimal: new Decimal("10") }),
    snapshotBase({ margin_pct_decimal: new Decimal("3") }),
    snapshotBase({ margin_pct_decimal: new Decimal("-2") }),
    snapshotBase({ has_result: false, margin_pct_decimal: null }),
  ];
  const dist = montarDistribuicaoStatusOferta(rows);
  assert.equal(dist.total_listings, 4);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 4);
  assert.equal(dist.distribution.find((b) => b.key === "healthy")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "attention")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "critical")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "no_data")?.count, 1);
}

function testMargemProjetadaFaixasComerciais() {
  assert.equal(resolverChaveMargemProjetada(snapshotBase({ margin_pct_decimal: new Decimal("35") })), "margin_30_plus");
  assert.equal(resolverChaveMargemProjetada(snapshotBase({ margin_pct_decimal: new Decimal("25") })), "margin_20_29");
  assert.equal(resolverChaveMargemProjetada(snapshotBase({ margin_pct_decimal: new Decimal("15") })), "margin_10_19");
  assert.equal(resolverChaveMargemProjetada(snapshotBase({ margin_pct_decimal: new Decimal("7") })), "margin_0_9");
  assert.equal(resolverChaveMargemProjetada(snapshotBase({ margin_pct_decimal: new Decimal("-1") })), "loss");
  assert.equal(
    resolverChaveMargemProjetada(snapshotBase({ has_result: false, margin_pct_decimal: null })),
    "no_data",
  );

  const rows = [
    snapshotBase({ margin_pct_decimal: new Decimal("35") }),
    snapshotBase({ margin_pct_decimal: new Decimal("25") }),
    snapshotBase({ margin_pct_decimal: new Decimal("15") }),
    snapshotBase({ margin_pct_decimal: new Decimal("7") }),
    snapshotBase({ margin_pct_decimal: new Decimal("-1") }),
    snapshotBase({ has_result: false, margin_pct_decimal: null }),
  ];
  const dist = montarDistribuicaoMargemProjetada(rows);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 6);
}

function testPromocoesPrioridadeExclusiva() {
  const rows = [
    snapshotBase({ promotion_bucket_key: "active_promotion", has_active_promotion: true }),
    snapshotBase({ promotion_bucket_key: "scheduled_promotion" }),
    snapshotBase({ promotion_bucket_key: "available_promotion" }),
    snapshotBase({ promotion_bucket_key: "no_promotion" }),
  ];
  const dist = montarDistribuicaoPromocoesAnuncios(rows);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 4);
  assert.equal(dist.distribution.find((b) => b.key === "active_promotion")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "scheduled_promotion")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "available_promotion")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "no_promotion")?.count, 1);
  assert.equal(dist.title, "Promoções dos Anúncios");
}

function testSummaryCardsComerciais() {
  const rows = [
    snapshotBase({ listing_type_key: "classic", free_shipping: true, promotion_bucket_key: "active_promotion", has_active_promotion: true }),
    snapshotBase({ listing_type_key: "premium", free_shipping: false, promotion_bucket_key: "no_promotion" }),
    snapshotBase({ listing_type_key: "classic", free_shipping: true, promotion_bucket_key: "scheduled_promotion" }),
    snapshotBase({ listing_type_key: "unknown", free_shipping: false, promotion_bucket_key: "available_promotion" }),
  ];
  const cards = montarSummaryCardsCentralSaudePrecificacao(rows, rows.length);
  assert.equal(cards.classic_listings.count, 2);
  assert.equal(cards.premium_listings.count, 1);
  assert.equal(cards.free_shipping_listings.count, 2);
  assert.equal(cards.active_promotion_listings.count, 1);
}

function testResolverPromocaoPersistida() {
  const listing = {
    listing_type_id: "gold_special",
    raw_json: {
      shipping: { free_shipping: true },
      _suse7_item_promotions: [
        {
          id: "PROMO-1",
          type: "DEAL",
          status: "pending",
          name: "Campanha futura",
          suggested_discounted_price: "90.00",
          original_price: "100.00",
        },
      ],
    },
  };
  assert.equal(resolverChaveTipoAnuncio(listing), "classic");
  assert.equal(anuncioTemFreteGratis(listing, null), true);
  assert.equal(resolverChavePromocaoAnuncio(listing, null), "scheduled_promotion");
}

function testResolverPromocaoAtivaPorResolvePromotionState() {
  const listing = {
    price: "80.00",
    original_price: "100.00",
    raw_json: {
      price: "80.00",
      original_price: "100.00",
    },
  };
  const health = {
    promotional_price_brl: "80.00",
    list_or_original_price_brl: "100.00",
  };
  assert.equal(resolverChavePromocaoAnuncio(listing, health), "active_promotion");
}

function testEnriquecimentoSnapshot() {
  const listing = {
    id: "1",
    listing_type_id: "gold_pro",
    raw_json: { shipping: { free_shipping: false } },
  };
  const base = montarSnapshotPrecificacaoAnuncio({
    listing,
    health: null,
    productCosts: null,
    sellerTaxPct: null,
  });
  const enriched = enriquecerSnapshotPrecificacaoAnuncio(base, { listing, health: null });
  assert.equal(enriched.listing_type_key, "premium");
  assert.equal(enriched.promotion_bucket_key, "no_promotion");
  assert.equal(resolverChavePromocaoAnuncioBucket(enriched), "no_promotion");
}

function testChartSegmentosFecham100QuandoHaDados() {
  const rows = [
    snapshotBase({ margin_pct_decimal: new Decimal("10") }),
    snapshotBase({ margin_pct_decimal: new Decimal("3") }),
    snapshotBase({ has_result: false, margin_pct_decimal: null }),
  ];
  const dist = montarDistribuicaoStatusOferta(rows);
  const sum = dist.chart.segments.reduce(
    (acc, seg) => acc.plus(new Decimal(String(seg.mix_share_percent ?? "0"))),
    new Decimal(0),
  );
  assert.ok(sum.gte(99.9) && sum.lte(100.1));
}

const tests = [
  testStatusOfertaReguaMargemSimples,
  testStatusOfertaFechaComTotal,
  testMargemProjetadaFaixasComerciais,
  testPromocoesPrioridadeExclusiva,
  testSummaryCardsComerciais,
  testResolverPromocaoPersistida,
  testResolverPromocaoAtivaPorResolvePromotionState,
  testEnriquecimentoSnapshot,
  testChartSegmentosFecham100QuandoHaDados,
];

let passed = 0;
for (const testFn of tests) {
  testFn();
  passed += 1;
  console.log(`OK ${testFn.name}`);
}

console.log(`\n${passed}/${tests.length} testes OK — pricing health buckets`);
