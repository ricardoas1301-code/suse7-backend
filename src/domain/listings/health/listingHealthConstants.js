// ======================================================================
// Constantes SSOT — Central de Saúde dos Anúncios (Dashboard + filtros futuros).
// ======================================================================

/** % mínimo de margem saudável (paridade catálogo produtos / filtro margem baixa). */
export const LISTING_HEALTH_HEALTHY_MARGIN_MIN_PCT = 10;

/** Estoque ≤ este valor (e > 0) = estoque crítico. */
export const LISTING_HEALTH_CRITICAL_STOCK_THRESHOLD = 3;

/** Saúde de cadastro — faixas de score (0–100). */
export const LISTING_HEALTH_REGISTRATION_ATTENTION_MIN = 70;
export const LISTING_HEALTH_REGISTRATION_HEALTHY_MIN = 90;

/** Máximo de itens por card no Dashboard. */
export const LISTING_HEALTH_DASHBOARD_CARD_ITEMS_LIMIT = 5;

/** Período padrão da saúde comercial (Dashboard V1). */
export const LISTING_HEALTH_DEFAULT_COMMERCIAL_PRESET = "lifetime";

/** Faixas de distribuição — card Saúde comercial (margem histórica/lifetime). */
export const LISTING_HEALTH_COMMERCIAL_DISTRIBUTION_BANDS = [
  {
    key: "excellent_margin",
    label: "Margem excelente",
    short_label: "≥30%",
    severity: "success",
  },
  {
    key: "healthy_margin",
    label: "Margem saudável",
    short_label: "20–29%",
    severity: "success",
  },
  {
    key: "attention_margin",
    label: "Margem de atenção",
    short_label: "10–19%",
    severity: "warning",
  },
  {
    key: "critical_margin",
    label: "Margem crítica",
    short_label: "0–9%",
    severity: "critical",
  },
  {
    key: "negative_margin",
    label: "Vendendo com prejuízo",
    short_label: "Prejuízo",
    severity: "danger",
  },
  {
    key: "no_commercial_data",
    label: "Sem histórico comercial",
    short_label: "Sem dados",
    severity: "neutral",
  },
];

/** Faixas de distribuição — card Saúde do cadastro (Dashboard). Score 0–100. */
export const LISTING_HEALTH_REGISTRATION_DISTRIBUTION_BANDS = [
  { key: "complete", label: "100% completos", min_score: 100, max_score: 100 },
  { key: "excellent", label: "90% a 99%", min_score: 90, max_score: 99.99 },
  { key: "attention", label: "70% a 89%", min_score: 70, max_score: 89.99 },
  { key: "critical", label: "50% a 69%", min_score: 50, max_score: 69.99 },
  { key: "urgent", label: "Abaixo de 50%", min_score: 0, max_score: 49.99 },
];

/** Faixas de distribuição — card Saúde operacional (Dashboard). */
export const LISTING_HEALTH_OPERATIONAL_DISTRIBUTION_BANDS = [
  { key: "active", label: "Ativos", short_label: "Ativos", step_label: "ativos", severity: "success" },
  {
    key: "critical_stock",
    label: "Estoque crítico",
    short_label: "Crítico",
    step_label: "críticos",
    severity: "warning",
  },
  {
    key: "zero_stock",
    label: "Sem estoque",
    short_label: "Sem estoque",
    step_label: "sem estoque",
    severity: "critical",
  },
  { key: "paused", label: "Pausados", short_label: "Pausados", step_label: "pausados", severity: "warning" },
  { key: "inactive", label: "Inativos", short_label: "Inativos", step_label: "inativos", severity: "neutral" },
];
