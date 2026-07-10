// ======================================================================
// Constantes — Central de Saúde da Concorrência (Dashboard).
// Estado atual do monitoramento + último snapshot válido.
// Unidade: anúncio/listing do seller (marketplace_listings).
// ======================================================================

/** Limite funcional de concorrentes monitorados por anúncio (paridade Concorrência). */
export const COMPETITION_HEALTH_MONITORING_LIMIT = 6;

/** Tolerância de preço competitivo acima do menor concorrente (%). */
export const COMPETITION_HEALTH_PRICE_TOLERANCE_PCT = 3;

/** Limite inferior de risco moderado — concorrente abaixo do seller (%). */
export const COMPETITION_HEALTH_RISK_MODERATE_PCT = 3;

/** Limite inferior de risco alto — concorrente abaixo do seller (%). */
export const COMPETITION_HEALTH_RISK_HIGH_PCT = 10;

export const COMPETITION_HEALTH_SCOPE = "current_monitoring_snapshot";

/** Vermelho/coral premium — família única para alertas negativos da seção. */
export const COMPETITION_HEALTH_ALERT_CORAL = "#e8a4a4";

/** Ordem exibida: completo → incompleto → sem concorrentes. */
/** @type {readonly { key: string; label: string; chart_color: string }[]} */
export const COMPETITION_HEALTH_MONITORING_BANDS = [
  {
    key: "complete_monitoring",
    label: "Monitoramento completo",
    chart_color: "#22c55e",
  },
  {
    key: "incomplete_monitoring",
    label: "Monitoramento incompleto",
    chart_color: "#f97316",
  },
  {
    key: "no_competitors",
    label: "Sem concorrentes",
    chart_color: COMPETITION_HEALTH_ALERT_CORAL,
  },
];

/** Somente anúncios com comparação válida (sem bucket “Sem comparação”). */
/** @type {readonly { key: string; label: string; chart_color: string }[]} */
export const COMPETITION_HEALTH_PRICE_POSITION_BANDS = [
  {
    key: "cheaper",
    label: "Mais baratos",
    chart_color: "#22c55e",
  },
  {
    key: "competitive",
    label: "Competitivos",
    chart_color: "#3b82f6",
  },
  {
    key: "more_expensive",
    label: "Mais caros",
    chart_color: COMPETITION_HEALTH_ALERT_CORAL,
  },
];

/** Reputação dos concorrentes — um bucket por concorrente (prioridade fixa). */
/** @type {readonly { key: string; label: string; chart_color: string }[]} */
export const COMPETITION_HEALTH_REPUTATION_BANDS = [
  {
    key: "platinum",
    label: "Platinum",
    chart_color: "#475569",
  },
  {
    key: "gold",
    label: "Gold",
    chart_color: "#d97706",
  },
  {
    key: "mercado_lider",
    label: "MercadoLíder",
    chart_color: "#3b82f6",
  },
  {
    key: "green_reputation",
    label: "Reputação verde",
    chart_color: "#22c55e",
  },
  {
    key: "no_reputation",
    label: "Sem reputação",
    chart_color: "#94a3b8",
  },
];

export const COMPETITION_HEALTH_PRICE_BASE_LABEL = "Comparados";
export const COMPETITION_HEALTH_REPUTATION_BASE_LABEL = "Concorrentes analisados";

/** @deprecated engine legada — não renderizada no Dashboard */
/** @type {readonly { key: string; label: string; chart_color: string }[]} */
export const COMPETITION_HEALTH_RISK_BANDS = [
  {
    key: "high_risk",
    label: "Risco alto",
    chart_color: COMPETITION_HEALTH_ALERT_CORAL,
  },
  {
    key: "moderate_risk",
    label: "Risco moderado",
    chart_color: "#f97316",
  },
  {
    key: "competitive",
    label: "Competitivos",
    chart_color: "#22c55e",
  },
];

/** @deprecated */
export const COMPETITION_HEALTH_RISK_BASE_LABEL = "Anúncios analisados";
