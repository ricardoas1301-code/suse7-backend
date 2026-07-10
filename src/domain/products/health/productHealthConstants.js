// ======================================================================
// Constantes SSOT — Central de Saúde dos Produtos (Dashboard).
// ======================================================================

/** Escopo temporal oficial — Curva ABC (histórico completo SUS7). */
export const PRODUCT_HEALTH_ABC_SCOPE = "lifetime";

/** Período operacional interno — cobertura, conversão, lucratividade (não usa filtro Dashboard). */
export const PRODUCT_HEALTH_OPERATIONAL_PERIOD_PRESET = "30d";

/** Janela para estoque parado (sem venda na janela). */
export const PRODUCT_HEALTH_DEAD_STOCK_DAYS = 15;

/** Janela operacional interna — KPI Giro dos Produtos (Dashboard). */
export const PRODUCT_HEALTH_TURNOVER_WINDOW_DAYS = PRODUCT_HEALTH_DEAD_STOCK_DAYS;

/** Janela para cobertura de estoque e conversão do mix. */
export const PRODUCT_HEALTH_COVERAGE_SALES_DAYS = 30;

/** Alias explícito — janela operacional interna de giro para cobertura de estoque. */
export const STOCK_COVERAGE_SALES_WINDOW_DAYS = PRODUCT_HEALTH_COVERAGE_SALES_DAYS;

/** Faixas de dias de cobertura — cobertura de estoque. */
export const STOCK_COVERAGE_CRITICAL_MAX_DAYS = 7;
export const STOCK_COVERAGE_LOW_MAX_DAYS = 15;
export const STOCK_COVERAGE_HEALTHY_MAX_DAYS = 60;

/** Curva ABC — limites acumulados de faturamento. */
export const PRODUCT_HEALTH_ABC_CURVE_A_MAX_PCT = 70;
export const PRODUCT_HEALTH_ABC_CURVE_B_MAX_PCT = 90;

/** Markup mínimo saudável (alerta). */
export const PRODUCT_HEALTH_LOW_MARKUP_THRESHOLD = "1.5";

/** Faixas — Curva ABC do Mix. */
export const PRODUCT_HEALTH_ABC_MIX_BANDS = [
  { key: "curve_a", label: "Curva A", short_label: "A", step_label: "produtos", severity: "success", chart_color: "#3b82f6" },
  { key: "curve_b", label: "Curva B", short_label: "B", step_label: "produtos", severity: "info", chart_color: "#22c55e" },
  { key: "curve_c", label: "Curva C", short_label: "C", step_label: "produtos", severity: "warning", chart_color: "#f59e0b" },
  {
    key: "no_sales",
    label: "Sem venda",
    short_label: "D",
    step_label: "produtos",
    severity: "neutral",
    chart_color: "#94a3b8",
  },
];

/** Faixas — Cobertura de Estoque (labels operacionais para o seller). */
export const PRODUCT_HEALTH_STOCK_COVERAGE_BANDS = [
  {
    key: "rupture",
    label: "Sem estoque",
    short_label: "Sem estoque",
    step_label: "produtos",
    severity: "danger",
    chart_color: "#ef4444",
  },
  {
    key: "critical",
    label: "Acaba em até 7 dias",
    short_label: "Acaba em até 7 dias",
    step_label: "produtos",
    severity: "critical",
    chart_color: "#f97316",
  },
  {
    key: "low",
    label: "Estoque baixo",
    short_label: "Estoque baixo",
    step_label: "produtos",
    severity: "warning",
    chart_color: "#eab308",
  },
  {
    key: "healthy",
    label: "Estoque em dia",
    short_label: "Estoque em dia",
    step_label: "produtos",
    severity: "success",
    chart_color: "#22c55e",
  },
  {
    key: "no_turnover",
    label: "Sem venda recente",
    short_label: "Sem venda recente",
    step_label: "produtos",
    severity: "neutral",
    chart_color: "#94a3b8",
  },
];

/** Chave interna — estoque desconhecido/não sincronizado (não entra em bucket visual). */
export const PRODUCT_HEALTH_STOCK_UNKNOWN_BUCKET_KEY = "__unknown_stock__";

/** Escopo temporal oficial — lucratividade dos produtos (histórico completo SUS7). */
export const PRODUCT_HEALTH_PROFITABILITY_SCOPE = "lifetime";

/** Faixas principais — Lucratividade dos Produtos (KPIs laterais + donut). */
export const PRODUCT_HEALTH_PROFITABILITY_MAIN_BANDS = [
  {
    key: "high_profit",
    label: "Alta lucratividade",
    short_label: "Alta lucratividade",
    step_label: "produtos",
    severity: "success",
    profit_range_label: "Margem acima de 30%",
    count_phrase_suffix: null,
    chart_color: "#16a34a",
    is_main_kpi: true,
  },
  {
    key: "profit",
    label: "Lucro",
    short_label: "Lucro",
    step_label: "produtos",
    severity: "info",
    profit_range_label: "Margem acima de 5% até 30%",
    count_phrase_suffix: null,
    chart_color: "#3b82f6",
    is_main_kpi: true,
  },
  {
    key: "low_profit",
    label: "Lucro baixo",
    short_label: "Lucro baixo",
    step_label: "produtos",
    severity: "warning",
    profit_range_label: "Margem de 0% a 5%",
    count_phrase_suffix: null,
    chart_color: "#f97316",
    is_main_kpi: true,
  },
  {
    key: "loss",
    label: "Prejuízo",
    short_label: "Prejuízo",
    step_label: "produtos",
    severity: "danger",
    profit_range_label: "Margem abaixo de 0%",
    count_phrase_suffix: null,
    chart_color: "#ef4444",
    is_main_kpi: true,
  },
  {
    key: "no_sales",
    label: "Sem vendas",
    short_label: "Sem vendas",
    step_label: "produtos",
    severity: "neutral",
    profit_range_label: null,
    count_phrase_suffix: "sem vendas",
    chart_color: "#94a3b8",
    is_main_kpi: true,
  },
];

/** Faixa auxiliar — venda sem dados financeiros confiáveis (não entra no donut principal). */
export const PRODUCT_HEALTH_PROFITABILITY_PENDING_BAND = {
  key: "financial_data_pending",
  label: "Dados financeiros pendentes",
  short_label: "Dados pendentes",
  step_label: "produtos",
  severity: "neutral",
  profit_range_label: null,
  count_phrase_suffix: null,
  chart_color: "#cbd5e1",
  is_main_kpi: false,
};

/** Todas as faixas — motor de buckets (5 principais + pendência financeira). */
export const PRODUCT_HEALTH_PROFITABILITY_BANDS = [
  ...PRODUCT_HEALTH_PROFITABILITY_MAIN_BANDS,
  PRODUCT_HEALTH_PROFITABILITY_PENDING_BAND,
];
