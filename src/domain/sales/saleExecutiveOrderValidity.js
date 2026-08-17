// ======================================================================
// Regras de elegibilidade de pedidos para métricas executivas (P_2.1.x).
// ======================================================================

/** Status excluídos (Mercado Livre + genéricos). */
const EXCLUDED_ORDER_STATUSES = new Set([
  "cancelled",
  "canceled",
  "refunded",
  "invalid",
  "rejected",
  "payment_rejected",
  "payment_refunded",
  "charged_back",
]);

/**
 * @param {string | null | undefined} orderStatus
 * @param {string | null | undefined} [orderSubstatus]
 */
export function isExecutiveSummaryEligibleOrder(orderStatus, orderSubstatus) {
  const s = orderStatus != null ? String(orderStatus).trim().toLowerCase() : "";
  const sub = orderSubstatus != null ? String(orderSubstatus).trim().toLowerCase() : "";
  if (s && EXCLUDED_ORDER_STATUSES.has(s)) return false;
  if (sub && EXCLUDED_ORDER_STATUSES.has(sub)) return false;
  return true;
}

/**
 * @param {Record<string, unknown> | null | undefined} order
 */
export function isExecutiveSummaryEligibleOrderRow(order) {
  if (!order || typeof order !== "object") return true;
  const sub =
    order.order_substatus != null
      ? String(order.order_substatus)
      : order.raw_json &&
          typeof order.raw_json === "object" &&
          /** @type {Record<string, unknown>} */ (order.raw_json).status_detail != null
        ? String(/** @type {Record<string, unknown>} */ (order.raw_json).status_detail)
        : null;
  return isExecutiveSummaryEligibleOrder(
    order.order_status != null ? String(order.order_status) : null,
    sub,
  );
}
