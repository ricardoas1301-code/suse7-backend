// =============================================================================
// Template payload — resumo executivo para SALES:DAILY_SALES_SUMMARY
// =============================================================================

import { formatDailySalesSummaryPeriodLabel } from "./dailySalesSummaryWindow.js";

/**
 * @param {number | string | null | undefined} raw
 */
function formatBrlDisplay(raw) {
  if (raw == null || String(raw).trim() === "") return "—";
  const n = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * @param {number | string | null | undefined} raw
 */
function formatPctDisplay(raw) {
  if (raw == null || String(raw).trim() === "") return "—";
  const n = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} %`;
}

/**
 * @param {Record<string, unknown> | null | undefined} executivePayload
 * @param {{ period_start: Date; period_end: Date }} window
 */
export function buildDailySalesSummaryTemplatePayload(executivePayload, window) {
  const summary =
    executivePayload?.summary && typeof executivePayload.summary === "object"
      ? /** @type {Record<string, unknown>} */ (executivePayload.summary)
      : {};

  const ordersCount = Number(summary.orders_count ?? 0);
  const periodo = formatDailySalesSummaryPeriodLabel(window.period_start, window.period_end);

  return {
    periodo,
    conta: "Todas as contas",
    vendas: String(ordersCount),
    faturamento: formatBrlDisplay(summary.gross_sales_brl),
    lucro: formatBrlDisplay(summary.contribution_profit_brl),
    margem: formatPctDisplay(summary.contribution_margin_percent),
    notification_event_type: "SALES:DAILY_SALES_SUMMARY",
    period_start: window.period_start.toISOString(),
    period_end: window.period_end.toISOString(),
  };
}

/**
 * @param {string} sellerId
 * @param {Date} scheduledAt
 */
export function buildDailySalesSummaryIdempotencyKey(sellerId, scheduledAt) {
  return `daily.sales-summary:${sellerId}:${scheduledAt.toISOString()}`;
}
