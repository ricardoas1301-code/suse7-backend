// ======================================================
// View-model `product_card_metrics` — card lateral Precificação Inteligente
// Fonte primária: sales_order_items (historicalCardOrderItemsAggregates).
// Fallback: listing_sales_metrics na grid (join por external_listing_id).
// ======================================================

import {
  externalListingIdKeyVariants,
  getListingGridRow,
  listingGridJoinKey,
  normalizeMarketplaceSlug,
} from "./listingGridJoinKeys.js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import { historicalCardSalesAggToPayload } from "../../../domain/sales/historicalCardOrderItemsAggregates.js";
import {
  applyAccountFieldsToGridRow,
  resolveMarketplaceAccountDisplayNameById,
} from "./listingGridAccountEnrich.js";

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function toIntOrNull(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} brlRaw
 * @returns {string | null}
 */
function meaningfulSalesAmountBrl(brlRaw) {
  if (brlRaw == null || String(brlRaw).trim() === "") return null;
  const s = String(brlRaw).trim();
  const n = Number(s.replace(",", "."));
  if (Number.isFinite(n) && n === 0) return null;
  return s;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
function marketplaceAccountIdFromRow(row) {
  const raw = row.marketplace_account_id ?? row.marketplaceAccountId;
  return raw != null && String(raw).trim() !== "" ? String(raw).trim() : null;
}

/**
 * @param {Record<string, unknown>} metricsRow
 * @returns {{ qty: number | null; grossBrl: string | null }}
 */
function salesFromMetricsRow(metricsRow) {
  const qty = toIntOrNull(metricsRow.qty_sold_total);
  const grossBrl =
    metricsRow.gross_revenue_total != null && String(metricsRow.gross_revenue_total).trim() !== ""
      ? meaningfulSalesAmountBrl(String(metricsRow.gross_revenue_total).trim())
      : null;
  return { qty, grossBrl };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Map<string, Record<string, unknown>> | null | undefined} metricsByKey
 * @returns {{ qty: number | null; grossBrl: string | null }}
 */
/**
 * Fallback de vendas do anúncio — só fontes Suse7 (listing_sales_metrics / pedidos importados).
 * Não usa sold_quantity ML (evita "0" falso no card quando há histórico em sales_order_items).
 * @param {Record<string, unknown>} row
 * @param {Map<string, Record<string, unknown>> | null | undefined} metricsByKey
 */
function salesFallbackFromGridRow(row, metricsByKey) {
  if (metricsByKey) {
    const met = getListingGridRow(metricsByKey, row.marketplace, row.external_listing_id);
    if (met) return salesFromMetricsRow(met);
  }

  const legacy =
    row.legacy_imported_orders_metrics != null && typeof row.legacy_imported_orders_metrics === "object"
      ? /** @type {Record<string, unknown>} */ (row.legacy_imported_orders_metrics)
      : null;
  if (legacy) {
    return {
      qty: toIntOrNull(legacy.qty_sold_total),
      grossBrl: meaningfulSalesAmountBrl(legacy.gross_revenue_brl),
    };
  }

  const grossBrl =
    !row.gross_revenue_missing && row.gross_revenue_brl != null
      ? meaningfulSalesAmountBrl(row.gross_revenue_brl)
      : null;
  if (grossBrl != null) {
    return { qty: null, grossBrl };
  }
  return { qty: null, grossBrl: null };
}

/**
 * @param {Map<string, string | null>} map
 * @param {unknown} marketplace
 * @param {unknown} externalListingId
 * @returns {string | null}
 */
function getStringByListingKey(map, marketplace, externalListingId) {
  const primary = normalizeMarketplaceSlug(marketplace);
  const mkTry = primary === ML_MARKETPLACE_SLUG ? [primary] : [primary, ML_MARKETPLACE_SLUG];
  for (const mkt of mkTry) {
    for (const v of externalListingIdKeyVariants(externalListingId)) {
      const hit = map.get(listingGridJoinKey(mkt, v));
      if (hit != null && String(hit).trim() !== "") return String(hit).trim();
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Map<string, { alias: string | null; logoUrl: string | null }> | undefined} accountById
 * @param {Map<string, string | null> | undefined} accountAliasByListingKey
 * @returns {string | null}
 */
/**
 * @param {Map<string, string> | null | undefined} accountIdByListingKey
 */
function accountDisplayNameForRow(row, accountById, accountAliasByListingKey, accountIdByListingKey) {
  let accountId = marketplaceAccountIdFromRow(row);
  if (!accountId && accountIdByListingKey != null) {
    const fromVotes = getStringByListingKey(
      accountIdByListingKey,
      row.marketplace,
      row.external_listing_id
    );
    if (fromVotes) accountId = fromVotes;
  }
  if (accountId && accountById) {
    return resolveMarketplaceAccountDisplayNameById(accountId, accountById);
  }

  const direct =
    row.account_alias != null && String(row.account_alias).trim() !== ""
      ? String(row.account_alias).trim()
      : row.ml_account_alias != null && String(row.ml_account_alias).trim() !== ""
        ? String(row.ml_account_alias).trim()
        : null;
  if (direct) return direct;

  const fromOrderItems =
    accountAliasByListingKey != null
      ? getStringByListingKey(accountAliasByListingKey, row.marketplace, row.external_listing_id)
      : null;
  if (fromOrderItems != null && String(fromOrderItems).trim() !== "") {
    return String(fromOrderItems).trim();
  }

  return null;
}

/**
 * @param {Record<string, unknown>[]} gridRows
 * @param {{
 *   orderItemsMaps?: {
 *     byListingKey?: Map<string, { qtyUnits: number; gross: import("decimal.js").default; profit: import("decimal.js").default; profitLines: number }>;
 *     byProductId?: Map<string, { qtyUnits: number; gross: import("decimal.js").default; profit: import("decimal.js").default; profitLines: number }>;
 *     accountAliasByListingKey?: Map<string, string | null>;
 *     accountIdByListingKey?: Map<string, string>;
 *   } | null;
 *   metricsByKey?: Map<string, Record<string, unknown>>;
 *   accountById?: Map<string, { alias: string | null; logoUrl: string | null }>;
 *   listings?: Record<string, unknown>[];
 * } | null | undefined} [opts]
 */
/** Métricas vazias — catálogo segue mesmo se agregação histórica falhar. */
export function emptyProductCardMetrics(row = null) {
  const listingType =
    row != null && row.listing_type_label != null ? String(row.listing_type_label) : null;
  return {
    accountDisplayName: null,
    listingType,
    listingSalesCount: null,
    listingSalesAmountBrl: null,
    listingProfitBrl: null,
    listingProfitPercent: null,
    productSalesCount: null,
    productSalesAmountBrl: null,
    productProfitBrl: null,
    productProfitPercent: null,
  };
}

export function enrichListingGridRowsWithProductCardMetrics(gridRows, opts = null) {
  if (!Array.isArray(gridRows) || gridRows.length === 0) return;

  const metricsByKey = opts?.metricsByKey ?? null;
  const accountById = opts?.accountById;
  const orderMaps = opts?.orderItemsMaps ?? null;
  const byListingKey = orderMaps?.byListingKey ?? null;
  const byProductId = orderMaps?.byProductId ?? null;
  const accountAliasByListingKey = orderMaps?.accountAliasByListingKey;
  const accountIdByListingKey = orderMaps?.accountIdByListingKey ?? null;
  const listings = opts?.listings ?? null;

  for (let rowIndex = 0; rowIndex < gridRows.length; rowIndex++) {
    const row = gridRows[rowIndex];
    try {
      const pid = row.product_id != null ? String(row.product_id).trim() : "";

      const listingAgg =
        byListingKey != null
          ? getListingGridRow(byListingKey, row.marketplace, row.external_listing_id)
          : undefined;
      const listingFromItems = historicalCardSalesAggToPayload(listingAgg);

      const listingFallback = salesFallbackFromGridRow(row, metricsByKey);
      const listingSalesCount =
        listingFromItems.salesCount != null
          ? listingFromItems.salesCount
          : listingFallback.qty != null && listingFallback.qty > 0
            ? listingFallback.qty
            : null;
      const listingSalesAmountBrl =
        listingFromItems.salesAmountBrl != null
          ? listingFromItems.salesAmountBrl
          : meaningfulSalesAmountBrl(listingFallback.grossBrl);

      const productAgg = pid && byProductId ? byProductId.get(pid) : undefined;
      const productFromItems = historicalCardSalesAggToPayload(productAgg);

      const accountDisplayName = accountDisplayNameForRow(
        row,
        accountById,
        accountAliasByListingKey,
        accountIdByListingKey
      );

      row.product_card_metrics = {
        accountDisplayName,
        listingType: row.listing_type_label != null ? String(row.listing_type_label) : null,
        listingSalesCount,
        listingSalesAmountBrl,
        listingProfitBrl: listingFromItems.profitBrl,
        listingProfitPercent: listingFromItems.profitPercent,
        productSalesCount: productFromItems.salesCount,
        productSalesAmountBrl: productFromItems.salesAmountBrl,
        productProfitBrl: productFromItems.profitBrl,
        productProfitPercent: productFromItems.profitPercent,
      };

      const listingRef =
        listings != null &&
        listings[rowIndex] != null &&
        typeof listings[rowIndex] === "object"
          ? /** @type {Record<string, unknown>} */ (listings[rowIndex])
          : null;
      applyAccountFieldsToGridRow(row, listingRef, accountById, {
        accountIdByListingKey: orderMaps?.accountIdByListingKey,
        accountAliasByListingKey: orderMaps?.accountAliasByListingKey,
      });
    } catch (rowErr) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[Suse7][API][ml-listings] product_card_metrics_row_failed", {
          external_listing_id: row?.external_listing_id ?? null,
          message: rowErr?.message ?? String(rowErr),
        });
      }
      row.product_card_metrics = emptyProductCardMetrics(row);
    }
  }
}
