// =============================================================================
// Payload de notificação — Raio-X da Venda (dados persistidos, Fase 3.5C.1.A3)
// =============================================================================

import { config } from "../../infra/config.js";

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatMoneyBrl(value) {
  if (value == null || value === "") return "—";
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * @param {Record<string, unknown> | null | undefined} order
 */
function resolveBuyerName(order) {
  const raw =
    order?.raw_json && typeof order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (order.raw_json)
      : null;
  if (!raw) return "—";
  const buyer =
    raw.buyer && typeof raw.buyer === "object"
      ? /** @type {{ nickname?: string; first_name?: string; last_name?: string }} */ (raw.buyer)
      : null;
  const parts = [buyer?.first_name, buyer?.last_name].filter(Boolean).map(String);
  if (parts.length) return parts.join(" ").trim();
  if (buyer?.nickname) return String(buyer.nickname).trim();
  return "—";
}

/**
 * @param {string} saleItemId
 */
export function buildSaleRayxUrl(saleItemId) {
  const base = String(config.frontendUrl ?? "").replace(/\/+$/, "");
  if (!base) return `/vendas?sale=${encodeURIComponent(saleItemId)}`;
  return `${base}/vendas?sale=${encodeURIComponent(saleItemId)}`;
}

/**
 * @param {{
 *   saleItemId: string;
 *   productTitle?: string | null;
 *   financialBreakdown?: Record<string, unknown> | null;
 *   order?: Record<string, unknown> | null;
 *   externalOrderId?: string | null;
 * }} input
 */
export function buildSaleRayxNotificationPayload(input) {
  const fin = input.financialBreakdown ?? {};
  const mr =
    fin.marketplace_revenue && typeof fin.marketplace_revenue === "object"
      ? /** @type {Record<string, unknown>} */ (fin.marketplace_revenue)
      : {};
  const health =
    fin.health_ui && typeof fin.health_ui === "object"
      ? /** @type {{ health_label?: string }} */ (fin.health_ui)
      : fin.health_label != null
        ? { health_label: String(fin.health_label) }
        : {};

  const saleId =
    input.externalOrderId != null && String(input.externalOrderId).trim() !== ""
      ? String(input.externalOrderId).replace(/^#/, "")
      : String(input.saleItemId).slice(0, 8);

  return {
    sale_id: saleId,
    sale_item_id: String(input.saleItemId),
    product_title: input.productTitle != null ? String(input.productTitle) : "—",
    buyer_name: resolveBuyerName(input.order),
    sale_amount: formatMoneyBrl(mr.gross_amount ?? fin.gross_amount),
    received_amount: formatMoneyBrl(mr.net_received_amount ?? fin.net_received_amount),
    profit_amount: formatMoneyBrl(fin.profit_amount ?? fin.real_profit),
    margin_percent:
      fin.margin_percent != null && String(fin.margin_percent).trim() !== ""
        ? String(fin.margin_percent).replace("%", "").trim()
        : "—",
    sale_health: health.health_label != null ? String(health.health_label) : "—",
    sale_rayx_url: buildSaleRayxUrl(input.saleItemId),
    source: "sale_rayx_modal_manual",
  };
}
