// ======================================================================
// KPI Giro dos Produtos — Central de Saúde dos Produtos (Dashboard).
// Janela interna de 15d; não obedece filtro de período do Dashboard.
// ======================================================================

import Decimal from "decimal.js";
import { PRODUCT_HEALTH_TURNOVER_WINDOW_DAYS } from "./productHealthConstants.js";
import { formatPercentFromRatio } from "./productHealthNumericHelpers.js";

/**
 * @param {Record<string, unknown>} snapshot
 */
export function produtoTeveVendaNaJanela(snapshot) {
  const qtyWindow = Number(snapshot.qty_turnover_window ?? snapshot.qty_dead_window ?? 0) || 0;
  return qtyWindow > 0;
}

/**
 * @param {Array<Record<string, unknown>>} snapshots
 * @param {number} [windowDays]
 */
export function montarKpiGiroProdutos(snapshots, windowDays = PRODUCT_HEALTH_TURNOVER_WINDOW_DAYS) {
  const totalProducts = snapshots.length;
  let productsWithSalesInWindow = 0;

  for (const snapshot of snapshots) {
    if (produtoTeveVendaNaJanela(snapshot)) productsWithSalesInWindow += 1;
  }

  const percent =
    totalProducts > 0
      ? formatPercentFromRatio(
          new Decimal(productsWithSalesInWindow),
          new Decimal(totalProducts),
        )
      : "0.00";

  return {
    title: "Giro dos Produtos",
    products_with_sales_in_window: productsWithSalesInWindow,
    total_products: totalProducts,
    percent,
    window_days: windowDays,
    subtitle: `${productsWithSalesInWindow} de ${totalProducts} produtos venderam nos últimos ${windowDays} dias`,
    sales_source: "sales_order_items+sales_orders.date_created_marketplace",
  };
}
