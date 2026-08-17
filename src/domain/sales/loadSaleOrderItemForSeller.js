// =============================================================================
// Carrega item de venda com ownership do seller (Raio-X / notificações manuais)
// =============================================================================

import { buildVendasUiRowsFromOrderItems } from "../../handlers/sales/list.js";
import { buildSaleDetailFinancialBreakdown } from "../../handlers/sales/saleDetailFinancial.js";
import { buildSaleRayxNotificationPayload } from "./saleRayxNotificationPayload.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {string} saleItemId
 */
export async function loadSaleOrderItemForSeller(supabase, sellerId, saleItemId) {
  const itemId = String(saleItemId ?? "").trim();
  if (!itemId) return { ok: false, error: "INVALID_SALE_ID" };

  const { data: item, error } = await supabase
    .from("sales_order_items")
    .select("*")
    .eq("user_id", sellerId)
    .eq("id", itemId)
    .maybeSingle();

  if (error) return { ok: false, error: "SALE_LOAD_FAILED", message: error.message };
  if (!item) return { ok: false, error: "SALE_NOT_FOUND" };

  const [uiRow] = await buildVendasUiRowsFromOrderItems(supabase, sellerId, [item]);
  /** Linha UI quando disponível; senão o próprio item (notificação não deve falhar por hidratação). */
  const row = uiRow ?? item;

  let order = null;
  const orderId = item.sales_order_id != null ? String(item.sales_order_id) : null;
  if (orderId) {
    const { data: ord } = await supabase
      .from("sales_orders")
      .select("id,order_status,external_order_id,raw_json,marketplace_account_id,marketplace,seller_company_id")
      .eq("user_id", sellerId)
      .eq("id", orderId)
      .maybeSingle();
    if (ord) order = ord;
  }

  const itemRaw =
    item?.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;
  const itemFin =
    itemRaw?._s7_financial && typeof itemRaw._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (itemRaw._s7_financial)
      : null;
  const internalCostsSnapshot =
    itemFin?.internal_costs_snapshot && typeof itemFin.internal_costs_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (itemFin.internal_costs_snapshot)
      : null;
  const hasInternalSnapshotAmounts =
    internalCostsSnapshot != null &&
    (
      internalCostsSnapshot.product_cost_brl != null ||
      internalCostsSnapshot.internal_tax_brl != null ||
      internalCostsSnapshot.operation_packaging_cost_brl != null
    );
  const snapshotMissing = !hasInternalSnapshotAmounts;

  // SSOT historico: sem snapshot de custo interno, nao busca produto/imposto atuais.
  const baseFinancialBreakdown = buildSaleDetailFinancialBreakdown(item, null, order, null, {});
  const financialBreakdown = {
    ...baseFinancialBreakdown,
    snapshot_missing: snapshotMissing,
    pricing_variables_source: snapshotMissing
      ? "snapshot_missing_no_live_recalculation"
      : "historical_financial_snapshot",
    snapshot_origin:
      itemFin?.snapshot_origin != null ? String(itemFin.snapshot_origin) : null,
    snapshot_quality:
      itemFin?.snapshot_quality != null ? String(itemFin.snapshot_quality) : null,
    estimated: typeof itemFin?.estimated === "boolean" ? itemFin.estimated : null,
  };

  const productTitle =
    (uiRow?.product_title != null && String(uiRow.product_title).trim() !== ""
      ? String(uiRow.product_title).trim()
      : null) ??
    (uiRow?.title != null && String(uiRow.title).trim() !== ""
      ? String(uiRow.title).trim()
      : null) ??
    (item.title_snapshot != null && String(item.title_snapshot).trim() !== ""
      ? String(item.title_snapshot).trim()
      : "—");

  const notificationPayload = buildSaleRayxNotificationPayload({
    saleItemId: itemId,
    productTitle,
    financialBreakdown,
    order,
    externalOrderId: order?.external_order_id ?? uiRow?.external_order_id ?? null,
  });

  return {
    ok: true,
    item,
    row: uiRow ?? null,
    order,
    product: null,
    financialBreakdown,
    notificationPayload,
    marketplace_account_id: item.marketplace_account_id ?? order?.marketplace_account_id ?? null,
  };
}
