// ======================================================================
// Agregação executiva de vendas — Decimal.js, contrato P_2.1.1 / P_2.1.2.
// ======================================================================

import Decimal from "decimal.js";
import { normalizeSkuForDbLookup } from "../productCatalogCompleteness.js";
import {
  saleDetailMoneyToDecimal as toDecimal,
  saleDetailMoneyDecimal as moneyDecimal,
  saleDetailToQty as toQty,
} from "./saleDetailInternalCosts.js";
import { isExecutiveSummaryEligibleOrderRow } from "./saleExecutiveOrderValidity.js";
import { orderMatchesExecutivePeriod } from "./saleExecutivePeriod.js";
import { matchesExecutiveSalesFilter } from "./saleExecutiveFilters.js";
import {
  enrichExecutiveListingRankingRows,
  pickHydratedRowImageUrl,
} from "./executiveRankingImageUrl.js";
import { resolveExecutiveRankingListingId } from "./saleExecutiveListingKey.js";
import { computeExecutiveLineRealProfit } from "./saleExecutiveLineRealResult.js";
import {
  buildExecutiveMinimalUiRowsFromItems,
  isExecutiveSummaryDevAutoDebugEnabled,
  iterateExecutiveSummaryBatches,
  logExecutiveSummaryZeroDebug,
  pickExecutiveDebugHydratedSnapshot,
  pickExecutiveDebugItemSnapshot,
  pickExecutiveDebugOrderSnapshot,
} from "./saleExecutiveSourceItems.js";
import {
  executiveSummaryElapsedMs,
  logExecutiveSummaryBuildReady,
  logExecutiveSummarySourceReady,
} from "./saleExecutiveSummaryTelemetry.js";
import { hydrateExecutiveSummaryRankingRows } from "../../handlers/sales/list.js";
import { createExecutiveSummaryPerf } from "./saleExecutiveSummaryPerf.js";
import {
  fetchExternalListingProductMap,
  logS7ProductPerformance,
  resolveExecutiveProductScope,
} from "./saleExecutiveProductScope.js";

/**
 * ID de catálogo (marketplace_listings.external_listing_id) quando disponível.
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown>} row
 * @param {string} listingId
 */
function pickExternalListingIdForCatalog(item, row, listingId) {
  const fromItem = item.external_listing_id != null ? String(item.external_listing_id).trim() : "";
  if (fromItem) return fromItem;
  const fromRow =
    row.external_listing_id != null
      ? String(row.external_listing_id).trim()
      : row.listing_id_display != null
        ? String(row.listing_id_display).trim()
        : "";
  if (fromRow) return fromRow;
  const lid = listingId != null ? String(listingId).trim() : "";
  if (!lid || /^(title:|line:|sku:|pid:)/i.test(lid)) return "";
  return lid;
}

/**
 * @param {{
 *   marketplace?: string | null;
 *   marketplace_account_id?: string | null;
 *   seller_company_id?: string | null;
 *   q?: string | null;
 *   filter?: string | null;
 *   product_id?: string | null;
 *   period?: { start_ms: number | null; end_ms_exclusive: number | null; start_date: string | null; end_date: string | null; preset: string };
 *   ranking_limit?: number;
 * }} filters
 */
export function buildEmptyExecutiveSummaryPayload(filters = {}) {
  const period = filters.period ?? {
    start_date: null,
    end_date: null,
    preset: "60d",
    start_ms: null,
    end_ms_exclusive: null,
  };
  return {
    ok: true,
    period: {
      start_date: period.start_date,
      end_date: period.end_date,
      preset: period.preset,
    },
    filters_applied: {
      marketplace: filters.marketplace ?? null,
      marketplace_account_id: filters.marketplace_account_id ?? null,
      seller_company_id: filters.seller_company_id ?? null,
      filter: filters.filter ?? "all",
      q: filters.q ?? null,
      product_id: filters.product_id ?? null,
      product_sku: filters.product_scope?.sku ?? null,
      linked_listings_count: filters.product_scope?.listing_count ?? null,
    },
    summary: {
      gross_sales_brl: "0.00",
      orders_count: 0,
      orders_in_progress_count: 0,
      items_quantity_sold: 0,
      average_ticket_brl: null,
      highest_order_gross_brl: null,
      net_received_brl: "0.00",
      gross_profit_brl: null,
      net_profit_brl: "0.00",
      contribution_profit_brl: "0.00",
      contribution_margin_percent: "0.00",
      marketplace_fee_brl: null,
      shipping_cost_brl: null,
      tax_cost_brl: null,
      ads_cost_brl: null,
      product_cost_only_brl: null,
      operation_packaging_cost_brl: null,
      operational_costs_brl: null,
      internal_costs_brl: null,
      total_costs_brl: null,
      you_receive_brl: "0.00",
      visits_count: null,
      sales_conversion_rate_percent: null,
      conversion_data_status: "unavailable",
    },
    rankings: {
      listings: [],
      listings_by_quantity: [],
      listings_by_gross_revenue: [],
      listings_by_net_profit: [],
      products: [],
    },
    health: {
      negative_sales_count: 0,
      low_margin_count: 0,
      needs_attention_count: 0,
    },
    distribution: {
      by_account: [],
    },
    data_quality: {
      status: "complete",
      warnings: [],
    },
    truncated_scan: false,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   marketplace?: string | null;
 *   marketplace_account_id?: string | null;
 *   seller_company_id?: string | null;
 *   q?: string | null;
 *   filter?: string | null;
 *   period: { start_ms: number | null; end_ms_exclusive: number | null; start_date: string | null; end_date: string | null; preset: string };
 *   ranking_limit?: number;
 * }} filters
 * @param {{ startedAt?: number; perf?: ReturnType<typeof createExecutiveSummaryPerf> }} [options]
 */
export async function buildSaleExecutiveSummary(supabase, userId, filters, options = {}) {
  const startedAt = options.startedAt;
  const perf = options.perf ?? createExecutiveSummaryPerf(startedAt ?? Date.now());
  const listingRankingLimit = Math.min(10, Math.max(1, filters.ranking_limit ?? 10));
  const productRankingLimit =
    filters.product_ranking_limit != null
      ? Math.min(10000, Math.max(1, Math.floor(Number(filters.product_ranking_limit)) || 1))
      : listingRankingLimit;
  const rankingLimit = listingRankingLimit;
  const empty = () => buildEmptyExecutiveSummaryPayload(filters);

  /** @type {import("./saleExecutiveProductScope.js").ExecutiveProductScope | null} */
  let productScope = null;
  if (filters.product_id) {
    productScope = await resolveExecutiveProductScope(supabase, userId, filters.product_id);
    filters = { ...filters, product_scope: productScope };
    if (productScope.listing_count === 0) {
      logS7ProductPerformance(productScope, {
        sales_count: 0,
        revenue: "0.00",
        profit: "0.00",
        margin: "0.00",
        source: "executive-summary",
      });
      const payload = empty();
      payload.data_quality = {
        status: "complete",
        warnings: ["Produto sem anúncios vinculados em marketplace_listings."],
      };
      return payload;
    }
  }

  const listingProductMap = filters.product_id
    ? null
    : await fetchExternalListingProductMap(supabase, userId);

  const debugQuery = {
    product_id: filters.product_id ?? null,
    marketplace: filters.marketplace ?? null,
    marketplace_account_id: filters.marketplace_account_id ?? null,
    seller_company_id: filters.seller_company_id ?? null,
    q: filters.q ?? null,
    filter: filters.filter ?? "all",
    period_preset: filters.period?.preset ?? null,
    period_start_date: filters.period?.start_date ?? null,
    period_end_date: filters.period?.end_date ?? null,
    ranking_limit: rankingLimit,
    product_ranking_limit: productRankingLimit,
  };

  let sourceItemsCount = 0;
  let sourceOrdersCount = 0;
  let totalEligibleItems = 0;
  let hydratedRowsCount = 0;
  let skippedInvalid = 0;
  let skippedPeriod = 0;
  let skippedMissingOrder = 0;
  let firstSourceItem = null;
  let firstSourceOrder = null;
  let firstHydratedRow = null;
  /** @type {Set<string>} */
  const eligibleOrderIds = new Set();
  let hydrationDegraded = false;
  let hydrationStarted = false;
  let profitCalcStarted = false;

  let grossTotal = new Decimal(0);
  let netTotal = new Decimal(0);
  let profitTotal = new Decimal(0);
  let profitLinesWithValue = 0;
  let unitsTotal = 0;
  /** @type {Set<string>} */
  const uniqueOrders = new Set();
  /** @type {Map<string, Decimal>} */
  const orderGrossAgg = new Map();
  /** @type {Set<string>} */
  const inProgressOrders = new Set();
  let feeTotal = new Decimal(0);
  let shippingTotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  let adsTotal = new Decimal(0);
  let hasFeeData = false;
  let hasShippingData = false;
  let hasTaxData = false;
  let hasAdsData = false;
  let productCostTotal = new Decimal(0);
  let hasProductCostData = false;
  let operationPackagingTotal = new Decimal(0);
  let hasOperationPackagingData = false;
  let operationalCostsTotal = new Decimal(0);
  let hasOperationalCostsData = false;

  let negativeCount = 0;
  let lowMarginCount = 0;
  let needsAttentionCount = 0;
  let partialCostLines = 0;
  /** @type {Set<string>} */
  const snapshotOriginSet = new Set();
  /** @type {Set<string>} */
  const snapshotQualitySet = new Set();
  /** @type {Set<boolean>} */
  const snapshotEstimatedSet = new Set();

  /** @type {Map<string, Record<string, unknown>>} */
  const listingAgg = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const productAgg = new Map();
  // Distribuição por conta (P_2.8.12C) — apenas contagens, sem cálculo monetário.
  /** @type {Map<string, { marketplace_account_id: string | null; seller_company_id: string | null; orders: Set<string>; items_quantity_sold: number }>} */
  const accountAgg = new Map();

  let skippedFilterChip = 0;
  let skippedNoMoney = 0;
  let skippedNoListingKey = 0;
  let skippedLineErrors = 0;
  /** @type {string[]} */
  const firstValidOrderKeys = [];

  /** @type {Map<string, string>} */
  const bestImageByListingKey = new Map();

  perf.mark("sales_query_start");
  try {
    for await (const batch of iterateExecutiveSummaryBatches(supabase, userId, filters)) {
      sourceItemsCount += batch.items.length;
      sourceOrdersCount = batch.totalOrderIds;

      if (firstSourceItem == null && batch.items.length > 0) {
        firstSourceItem = pickExecutiveDebugItemSnapshot(batch.items[0]);
        const oid0 =
          batch.items[0]?.sales_order_id != null ? String(batch.items[0].sales_order_id) : "";
        firstSourceOrder = pickExecutiveDebugOrderSnapshot(
          oid0 ? batch.ordersById.get(oid0) ?? null : null,
        );
      }

      const batchOrdersById = batch.ordersById;
      /** @type {Record<string, unknown>[]} */
      const eligibleItems = [];
      for (const it of batch.items) {
        const oid = it?.sales_order_id != null ? String(it.sales_order_id) : "";
        const order = oid ? batchOrdersById.get(oid) ?? null : null;
        if (!order) skippedMissingOrder += 1;

        if (order && !isExecutiveSummaryEligibleOrderRow(order)) {
          skippedInvalid += 1;
          continue;
        }
        if (!orderMatchesExecutivePeriod(order, filters.period, it)) {
          skippedPeriod += 1;
          continue;
        }
        eligibleItems.push(it);
      }

      if (eligibleItems.length === 0) continue;

      totalEligibleItems += eligibleItems.length;
      for (const it of eligibleItems) {
        const oid = it?.sales_order_id != null ? String(it.sales_order_id) : "";
        if (oid) eligibleOrderIds.add(oid);
      }

      if (!profitCalcStarted) {
        perf.mark("profit_calc_start");
        profitCalcStarted = true;
      }

      /** @type {Record<string, unknown>[]} */
      let uiRows = [];
      if (!hydrationStarted) {
        perf.mark("hydration_start");
        hydrationStarted = true;
      }
      try {
        uiRows = await hydrateExecutiveSummaryRankingRows(
          supabase,
          userId,
          eligibleItems,
          batchOrdersById,
        );
      } catch (hydrateErr) {
        hydrationDegraded = true;
        console.warn("[S7_EXEC_SUMMARY_HYDRATION_DEGRADED]", {
          message: hydrateErr?.message ?? String(hydrateErr),
          eligibleItems: eligibleItems.length,
        });
        uiRows = buildExecutiveMinimalUiRowsFromItems(eligibleItems);
      }

      hydratedRowsCount += uiRows.length;
      if (firstHydratedRow == null && uiRows.length > 0) {
        firstHydratedRow = pickExecutiveDebugHydratedSnapshot(uiRows[0]);
      }

      const itemsById = new Map(eligibleItems.map((it) => [String(it.id), it]));

      for (const row of uiRows) {
        const itemForImg = itemsById.get(String(row.item_id));
        if (!itemForImg) continue;
        const productIdForImg =
          row.product_id != null && String(row.product_id).trim() !== ""
            ? String(row.product_id).trim()
            : "";
        const { listing_id: listingIdForImg } = resolveExecutiveRankingListingId({
          item: itemForImg,
          row,
          productId: productIdForImg || null,
        });
        if (!listingIdForImg) continue;
        const mktForImg = row.marketplace != null ? String(row.marketplace) : "";
        const accForImg =
          row.marketplace_account_id != null ? String(row.marketplace_account_id) : "";
        const keyForImg = `${mktForImg}::${accForImg}::${listingIdForImg}`;
        const urlForImg = pickHydratedRowImageUrl(itemForImg, row);
        if (urlForImg) bestImageByListingKey.set(keyForImg, urlForImg);
      }

      for (const row of uiRows) {
        try {
        const item = itemsById.get(String(row.item_id));
        if (!item) continue;
        const itemRaw =
          item.raw_json && typeof item.raw_json === "object"
            ? /** @type {Record<string, unknown>} */ (item.raw_json)
            : null;
        const itemFin =
          itemRaw?._s7_financial && typeof itemRaw._s7_financial === "object"
            ? /** @type {Record<string, unknown>} */ (itemRaw._s7_financial)
            : null;
        if (itemFin?.snapshot_origin != null && String(itemFin.snapshot_origin).trim() !== "") {
          snapshotOriginSet.add(String(itemFin.snapshot_origin).trim());
        }
        if (itemFin?.snapshot_quality != null && String(itemFin.snapshot_quality).trim() !== "") {
          snapshotQualitySet.add(String(itemFin.snapshot_quality).trim());
        }
        if (typeof itemFin?.estimated === "boolean") {
          snapshotEstimatedSet.add(itemFin.estimated);
        }
        const oid = row.sales_order_id != null ? String(row.sales_order_id) : "";
        const order = oid ? batchOrdersById.get(oid) ?? null : null;

    const qty = toQty(item.quantity);
    const grossDec = toDecimal(item.gross_amount);
    const netDec =
      toDecimal(item.net_amount) ??
      (grossDec != null ? grossDec : null);
    const feeDec = toDecimal(item.fee_amount);
    const shippingDec = toDecimal(item.shipping_share_amount);

    if (grossDec == null && netDec == null) {
      skippedNoMoney += 1;
      continue;
    }

    const grossLine = grossDec ?? new Decimal(0);
    const netLine = netDec ?? grossLine;
    if (feeDec != null) {
      feeTotal = feeTotal.plus(feeDec);
      hasFeeData = true;
    }
    if (shippingDec != null) {
      shippingTotal = shippingTotal.plus(shippingDec);
      hasShippingData = true;
    }

    const productId =
      row.product_id != null && String(row.product_id).trim() !== ""
        ? String(row.product_id).trim()
        : "";

    const lineFinancials = computeExecutiveLineRealProfit({
      item,
      qty,
      grossDec: grossLine,
      netDec: netLine,
    });

    const { profitDec, internalCosts } = lineFinancials;

    if (lineFinancials.productCostDec != null) {
      productCostTotal = productCostTotal.plus(lineFinancials.productCostDec);
      hasProductCostData = true;
    }
    if (lineFinancials.operationPackagingDec != null) {
      operationPackagingTotal = operationPackagingTotal.plus(lineFinancials.operationPackagingDec);
      hasOperationPackagingData = true;
    }
    if (lineFinancials.internalTaxDec != null) {
      taxTotal = taxTotal.plus(lineFinancials.internalTaxDec);
      hasTaxData = true;
    }
    if (lineFinancials.mlAdsDec != null) {
      adsTotal = adsTotal.plus(lineFinancials.mlAdsDec);
      hasAdsData = true;
    }
    if (lineFinancials.reserveDec != null) {
      operationalCostsTotal = operationalCostsTotal.plus(lineFinancials.reserveDec);
      hasOperationalCostsData = true;
    }

    let marginPercent = null;
    if (profitDec != null && !grossLine.isZero()) {
      marginPercent = profitDec.div(grossLine).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }

    const fin =
      row.financials && typeof row.financials === "object"
        ? /** @type {Record<string, unknown>} */ (row.financials)
        : {};
    const health =
      fin.health === "healthy" ||
      fin.health === "critical" ||
      fin.health === "attention" ||
      fin.health === "unknown"
        ? fin.health
        : "unknown";

    if (internalCosts.confidence !== "persisted") partialCostLines += 1;

    const filterId = filters.filter ?? "all";
    if (
      !matchesExecutiveSalesFilter(
        filterId,
        profitDec,
        marginPercent,
        grossLine,
        /** @type {"healthy" | "critical" | "attention" | "unknown"} */ (health),
      )
    ) {
      skippedFilterChip += 1;
      continue;
    }

    if (oid && firstValidOrderKeys.length < 3 && !firstValidOrderKeys.includes(oid)) {
      firstValidOrderKeys.push(oid);
    }

    grossTotal = grossTotal.plus(grossLine);
    netTotal = netTotal.plus(netLine);
    unitsTotal += qty;
    if (oid) {
      uniqueOrders.add(oid);
      orderGrossAgg.set(oid, (orderGrossAgg.get(oid) ?? new Decimal(0)).plus(grossLine));
      const orderStatus = order?.order_status != null ? String(order.order_status).trim().toLowerCase() : "";
      if (
        orderStatus &&
        orderStatus !== "delivered" &&
        orderStatus !== "closed" &&
        orderStatus !== "fulfilled"
      ) {
        inProgressOrders.add(oid);
      }
    }

    // Distribuição por conta — contagem de pedidos e itens por marketplace_account.
    {
      const accId =
        row.marketplace_account_id != null && String(row.marketplace_account_id).trim() !== ""
          ? String(row.marketplace_account_id).trim()
          : "";
      const accKey = accId || "__sem_conta__";
      let accEntry = accountAgg.get(accKey);
      if (!accEntry) {
        const sellerCo =
          row.seller_company_id != null && String(row.seller_company_id).trim() !== ""
            ? String(row.seller_company_id).trim()
            : order?.seller_company_id != null && String(order.seller_company_id).trim() !== ""
              ? String(order.seller_company_id).trim()
              : null;
        accEntry = {
          marketplace_account_id: accId || null,
          seller_company_id: sellerCo,
          orders: new Set(),
          items_quantity_sold: 0,
        };
        accountAgg.set(accKey, accEntry);
      }
      accEntry.items_quantity_sold += qty;
      if (oid) accEntry.orders.add(oid);
    }

    if (profitDec != null) {
      profitTotal = profitTotal.plus(profitDec);
      profitLinesWithValue += 1;
      if (profitDec.lt(0)) negativeCount += 1;
      else if (marginPercent != null && marginPercent.lt(5)) lowMarginCount += 1;
    }
    if (health === "critical" || health === "attention" || profitDec == null) {
      needsAttentionCount += 1;
    }

    const { listing_id: listingId } = resolveExecutiveRankingListingId({
      item,
      row,
      productId: productId || null,
    });
    const marketplace = row.marketplace != null ? String(row.marketplace) : "";
    const accountId =
      row.marketplace_account_id != null ? String(row.marketplace_account_id) : "";
    const listingKey = `${marketplace}::${accountId}::${listingId}`;
    const lineImageUrl = bestImageByListingKey.get(listingKey) ?? pickHydratedRowImageUrl(item, row);

    if (!listingId) {
      skippedNoListingKey += 1;
    } else {
      const externalListingIdForCatalog = pickExternalListingIdForCatalog(item, row, listingId);
      const prev = listingAgg.get(listingKey) ?? {
        listing_id: listingId,
        external_listing_id: externalListingIdForCatalog || null,
        title: row.product_display_title ?? item.title_snapshot ?? listingId,
        sku: row.sku_display ?? item.sku_snapshot ?? "",
        image_url: lineImageUrl ?? row.product_thumbnail_url ?? row.product_image_url ?? null,
        marketplace,
        marketplace_account_id: accountId || null,
        quantity_sold: 0,
        gross_sales_brl: new Decimal(0),
        net_received_brl: new Decimal(0),
        contribution_profit_brl: new Decimal(0),
        health_status: health,
      };
      if (externalListingIdForCatalog && !prev.external_listing_id) {
        prev.external_listing_id = externalListingIdForCatalog;
      }
      prev.quantity_sold += qty;
      prev.gross_sales_brl = prev.gross_sales_brl.plus(grossLine);
      prev.net_received_brl = prev.net_received_brl.plus(netLine);
      if (profitDec != null) prev.contribution_profit_brl = prev.contribution_profit_brl.plus(profitDec);
      if (lineImageUrl && !prev.image_url) prev.image_url = lineImageUrl;
      listingAgg.set(listingKey, prev);
    }

    const skuNorm = row.sku_display
      ? normalizeSkuForDbLookup(String(row.sku_display))
      : item.sku_snapshot
        ? normalizeSkuForDbLookup(String(item.sku_snapshot))
        : "";
    const sellerCo =
      row.seller_company_id != null
        ? String(row.seller_company_id)
        : order?.seller_company_id != null
          ? String(order.seller_company_id)
          : "";

    /** @type {string | null} */
    let attributionProductId = null;
    if (filters.product_id) {
      attributionProductId = String(filters.product_id).trim();
    } else if (listingProductMap) {
      const extForProduct = pickExternalListingIdForCatalog(item, row, listingId);
      if (extForProduct) {
        attributionProductId = listingProductMap.get(extForProduct) ?? null;
      }
    } else {
      attributionProductId = productId || null;
    }

    const productKey = attributionProductId
      ? `pid::${attributionProductId}`
      : !listingProductMap && skuNorm
        ? `sku::${sellerCo}::${skuNorm}`
        : null;

    if (productKey) {
      const prev = productAgg.get(productKey) ?? {
        product_id: attributionProductId || null,
        sku: row.sku_display ?? skuNorm,
        normalized_sku: skuNorm || null,
        title: row.product_display_title ?? row.sku_display ?? "Produto",
        image_url: lineImageUrl ?? row.product_thumbnail_url ?? row.product_image_url ?? null,
        quantity_sold: 0,
        gross_sales_brl: new Decimal(0),
        net_received_brl: new Decimal(0),
        contribution_profit_brl: new Decimal(0),
        linked_listing_ids: new Set(),
      };
      prev.quantity_sold += qty;
      prev.gross_sales_brl = prev.gross_sales_brl.plus(grossLine);
      prev.net_received_brl = prev.net_received_brl.plus(netLine);
      if (profitDec != null) prev.contribution_profit_brl = prev.contribution_profit_brl.plus(profitDec);
      if (lineImageUrl && !prev.image_url) prev.image_url = lineImageUrl;
      if (listingId) prev.linked_listing_ids.add(listingId);
      productAgg.set(productKey, prev);
    }
    } catch (lineErr) {
      skippedLineErrors += 1;
      if (skippedLineErrors <= 5) {
        console.warn("[S7_EXEC_SUMMARY_LINE_SKIP]", {
          item_id: row?.item_id ?? null,
          message: lineErr?.message ?? String(lineErr),
        });
      }
      continue;
    }
      }
    }
  } catch (itemFetchErr) {
    console.error("[Suse7][executive-summary] source_items_failed", itemFetchErr);
    logExecutiveSummaryZeroDebug({
      sellerId: userId,
      query: debugQuery,
      sourceOrdersCount: 0,
      sourceItemsCount: 0,
      hydratedRowsCount: 0,
      validOrders: 0,
      eligibleItems: 0,
      skippedInvalid: 0,
      skippedPeriod: 0,
      skippedMissingOrder: 0,
      skippedNoMoney: 0,
      skippedNoListingKey: 0,
      firstSourceOrder: null,
      firstSourceItem: null,
      firstHydratedRow: null,
      error: itemFetchErr?.message ?? String(itemFetchErr),
    });
    return empty();
  }
  perf.mark("sales_query_end");
  perf.log("sales_query_end", {
    items_count: sourceItemsCount,
    duration_ms: perf.stepDurationMs("sales_query_start", "sales_query_end"),
  });

  if (hydrationStarted) {
    perf.mark("hydration_end");
    perf.log("hydration_end", {
      rows_count: hydratedRowsCount,
      degraded: hydrationDegraded,
      duration_ms: perf.stepDurationMs("hydration_start", "hydration_end"),
    });
  }

  logExecutiveSummarySourceReady({
    sourceItemsCount,
    sourceOrdersCount,
    elapsedMs: executiveSummaryElapsedMs(startedAt),
  });

  if (sourceItemsCount === 0 || totalEligibleItems === 0) {
    logExecutiveSummaryZeroDebug({
      sellerId: userId,
      query: debugQuery,
      sourceOrdersCount,
      sourceItemsCount,
      hydratedRowsCount,
      validOrders: eligibleOrderIds.size,
      eligibleItems: totalEligibleItems,
      skippedInvalid,
      skippedPeriod,
      skippedMissingOrder,
      skippedNoMoney: 0,
      skippedNoListingKey: 0,
      firstSourceOrder,
      firstSourceItem,
      firstHydratedRow,
    });
    return empty();
  }

  const ordersCount = uniqueOrders.size;
  const ordersInProgressCount = inProgressOrders.size;
  let contributionMargin = new Decimal(0);
  if (profitLinesWithValue > 0 && !grossTotal.isZero()) {
    contributionMargin = profitTotal.div(grossTotal).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }
  const avgTicket =
    ordersCount > 0
      ? grossTotal.div(ordersCount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : null;
  let highestOrderGross = null;
  for (const orderTotal of orderGrossAgg.values()) {
    if (highestOrderGross == null || orderTotal.gt(highestOrderGross)) {
      highestOrderGross = orderTotal;
    }
  }
  const grossProfit =
    hasFeeData || hasShippingData || hasTaxData || hasAdsData
      ? grossTotal
          .minus(hasFeeData ? feeTotal : new Decimal(0))
          .minus(hasShippingData ? shippingTotal : new Decimal(0))
          .minus(hasTaxData ? taxTotal : new Decimal(0))
          .minus(hasAdsData ? adsTotal : new Decimal(0))
      : null;
  const summarySnapshotOrigin = snapshotOriginSet.size === 1 ? [...snapshotOriginSet][0] : null;
  const summarySnapshotQuality = snapshotQualitySet.size === 1 ? [...snapshotQualitySet][0] : null;
  const summaryEstimated = snapshotEstimatedSet.size === 1 ? [...snapshotEstimatedSet][0] : null;
  const summaryHealthStatus =
    needsAttentionCount > 0 ? "attention" : negativeCount > 0 ? "critical" : "healthy";
  const totalCosts =
    hasFeeData || hasShippingData || hasTaxData || hasAdsData
      ? (hasFeeData ? feeTotal : new Decimal(0))
          .plus(hasShippingData ? shippingTotal : new Decimal(0))
          .plus(hasTaxData ? taxTotal : new Decimal(0))
          .plus(hasAdsData ? adsTotal : new Decimal(0))
      : null;

  /** @type {Decimal | null} */
  let internalCostsGrouped = null;
  /** @type {Decimal[]} */
  const internalCostParts = [];
  if (hasProductCostData) internalCostParts.push(productCostTotal);
  if (hasOperationPackagingData) internalCostParts.push(operationPackagingTotal);
  if (hasAdsData) internalCostParts.push(adsTotal);
  if (hasOperationalCostsData) internalCostParts.push(operationalCostsTotal);
  const hasInternalCostsGrouped = internalCostParts.length > 0;
  if (hasInternalCostsGrouped) {
    internalCostsGrouped = internalCostParts.reduce(
      (acc, part) => acc.plus(part),
      new Decimal(0),
    );
  }

  /** @type {string[]} */
  const warnings = [];
  let dataQualityStatus = "complete";
  const periodWarnings = Array.isArray(filters.period_warnings) ? filters.period_warnings : [];
  for (const w of periodWarnings) {
    if (w) warnings.push(String(w));
  }
  if (periodWarnings.length > 0) dataQualityStatus = "partial";
  if (partialCostLines > 0) {
    warnings.push(`${partialCostLines} linha(s) com custo interno parcial ou ausente.`);
    dataQualityStatus = "partial";
  }
  if (hydrationDegraded) {
    warnings.push("Hidratação de catálogo degradada; KPIs usam snapshots da linha de venda.");
    dataQualityStatus = "partial";
  }
  if (skippedLineErrors > 0) {
    warnings.push(`${skippedLineErrors} linha(s) ignorada(s) por erro de cálculo.`);
    dataQualityStatus = "partial";
  }

  /**
   * @param {Record<string, unknown>} entry
   */
  function finalizeRankingEntry(entry) {
    const gross = /** @type {Decimal} */ (entry.gross_sales_brl);
    const profit = /** @type {Decimal} */ (entry.contribution_profit_brl);
    const margin =
      profit != null && !gross.isZero()
        ? profit.div(gross).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
        : "0.00";
    return {
      ...entry,
      gross_sales_brl: moneyDecimal(gross) ?? "0.00",
      net_received_brl: moneyDecimal(/** @type {Decimal} */ (entry.net_received_brl)) ?? "0.00",
      contribution_profit_brl: moneyDecimal(profit) ?? "0.00",
      margin_percent: margin,
      contribution_margin_percent: margin,
    };
  }

  /**
   * @param {Record<string, unknown>} row
   * @param {number} index
   */
  function mapListingRankingRow(row, index) {
    const image =
      row.image_url != null && String(row.image_url).trim() !== "" ? String(row.image_url).trim() : null;
    return {
      rank: index + 1,
      listing_id: row.listing_id,
      external_listing_id:
        row.external_listing_id != null && String(row.external_listing_id).trim() !== ""
          ? String(row.external_listing_id).trim()
          : null,
      title: row.title,
      sku: row.sku,
      image_url: image,
      product_thumbnail_url: image,
      listing_thumbnail_url: image,
      marketplace: row.marketplace,
      marketplace_account_id: row.marketplace_account_id,
      quantity_sold: row.quantity_sold,
      gross_sales_brl: row.gross_sales_brl,
      net_received_brl: row.net_received_brl,
      profit_brl: row.contribution_profit_brl,
      contribution_profit_brl: row.contribution_profit_brl,
      margin_percent: row.margin_percent,
      contribution_margin_percent: row.contribution_margin_percent,
      health_status: row.health_status ?? "unknown",
    };
  }

  /**
   * @param {Iterable<Record<string, unknown>>} entries
   * @param {"quantity" | "gross" | "profit"} sortBy
   */
  function buildListingRanking(entries, sortBy) {
    const finalized = [...entries].map(finalizeRankingEntry);
    finalized.sort((a, b) => {
      if (sortBy === "quantity") {
        const qd = (b.quantity_sold ?? 0) - (a.quantity_sold ?? 0);
        if (qd !== 0) return qd;
        return Number(b.gross_sales_brl) - Number(a.gross_sales_brl);
      }
      if (sortBy === "gross") {
        const gd = Number(b.gross_sales_brl) - Number(a.gross_sales_brl);
        if (gd !== 0) return gd;
        return (b.quantity_sold ?? 0) - (a.quantity_sold ?? 0);
      }
      const pd = Number(b.contribution_profit_brl) - Number(a.contribution_profit_brl);
      if (pd !== 0) return pd;
      return Number(b.gross_sales_brl) - Number(a.gross_sales_brl);
    });
    return finalized.slice(0, rankingLimit).map(mapListingRankingRow);
  }

  perf.mark("profit_calc_end");
  perf.log("profit_calc_end", {
    lines_processed: hydratedRowsCount,
    duration_ms: perf.stepDurationMs("profit_calc_start", "profit_calc_end"),
  });

  perf.mark("rankings_quantity_start");
  let listingByQuantity = buildListingRanking(listingAgg.values(), "quantity");
  perf.mark("rankings_quantity_end");
  perf.log("rankings_quantity_end", {
    count: listingByQuantity.length,
    duration_ms: perf.stepDurationMs("rankings_quantity_start", "rankings_quantity_end"),
  });

  perf.mark("rankings_revenue_start");
  let listingByGross = buildListingRanking(listingAgg.values(), "gross");
  perf.mark("rankings_revenue_end");
  perf.log("rankings_revenue_end", {
    count: listingByGross.length,
    duration_ms: perf.stepDurationMs("rankings_revenue_start", "rankings_revenue_end"),
  });

  perf.mark("rankings_profit_start");
  let listingByProfit = buildListingRanking(listingAgg.values(), "profit");
  perf.mark("rankings_profit_end");
  perf.log("rankings_profit_end", {
    count: listingByProfit.length,
    duration_ms: perf.stepDurationMs("rankings_profit_start", "rankings_profit_end"),
  });
  perf.mark("rankings_thumb_enrich_start");
  listingByQuantity = await enrichExecutiveListingRankingRows(supabase, userId, listingByQuantity);
  listingByGross = await enrichExecutiveListingRankingRows(supabase, userId, listingByGross);
  listingByProfit = await enrichExecutiveListingRankingRows(supabase, userId, listingByProfit);
  perf.mark("rankings_thumb_enrich_end");
  perf.log("rankings_thumb_enrich_end", {
    with_image: listingByQuantity.filter((r) => r.image_url).length,
    duration_ms: perf.stepDurationMs("rankings_thumb_enrich_start", "rankings_thumb_enrich_end"),
  });

  const listingSorted = listingByQuantity;

  const productSorted = [...productAgg.values()]
    .map((entry) => {
      const finalized = finalizeRankingEntry(entry);
      return {
        ...finalized,
        linked_listings_count: entry.linked_listing_ids?.size ?? 0,
      };
    })
    .sort((a, b) => {
      const qd = (b.quantity_sold ?? 0) - (a.quantity_sold ?? 0);
      if (qd !== 0) return qd;
      return Number(b.gross_sales_brl) - Number(a.gross_sales_brl);
    })
    .slice(0, productRankingLimit)
    .map((row, i) => {
      const qty = Number(row.quantity_sold) || 0;
      const grossStr = row.gross_sales_brl != null ? String(row.gross_sales_brl) : "0.00";
      let average_ticket_brl = null;
      if (qty > 0) {
        try {
          average_ticket_brl = new Decimal(grossStr.replace(",", "."))
            .div(qty)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
            .toFixed(2);
        } catch {
          average_ticket_brl = null;
        }
      }
      return {
      rank: i + 1,
      product_id: row.product_id,
      sku: row.sku,
      normalized_sku: row.normalized_sku,
      title: row.title,
      image_url: row.image_url,
      quantity_sold: row.quantity_sold,
      gross_sales_brl: row.gross_sales_brl,
      net_received_brl: row.net_received_brl,
      profit_brl: row.contribution_profit_brl,
      contribution_profit_brl: row.contribution_profit_brl,
      margin_percent: row.margin_percent,
      contribution_margin_percent: row.contribution_margin_percent,
      average_ticket_brl,
      linked_listings_count: row.linked_listings_count,
    };
    });

  // Distribuição por conta — ordenada por volume (itens vendidos) desc.
  // Apenas contagens (sem valores monetários); rótulo da conta é resolvido na UI.
  const distributionByAccount = [...accountAgg.values()]
    .map((entry) => ({
      marketplace_account_id: entry.marketplace_account_id,
      seller_company_id: entry.seller_company_id,
      orders_count: entry.orders.size,
      items_quantity_sold: entry.items_quantity_sold,
    }))
    .sort((a, b) => {
      const d = b.items_quantity_sold - a.items_quantity_sold;
      if (d !== 0) return d;
      return b.orders_count - a.orders_count;
    });

  const validOrders = eligibleOrderIds.size;
  const shouldLogExecutiveSummaryDebug =
    process.env.S7_EXEC_SUMMARY_DEBUG === "1" ||
    (listingSorted.length === 0 && totalEligibleItems > 0) ||
    (ordersCount > 0 && listingSorted.length === 0);

  if (shouldLogExecutiveSummaryDebug) {
    console.info("[S7_EXEC_SUMMARY_DEBUG]", {
      scannedOrders: sourceOrdersCount,
      sourceItemsCount,
      validOrders,
      skippedInvalid,
      skippedPeriod,
      skippedMissingOrder,
      skippedFilterChip,
      skippedNoMoney,
      skippedNoListingKey,
      eligibleItems: totalEligibleItems,
      hydratedRowsCount,
      rankingListingGroups: listingAgg.size,
      orders_count: ordersCount,
      listingsCount: listingSorted.length,
      firstValidOrderKeys,
      firstRankingItem: listingSorted[0] ?? null,
      periodPreset: filters.period?.preset ?? null,
      filter: filters.filter ?? "all",
    });
  }

  logExecutiveSummaryBuildReady({
    ordersCount,
    listingsCount: listingSorted.length,
    productsCount: productSorted.length,
    eligibleItems: totalEligibleItems,
    hydratedRowsCount,
    skippedLineErrors,
    hydrationDegraded,
    elapsedMs: executiveSummaryElapsedMs(startedAt),
  });

  if (isExecutiveSummaryDevAutoDebugEnabled()) {
    let accountsConsidered = filters.marketplace_account_id ? 1 : null;
    if (!filters.marketplace_account_id) {
      const { count } = await supabase
        .from("marketplace_accounts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      accountsConsidered = count ?? null;
    }
    console.info("[S7][executive-summary][multi_account_scope]", {
      seller_id: userId,
      marketplace_account_id: filters.marketplace_account_id ?? null,
      period_start: filters.period?.start_date ?? null,
      period_end: filters.period?.end_date ?? null,
      order_ids_in_period: sourceOrdersCount,
      source_items_count: sourceItemsCount,
      accounts_considered: accountsConsidered,
      orders_count: ordersCount,
      gross_sales_brl: moneyDecimal(grossTotal) ?? "0.00",
      records_processed: hydratedRowsCount,
      execution_time_ms: executiveSummaryElapsedMs(startedAt),
    });
  }

  if (sourceItemsCount > 0 && ordersCount === 0 && unitsTotal === 0 && grossTotal.isZero()) {
    logExecutiveSummaryZeroDebug({
      sellerId: userId,
      query: debugQuery,
      sourceOrdersCount,
      sourceItemsCount,
      hydratedRowsCount,
      validOrders,
      eligibleItems: totalEligibleItems,
      skippedInvalid,
      skippedPeriod,
      skippedMissingOrder,
      skippedNoMoney,
      skippedNoListingKey,
      firstSourceOrder,
      firstSourceItem,
      firstHydratedRow,
      orders_count: ordersCount,
      listingsCount: listingSorted.length,
      skippedFilterChip,
    });
  }

  if (productScope) {
    logS7ProductPerformance(productScope, {
      sales_count: unitsTotal,
      revenue: moneyDecimal(grossTotal) ?? "0.00",
      profit: moneyDecimal(profitTotal) ?? "0.00",
      margin: contributionMargin.toFixed(2),
      source: "executive-summary",
    });
  }

  return {
    ok: true,
    period: {
      start_date: filters.period.start_date,
      end_date: filters.period.end_date,
      preset: filters.period.preset,
    },
    filters_applied: {
      marketplace: filters.marketplace ?? null,
      marketplace_account_id: filters.marketplace_account_id ?? null,
      seller_company_id: filters.seller_company_id ?? null,
      filter: filters.filter ?? "all",
      q: filters.q ?? null,
      product_id: filters.product_id ?? null,
      product_sku: filters.product_scope?.sku ?? null,
      linked_listings_count: filters.product_scope?.listing_count ?? null,
    },
    summary: {
      gross_sales_brl: moneyDecimal(grossTotal) ?? "0.00",
      orders_count: ordersCount,
      orders_in_progress_count: ordersInProgressCount,
      items_quantity_sold: unitsTotal,
      average_ticket_brl: avgTicket != null ? moneyDecimal(avgTicket) ?? null : null,
      highest_order_gross_brl:
        highestOrderGross != null ? moneyDecimal(highestOrderGross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)) ?? null : null,
      net_received_brl: moneyDecimal(netTotal) ?? "0.00",
      gross_profit_brl: grossProfit != null ? moneyDecimal(grossProfit) ?? null : null,
      net_profit_brl: moneyDecimal(profitTotal) ?? "0.00",
      contribution_profit_brl: moneyDecimal(profitTotal) ?? "0.00",
      contribution_margin_percent: contributionMargin.toFixed(2),
      marketplace_fee_brl: hasFeeData ? moneyDecimal(feeTotal) ?? "0.00" : null,
      shipping_cost_brl: hasShippingData ? moneyDecimal(shippingTotal) ?? "0.00" : null,
      tax_cost_brl: hasTaxData ? moneyDecimal(taxTotal) ?? "0.00" : null,
      ads_cost_brl: hasAdsData ? moneyDecimal(adsTotal) ?? "0.00" : null,
      product_cost_only_brl: hasProductCostData ? moneyDecimal(productCostTotal) ?? "0.00" : null,
      operation_packaging_cost_brl: hasOperationPackagingData
        ? moneyDecimal(operationPackagingTotal) ?? "0.00"
        : null,
      operational_costs_brl: hasOperationalCostsData
        ? moneyDecimal(operationalCostsTotal) ?? "0.00"
        : null,
      internal_costs_brl: hasInternalCostsGrouped
        ? moneyDecimal(internalCostsGrouped) ?? "0.00"
        : null,
      total_costs_brl: totalCosts != null ? moneyDecimal(totalCosts) ?? null : null,
      you_receive_brl: moneyDecimal(netTotal) ?? "0.00",
      snapshot_origin: summarySnapshotOrigin,
      snapshot_quality: summarySnapshotQuality,
      estimated: summaryEstimated,
      health_status: summaryHealthStatus,
      visits_count: null,
      sales_conversion_rate_percent: null,
      conversion_data_status: "unavailable",
    },
    rankings: {
      listings: listingSorted,
      listings_by_quantity: listingByQuantity,
      listings_by_gross_revenue: listingByGross,
      listings_by_net_profit: listingByProfit,
      products: productSorted,
    },
    health: {
      negative_sales_count: negativeCount,
      low_margin_count: lowMarginCount,
      needs_attention_count: needsAttentionCount,
    },
    distribution: {
      by_account: distributionByAccount,
    },
    data_quality: {
      status: dataQualityStatus,
      warnings,
    },
    truncated_scan: false,
  };
}
