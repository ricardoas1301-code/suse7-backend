// ======================================================================
// Testes unitários — buckets Central de Saúde dos Produtos
// ======================================================================

import assert from "node:assert/strict";
import Decimal from "decimal.js";
import {
  classificarCurvaAbcPorFaturamento,
  montarDistribuicaoCurvaAbcMix,
  montarDistribuicaoCoberturaEstoque,
  montarDistribuicaoLucratividadeMix,
  montarSummaryCardsCentralSaudeProdutos,
  resolverChaveBucketCoberturaEstoque,
  resolverChaveBucketLucratividadeMix,
  somarBucketsDistribuicao,
} from "../src/domain/products/health/productHealthBucketEngine.js";
import { formatDecimalFixed } from "../src/domain/products/health/productHealthNumericHelpers.js";
import {
  PRODUCT_HEALTH_ABC_SCOPE,
  PRODUCT_HEALTH_DEAD_STOCK_DAYS,
  PRODUCT_HEALTH_PROFITABILITY_SCOPE,
  PRODUCT_HEALTH_STOCK_UNKNOWN_BUCKET_KEY,
} from "../src/domain/products/health/productHealthConstants.js";
import {
  avaliarProdutoEstoqueParado,
  montarBreakdownConceitualEstoqueParado,
} from "../src/domain/products/health/productHealthDeadStock.js";

function testCurvaAbcFechaComTotalProducts() {
  const snapshots = [
    { product_id: "1", gross_revenue_brl: new Decimal(700) },
    { product_id: "2", gross_revenue_brl: new Decimal(200) },
    { product_id: "3", gross_revenue_brl: new Decimal(100) },
    { product_id: "4", gross_revenue_brl: new Decimal(0) },
  ];
  const dist = montarDistribuicaoCurvaAbcMix(snapshots);
  assert.equal(dist.total_products, 4);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 4);
  assert.equal(dist.unclassified_count, 0);
}

function testProdutoSemVendaEntraSemVenda() {
  const snapshots = [{ product_id: "1", gross_revenue_brl: new Decimal(0) }];
  const dist = montarDistribuicaoCurvaAbcMix(snapshots);
  assert.equal(dist.distribution.find((b) => b.key === "no_sales")?.count, 1);
}

function testProdutoAbcClassificadoPorFaturamentoAcumulado() {
  const withRevenue = [
    { product_id: "1", gross_revenue_brl: new Decimal(80) },
    { product_id: "2", gross_revenue_brl: new Decimal(15) },
    { product_id: "3", gross_revenue_brl: new Decimal(5) },
  ];
  const total = new Decimal(100);
  const map = classificarCurvaAbcPorFaturamento(withRevenue, total);
  assert.equal(map.get("1"), "curve_a");
  assert.equal(map.get("2"), "curve_b");
  assert.equal(map.get("3"), "curve_c");
}

function testCoberturaEstoqueFechaComTotalProducts() {
  const snapshots = [
    { product_id: "1", stock_quantity: 0, recent_sales_30d: 5 },
    { product_id: "2", stock_quantity: 10, recent_sales_30d: 30 },
    { product_id: "3", stock_quantity: 20, recent_sales_30d: 0 },
  ];
  const dist = montarDistribuicaoCoberturaEstoque(snapshots);
  assert.equal(dist.total_products, 3);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 3);
}

function testProdutoSemGiroEntraSemGiro() {
  const key = resolverChaveBucketCoberturaEstoque({ stock_quantity: 10, recent_sales_30d: 0 });
  assert.equal(key, "no_turnover");
}

function testProdutoEstoqueZeroComVendaEntraRuptura() {
  const key = resolverChaveBucketCoberturaEstoque({ stock_quantity: 0, recent_sales_30d: 4 });
  assert.equal(key, "rupture");
}

function testCoberturaEstoqueChartSegmentosFecham100() {
  const snapshots = [
    { product_id: "1", stock_quantity: 0, recent_sales_30d: 5 },
    { product_id: "2", stock_quantity: 2, recent_sales_30d: 30 },
    { product_id: "3", stock_quantity: 10, recent_sales_30d: 30 },
    { product_id: "4", stock_quantity: 20, recent_sales_30d: 30 },
    { product_id: "5", stock_quantity: 80, recent_sales_30d: 30 },
    { product_id: "6", stock_quantity: 40, recent_sales_30d: 5 },
  ];
  const dist = montarDistribuicaoCoberturaEstoque(snapshots);
  const segments = dist.chart?.segments ?? [];
  assert.ok(segments.length > 0);
  const sum = segments.reduce(
    (acc, row) => acc.plus(new Decimal(String(row.mix_share_percent ?? "0"))),
    new Decimal(0),
  );
  assert.ok(sum.minus(100).abs().lte(0.05), `esperado ~100, recebido ${sum.toString()}`);
  assert.equal(dist.chart?.mix_segments_sum_percent, formatDecimalFixed(sum));
}

function testCoberturaEstoqueSemVendaRecenteEntraNoChart() {
  const snapshots = [
    { product_id: "1", stock_quantity: 10, stock_known: true, recent_sales_30d: 30 },
    { product_id: "2", stock_quantity: 20, stock_known: true, recent_sales_30d: 0 },
  ];
  const dist = montarDistribuicaoCoberturaEstoque(snapshots);
  const segmentKeys = (dist.chart?.segments ?? []).map((row) => row.key);
  assert.ok(segmentKeys.includes("no_turnover"));
  assert.equal(dist.distribution.find((b) => b.key === "no_turnover")?.count, 1);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 2);
}

function testEstoqueNullNaoEntraSemEstoque() {
  const key = resolverChaveBucketCoberturaEstoque({
    stock_quantity: null,
    stock_known: false,
    recent_sales_30d: 0,
  });
  assert.equal(key, PRODUCT_HEALTH_STOCK_UNKNOWN_BUCKET_KEY);
}

function testEstoqueNullNaoContaComoRuptura() {
  const snapshots = [
    { product_id: "1", stock_quantity: null, stock_known: false, recent_sales_30d: 0 },
    { product_id: "2", stock_quantity: 0, stock_known: true, recent_sales_30d: 5 },
  ];
  const dist = montarDistribuicaoCoberturaEstoque(snapshots);
  assert.equal(dist.distribution.find((b) => b.key === "rupture")?.count, 1);
  assert.equal(dist.unclassified_count, 1);
  assert.equal(dist.data_quality?.status, "warning");
  assert.equal(dist.data_quality?.unknown_stock_count, 1);
}

function testCoberturaAcabaEm7Dias() {
  const key = resolverChaveBucketCoberturaEstoque({
    stock_quantity: 6,
    stock_known: true,
    recent_sales_30d: 30,
  });
  assert.equal(key, "critical");
}

function testCoberturaEstoqueBaixoEntre8e15Dias() {
  const key = resolverChaveBucketCoberturaEstoque({
    stock_quantity: 10,
    stock_known: true,
    recent_sales_30d: 30,
  });
  assert.equal(key, "low");
}

function testCoberturaEstoqueEmDiaEntre16e60Dias() {
  const key = resolverChaveBucketCoberturaEstoque({
    stock_quantity: 20,
    stock_known: true,
    recent_sales_30d: 30,
  });
  assert.equal(key, "healthy");
}

function testCoberturaEstoqueAcima60DiasEntraEmDia() {
  const key = resolverChaveBucketCoberturaEstoque({
    stock_quantity: 70,
    stock_known: true,
    recent_sales_30d: 30,
  });
  assert.equal(key, "healthy");
  assert.notEqual(key, "excess");
}

function testCurvaAbcCardDUsaPercentualDoMix() {
  const snapshots = [
    { product_id: "1", gross_revenue_lifetime_brl: new Decimal(100) },
    { product_id: "2", gross_revenue_lifetime_brl: new Decimal(0) },
    { product_id: "3", gross_revenue_lifetime_brl: new Decimal(0) },
  ];
  const dist = montarDistribuicaoCurvaAbcMix(snapshots);
  const cardD = dist.distribution.find((b) => b.key === "no_sales");
  assert.equal(cardD?.mix_share_percent, "66.67");
  assert.equal(cardD?.revenue_share_percent, "0.00");
  assert.equal(cardD?.short_label, "D");
}

function testCurvaAbcCardDNaoUsaPercentualDeFaturamento() {
  const snapshots = [
    { product_id: "1", gross_revenue_lifetime_brl: new Decimal(0) },
  ];
  const dist = montarDistribuicaoCurvaAbcMix(snapshots);
  const cardD = dist.distribution.find((b) => b.key === "no_sales");
  assert.equal(cardD?.revenue_share_percent, "0.00");
  assert.equal(cardD?.mix_share_percent, "100.00");
}

function testCoberturaEstoqueMixSharePercentPorBucket() {
  const snapshots = [
    { product_id: "1", stock_quantity: 0, recent_sales_30d: 5 },
    { product_id: "2", stock_quantity: 20, recent_sales_30d: 30 },
    { product_id: "3", stock_quantity: 20, recent_sales_30d: 0 },
  ];
  const dist = montarDistribuicaoCoberturaEstoque(snapshots);
  const rupture = dist.distribution.find((b) => b.key === "rupture");
  const healthy = dist.distribution.find((b) => b.key === "healthy");
  const noTurnover = dist.distribution.find((b) => b.key === "no_turnover");
  assert.equal(rupture?.mix_share_percent, "33.33");
  assert.equal(healthy?.mix_share_percent, "33.33");
  assert.equal(noTurnover?.mix_share_percent, "33.33");
}

function testLucratividadeFechaComTotalProducts() {
  const snapshots = [
    {
      product_id: "1",
      quantity_sold_lifetime: 2,
      gross_revenue_lifetime_brl: new Decimal(100),
      contribution_margin_percent_lifetime: "35.00",
      has_financial_data_lifetime: true,
    },
    {
      product_id: "2",
      quantity_sold_lifetime: 0,
      gross_revenue_lifetime_brl: new Decimal(0),
      has_financial_data_lifetime: false,
    },
  ];
  const dist = montarDistribuicaoLucratividadeMix(snapshots);
  assert.equal(dist.total_products, 2);
  assert.equal(dist.scope, PRODUCT_HEALTH_PROFITABILITY_SCOPE);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 2);
  assert.equal(dist.distribution.find((b) => b.key === "high_profit")?.label, "Alta lucratividade");
  assert.equal(dist.distribution.find((b) => b.key === "no_sales")?.count, 1);
}

function testProdutoSemVendasEntraSemVendas() {
  const key = resolverChaveBucketLucratividadeMix({
    quantity_sold_lifetime: 0,
    gross_revenue_lifetime_brl: new Decimal(0),
    has_financial_data_lifetime: false,
  });
  assert.equal(key, "no_sales");
}

function testProdutoPrejuizoEntraPrejuizo() {
  const key = resolverChaveBucketLucratividadeMix({
    quantity_sold_lifetime: 3,
    gross_revenue_lifetime_brl: new Decimal(100),
    contribution_margin_percent_lifetime: "-2.00",
    has_financial_data_lifetime: true,
  });
  assert.equal(key, "loss");
  assert.notEqual(key, "low_profit");
}

function testLucratividadeAltaAcima30() {
  const key = resolverChaveBucketLucratividadeMix({
    quantity_sold_lifetime: 5,
    gross_revenue_lifetime_brl: new Decimal(200),
    contribution_margin_percent_lifetime: "35.00",
    has_financial_data_lifetime: true,
  });
  assert.equal(key, "high_profit");
}

function testLucratividadeLucroEntre5e30() {
  const key20 = resolverChaveBucketLucratividadeMix({
    quantity_sold_lifetime: 4,
    gross_revenue_lifetime_brl: new Decimal(150),
    contribution_margin_percent_lifetime: "20.00",
    has_financial_data_lifetime: true,
  });
  const key10 = resolverChaveBucketLucratividadeMix({
    quantity_sold_lifetime: 2,
    gross_revenue_lifetime_brl: new Decimal(80),
    contribution_margin_percent_lifetime: "10.00",
    has_financial_data_lifetime: true,
  });
  assert.equal(key20, "profit");
  assert.equal(key10, "profit");
}

function testLucratividadeLucroBaixoEntre0e5() {
  const key = resolverChaveBucketLucratividadeMix({
    quantity_sold_lifetime: 2,
    gross_revenue_lifetime_brl: new Decimal(80),
    contribution_margin_percent_lifetime: "3.00",
    has_financial_data_lifetime: true,
  });
  assert.equal(key, "low_profit");
}

function testLucratividadeFronteirasSemSobreposicao() {
  assert.equal(
    resolverChaveBucketLucratividadeMix({
      quantity_sold_lifetime: 1,
      gross_revenue_lifetime_brl: new Decimal(10),
      contribution_margin_percent_lifetime: "0.00",
      has_financial_data_lifetime: true,
    }),
    "low_profit",
  );
  assert.equal(
    resolverChaveBucketLucratividadeMix({
      quantity_sold_lifetime: 1,
      gross_revenue_lifetime_brl: new Decimal(10),
      contribution_margin_percent_lifetime: "5.00",
      has_financial_data_lifetime: true,
    }),
    "low_profit",
  );
  assert.equal(
    resolverChaveBucketLucratividadeMix({
      quantity_sold_lifetime: 1,
      gross_revenue_lifetime_brl: new Decimal(10),
      contribution_margin_percent_lifetime: "5.01",
      has_financial_data_lifetime: true,
    }),
    "profit",
  );
  assert.equal(
    resolverChaveBucketLucratividadeMix({
      quantity_sold_lifetime: 1,
      gross_revenue_lifetime_brl: new Decimal(10),
      contribution_margin_percent_lifetime: "30.00",
      has_financial_data_lifetime: true,
    }),
    "profit",
  );
  assert.equal(
    resolverChaveBucketLucratividadeMix({
      quantity_sold_lifetime: 1,
      gross_revenue_lifetime_brl: new Decimal(10),
      contribution_margin_percent_lifetime: "30.01",
      has_financial_data_lifetime: true,
    }),
    "high_profit",
  );
}

function testProdutoComVendaSemDadosFinanceirosEntraPendencia() {
  const key = resolverChaveBucketLucratividadeMix({
    quantity_sold_lifetime: 2,
    gross_revenue_lifetime_brl: new Decimal(100),
    contribution_margin_percent_lifetime: null,
    has_financial_data_lifetime: false,
  });
  assert.equal(key, "financial_data_pending");
  assert.notEqual(key, "no_sales");
}

function testLucratividadeSemVendasNaoEhPendenciaFinanceira() {
  const snapshots = [
    {
      product_id: "1",
      quantity_sold_lifetime: 2,
      gross_revenue_lifetime_brl: new Decimal(100),
      contribution_margin_percent_lifetime: "20.00",
      has_financial_data_lifetime: true,
    },
    {
      product_id: "2",
      quantity_sold_lifetime: 0,
      gross_revenue_lifetime_brl: new Decimal(0),
      has_financial_data_lifetime: false,
    },
    {
      product_id: "3",
      quantity_sold_lifetime: 1,
      gross_revenue_lifetime_brl: new Decimal(50),
      contribution_margin_percent_lifetime: null,
      has_financial_data_lifetime: false,
    },
  ];
  const dist = montarDistribuicaoLucratividadeMix(snapshots);
  const mainKpis = dist.distribution.filter((b) => b.is_main_kpi !== false);
  const noSales = dist.distribution.find((b) => b.key === "no_sales");
  const pending = dist.distribution.find((b) => b.key === "financial_data_pending");
  assert.equal(mainKpis.length, 5);
  assert.equal(noSales?.count, 1);
  assert.equal(pending?.count, 1);
  assert.equal(dist.financial_data_pending?.products_count, 1);
  assert.equal(dist.chart?.no_sales_count, 1);
  assert.equal(dist.chart?.financial_data_pending_count, 1);
  assert.equal(dist.data_quality?.status, "warning");
  assert.ok(String(dist.financial_data_pending?.message ?? "").includes("pendentes"));
}

function testLucratividadeProductsSharePercentUsaTotalProdutos() {
  const snapshots = [
    {
      product_id: "1",
      quantity_sold_lifetime: 2,
      gross_revenue_lifetime_brl: new Decimal(100),
      contribution_margin_percent_lifetime: "35.00",
      has_financial_data_lifetime: true,
    },
    {
      product_id: "2",
      quantity_sold_lifetime: 1,
      gross_revenue_lifetime_brl: new Decimal(50),
      contribution_margin_percent_lifetime: "20.00",
      has_financial_data_lifetime: true,
    },
    {
      product_id: "3",
      quantity_sold_lifetime: 0,
      gross_revenue_lifetime_brl: new Decimal(0),
      has_financial_data_lifetime: false,
    },
  ];
  const dist = montarDistribuicaoLucratividadeMix(snapshots);
  const high = dist.distribution.find((b) => b.key === "high_profit");
  const profit = dist.distribution.find((b) => b.key === "profit");
  const noSales = dist.distribution.find((b) => b.key === "no_sales");
  assert.equal(high?.products_share_percent, "33.33");
  assert.equal(profit?.products_share_percent, "33.33");
  assert.equal(noSales?.products_share_percent, "33.33");
  assert.equal(noSales?.profit_range_label, null);
  assert.equal(noSales?.count_phrase_suffix, "sem vendas");
}

function testLucratividadeChartSegmentosFecham100() {
  const snapshots = [
    {
      product_id: "1",
      quantity_sold_lifetime: 2,
      gross_revenue_lifetime_brl: new Decimal(100),
      contribution_margin_percent_lifetime: "20.00",
      has_financial_data_lifetime: true,
    },
    {
      product_id: "2",
      quantity_sold_lifetime: 0,
      gross_revenue_lifetime_brl: new Decimal(0),
      has_financial_data_lifetime: false,
    },
  ];
  const dist = montarDistribuicaoLucratividadeMix(snapshots);
  const segments = dist.chart?.segments ?? [];
  const sum = segments.reduce(
    (acc, row) => acc.plus(new Decimal(String(row.products_share_percent ?? "0"))),
    new Decimal(0),
  );
  assert.ok(sum.minus(100).abs().lte(0.05), `esperado ~100, recebido ${sum.toString()}`);
  assert.ok(!segments.some((row) => row.key === "financial_data_pending"));
}

function testLucratividadeFaturamentoZeroEntraSemVendas() {
  const key = resolverChaveBucketLucratividadeMix({
    quantity_sold_lifetime: 2,
    gross_revenue_lifetime_brl: new Decimal(0),
    contribution_margin_percent_lifetime: "10.00",
    has_financial_data_lifetime: true,
  });
  assert.equal(key, "no_sales");
}

function testMicosEstoqueCalculamCapitalParadoComDecimal() {
  const snapshots = [
    {
      product_id: "1",
      stock_quantity: 10,
      stock_known: true,
      is_dead_stock: true,
      unit_cost_brl: new Decimal("12.50"),
      recent_sales_30d: 0,
      gross_revenue_brl: new Decimal(0),
      is_active_product: true,
    },
  ];
  const cards = montarSummaryCardsCentralSaudeProdutos(snapshots, new Map());
  assert.equal(cards.dead_stock_count, 1);
  assert.equal(cards.dead_stock_capital_brl, "125.00");
  assert.equal(cards.dead_stock?.missing_cost_products_count, 0);
}

function testEstoqueParadoSemCustoNaoSomaValorFinanceiro() {
  const snapshots = [
    {
      product_id: "1",
      stock_quantity: 10,
      stock_known: true,
      is_dead_stock: true,
      unit_cost_brl: null,
      is_active_product: true,
    },
  ];
  const cards = montarSummaryCardsCentralSaudeProdutos(snapshots, new Map());
  assert.equal(cards.dead_stock_count, 1);
  assert.equal(cards.dead_stock_capital_brl, "0.00");
  assert.equal(cards.dead_stock?.missing_cost_products_count, 1);
  assert.equal(cards.dead_stock?.data_quality?.status, "warning");
}

function testEstoqueParadoProdutoNovoSemVendaNaoEntra() {
  const todayUtc = new Date("2026-06-29T12:00:00.000Z");
  const ok = avaliarProdutoEstoqueParado({
    stockKnown: true,
    stockQty: 5,
    isActiveProduct: true,
    qtyDeadWindow: 0,
    lastSaleAtMs: null,
    productAgeDays: 5,
    thresholdDays: PRODUCT_HEALTH_DEAD_STOCK_DAYS,
    todayUtc,
  });
  assert.equal(ok, false);
}

function testEstoqueParadoSemVendaComIdadeMinimaEntra() {
  const todayUtc = new Date("2026-06-29T12:00:00.000Z");
  const ok = avaliarProdutoEstoqueParado({
    stockKnown: true,
    stockQty: 5,
    isActiveProduct: true,
    qtyDeadWindow: 0,
    lastSaleAtMs: null,
    productAgeDays: 20,
    thresholdDays: PRODUCT_HEALTH_DEAD_STOCK_DAYS,
    todayUtc,
  });
  assert.equal(ok, true);
}

function testEstoqueParadoEstoqueDesconhecidoNaoEntra() {
  const ok = avaliarProdutoEstoqueParado({
    stockKnown: false,
    stockQty: null,
    isActiveProduct: true,
    qtyDeadWindow: 0,
    lastSaleAtMs: null,
    productAgeDays: 30,
    thresholdDays: PRODUCT_HEALTH_DEAD_STOCK_DAYS,
  });
  assert.equal(ok, false);
}

function testBreakdownConceitualEstoqueParadoExplicaDiferencaMix30d() {
  const snapshots = [
    {
      product_id: "1",
      is_active_product: true,
      recent_sales_30d: 1,
      stock_quantity: 10,
      stock_known: true,
      is_dead_stock: false,
    },
    {
      product_id: "2",
      is_active_product: true,
      recent_sales_30d: 0,
      stock_quantity: 0,
      stock_known: true,
      is_dead_stock: false,
    },
    {
      product_id: "3",
      is_active_product: true,
      recent_sales_30d: 0,
      stock_quantity: null,
      stock_known: false,
      is_dead_stock: false,
    },
    {
      product_id: "4",
      is_active_product: true,
      recent_sales_30d: 0,
      stock_quantity: 5,
      stock_known: true,
      qty_dead_window: 0,
      product_age_days: 5,
      last_sale_at: null,
      unit_cost_brl: new Decimal("10"),
      is_dead_stock: false,
    },
    {
      product_id: "5",
      is_active_product: true,
      recent_sales_30d: 0,
      stock_quantity: 8,
      stock_known: true,
      qty_dead_window: 0,
      product_age_days: 30,
      last_sale_at: null,
      unit_cost_brl: new Decimal("12.50"),
      is_dead_stock: true,
    },
    {
      product_id: "6",
      is_active_product: true,
      recent_sales_30d: 0,
      stock_quantity: 3,
      stock_known: true,
      qty_dead_window: 0,
      product_age_days: 40,
      last_sale_at: null,
      unit_cost_brl: null,
      is_dead_stock: true,
    },
  ];

  const breakdown = montarBreakdownConceitualEstoqueParado(snapshots);
  assert.equal(breakdown.active_products_total, 6);
  assert.equal(breakdown.active_with_sale_30d, 1);
  assert.equal(breakdown.active_without_sale_30d, 5);
  assert.equal(breakdown.active_without_sale_stock_known_gt_zero, 3);
  assert.equal(breakdown.active_without_sale_stock_known_zero, 1);
  assert.equal(breakdown.active_without_sale_stock_unknown, 1);
  assert.equal(breakdown.active_without_sale_stock_gt_zero_missing_cost, 1);
  assert.equal(breakdown.active_without_sale_stock_gt_zero_too_new_under_threshold, 1);
  assert.equal(breakdown.dead_stock_eligible_final, 2);
  assert.equal(breakdown.dead_stock_with_financial_value, 1);
  assert.equal(breakdown.dead_stock_missing_cost_only, 1);
}

function testMarkupMedioIgnoraProdutoSemCustoOuPreco() {
  const snapshots = [
    { product_id: "1", markup_ratio: new Decimal("2.0"), is_active_product: true, recent_sales_30d: 1, gross_revenue_brl: new Decimal(10) },
    { product_id: "2", markup_ratio: null, is_active_product: true, recent_sales_30d: 1, gross_revenue_brl: new Decimal(10) },
  ];
  const cards = montarSummaryCardsCentralSaudeProdutos(snapshots, new Map());
  assert.equal(cards.average_markup, "2.00");
}

function testGiroProdutosCalculaPercentualSobreTotalProdutos() {
  const snapshots = [
    { product_id: "1", qty_turnover_window: 2 },
    { product_id: "2", qty_turnover_window: 0 },
    { product_id: "3", qty_turnover_window: 1 },
    { product_id: "4", qty_turnover_window: 0 },
  ];
  const cards = montarSummaryCardsCentralSaudeProdutos(snapshots, new Map());
  const turnover = cards.product_turnover;
  assert.equal(turnover?.title, "Giro dos Produtos");
  assert.equal(turnover?.products_with_sales_in_window, 2);
  assert.equal(turnover?.total_products, 4);
  assert.equal(turnover?.percent, "50.00");
  assert.equal(turnover?.window_days, 15);
  assert.equal(turnover?.subtitle, "2 de 4 produtos venderam nos últimos 15 dias");
}

function testUnidadeProductIdNaoListingId() {
  const snapshots = [
    { product_id: "prod-1", gross_revenue_brl: new Decimal(100) },
    { product_id: "prod-2", gross_revenue_brl: new Decimal(0) },
  ];
  const dist = montarDistribuicaoCurvaAbcMix(snapshots);
  assert.equal(dist.total_products, 2);
  assert.ok(dist.distribution.every((row) => typeof row.count === "number"));
}

function testFormatDecimalFixedOficial() {
  assert.equal(formatDecimalFixed(new Decimal("12.456"), 2), "12.46");
}

function testCurvaAbcUsaFaturamentoLifetime() {
  const snapshots = [
    { product_id: "1", gross_revenue_lifetime_brl: new Decimal(900), gross_revenue_brl: new Decimal(50) },
    { product_id: "2", gross_revenue_lifetime_brl: new Decimal(100), gross_revenue_brl: new Decimal(950) },
    { product_id: "3", gross_revenue_lifetime_brl: new Decimal(0), gross_revenue_brl: new Decimal(0) },
  ];
  const dist = montarDistribuicaoCurvaAbcMix(snapshots);
  assert.equal(dist.scope, PRODUCT_HEALTH_ABC_SCOPE);
  assert.equal(dist.distribution.find((b) => b.key === "curve_a")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "curve_c")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "no_sales")?.count, 1);
  assert.equal(dist.distribution.find((b) => b.key === "curve_a")?.revenue_share_percent, "90.00");
  assert.equal(dist.distribution.find((b) => b.key === "curve_b")?.count, 0);
}

function testCurvaAbcChartSegmentosFecham100() {
  const snapshots = [
    { product_id: "1", gross_revenue_lifetime_brl: new Decimal(715.8) },
    { product_id: "2", gross_revenue_lifetime_brl: new Decimal(188.6) },
    { product_id: "3", gross_revenue_lifetime_brl: new Decimal(95.6) },
  ];
  const dist = montarDistribuicaoCurvaAbcMix(snapshots);
  const segments = dist.chart?.segments ?? [];
  assert.equal(segments.length, 3);
  const sum = segments.reduce(
    (acc, row) => acc.plus(new Decimal(String(row.revenue_share_percent ?? "0"))),
    new Decimal(0),
  );
  assert.ok(sum.minus(100).abs().lte(0.05), `esperado ~100, recebido ${sum.toString()}`);
  assert.equal(dist.chart?.revenue_segments_sum_percent, formatDecimalFixed(sum));
}

function testCurvaAbcSemVendaForaDoChart() {
  const snapshots = [
    { product_id: "1", gross_revenue_lifetime_brl: new Decimal(100) },
    { product_id: "2", gross_revenue_lifetime_brl: new Decimal(0) },
  ];
  const dist = montarDistribuicaoCurvaAbcMix(snapshots);
  const segmentKeys = (dist.chart?.segments ?? []).map((row) => row.key);
  assert.ok(!segmentKeys.includes("no_sales"));
  assert.equal(dist.chart?.no_sales_count, 1);
  assert.equal(somarBucketsDistribuicao(dist.distribution), 2);
}

const tests = [
  testCurvaAbcFechaComTotalProducts,
  testProdutoSemVendaEntraSemVenda,
  testProdutoAbcClassificadoPorFaturamentoAcumulado,
  testCoberturaEstoqueFechaComTotalProducts,
  testProdutoSemGiroEntraSemGiro,
  testProdutoEstoqueZeroComVendaEntraRuptura,
  testCoberturaEstoqueChartSegmentosFecham100,
  testCoberturaEstoqueSemVendaRecenteEntraNoChart,
  testEstoqueNullNaoEntraSemEstoque,
  testEstoqueNullNaoContaComoRuptura,
  testCoberturaAcabaEm7Dias,
  testCoberturaEstoqueBaixoEntre8e15Dias,
  testCoberturaEstoqueEmDiaEntre16e60Dias,
  testCoberturaEstoqueAcima60DiasEntraEmDia,
  testCoberturaEstoqueMixSharePercentPorBucket,
  testCurvaAbcCardDUsaPercentualDoMix,
  testCurvaAbcCardDNaoUsaPercentualDeFaturamento,
  testLucratividadeFechaComTotalProducts,
  testProdutoSemVendasEntraSemVendas,
  testProdutoPrejuizoEntraPrejuizo,
  testLucratividadeAltaAcima30,
  testLucratividadeLucroEntre5e30,
  testLucratividadeLucroBaixoEntre0e5,
  testLucratividadeFronteirasSemSobreposicao,
  testProdutoComVendaSemDadosFinanceirosEntraPendencia,
  testLucratividadeSemVendasNaoEhPendenciaFinanceira,
  testLucratividadeProductsSharePercentUsaTotalProdutos,
  testLucratividadeChartSegmentosFecham100,
  testLucratividadeFaturamentoZeroEntraSemVendas,
  testMicosEstoqueCalculamCapitalParadoComDecimal,
  testEstoqueParadoSemCustoNaoSomaValorFinanceiro,
  testEstoqueParadoProdutoNovoSemVendaNaoEntra,
  testEstoqueParadoSemVendaComIdadeMinimaEntra,
  testEstoqueParadoEstoqueDesconhecidoNaoEntra,
  testBreakdownConceitualEstoqueParadoExplicaDiferencaMix30d,
  testMarkupMedioIgnoraProdutoSemCustoOuPreco,
  testGiroProdutosCalculaPercentualSobreTotalProdutos,
  testUnidadeProductIdNaoListingId,
  testFormatDecimalFixedOficial,
  testCurvaAbcUsaFaturamentoLifetime,
  testCurvaAbcChartSegmentosFecham100,
  testCurvaAbcSemVendaForaDoChart,
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
