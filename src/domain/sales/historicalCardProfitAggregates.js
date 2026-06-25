// ======================================================
// Lucro acumulado histórico (card Precificação Inteligente / read model compartilhável).
// Fonte: sales_order_items + custos de products + imposto (computeSaleDetailRealResult).
// Mesma fórmula do Raio-X da venda — agregação server-side, sem período temporal.
// ======================================================

import Decimal from "decimal.js";
import {
  externalListingIdKeyVariants,
  getListingGridRow,
  listingGridJoinKey,
  normalizeMarketplaceSlug,
} from "../../handlers/ml/_helpers/listingGridJoinKeys.js";
import { putListingGridRowValueAliases } from "../../handlers/ml/_helpers/listingGridJoinKeys.js";
import {
  buildSaleDetailInternalCostsContract,
  computeSaleDetailRealResult,
  resolveSaleInternalTaxProfile,
} from "./saleDetailInternalCosts.js";

/**
 * @param {unknown} v
 */
function toNum(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Record<string, unknown>} listing
 */
function productRecordFromListingJoin(listing) {
  const raw = listing.products;
  if (Array.isArray(raw) && raw[0] && typeof raw[0] === "object") {
    return /** @type {Record<string, unknown>} */ (raw[0]);
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return /** @type {Record<string, unknown>} */ (raw);
  }
  return null;
}

/**
 * @param {Map<string, string>} map
 * @param {unknown} marketplace
 * @param {unknown} externalListingId
 * @returns {string}
 */
function getProductIdForListing(map, marketplace, externalListingId) {
  const primary = normalizeMarketplaceSlug(marketplace);
  const mkTry = primary === "mercado_livre" ? [primary] : [primary, "mercado_livre"];
  for (const mkt of mkTry) {
    for (const v of externalListingIdKeyVariants(externalListingId)) {
      const pid = map.get(listingGridJoinKey(mkt, v));
      if (pid) return pid;
    }
  }
  return "";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>[]} listings
 * @returns {Promise<{
 *   byListingKey: Map<string, { profit: InstanceType<typeof Decimal>; gross: InstanceType<typeof Decimal>; profitLines: number }>;
 *   byProductId: Map<string, { profit: InstanceType<typeof Decimal>; gross: InstanceType<typeof Decimal>; profitLines: number }>;
 * }>}
 */
export async function buildHistoricalCardProfitAggregates(supabase, userId, listings) {
  /** @type {Map<string, { profit: InstanceType<typeof Decimal>; gross: InstanceType<typeof Decimal>; profitLines: number }>} */
  const byListingKey = new Map();
  /** @type {Map<string, { profit: InstanceType<typeof Decimal>; gross: InstanceType<typeof Decimal>; profitLines: number }>} */
  const byProductId = new Map();
  /** @type {Map<string, string>} */
  const listingKeyToProductId = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const productsById = new Map();

  for (const listing of listings || []) {
    if (!listing || typeof listing !== "object") continue;
    const mkt = listing.marketplace != null ? String(listing.marketplace).trim() : "";
    const pid = listing.product_id != null ? String(listing.product_id).trim() : "";
    if (!pid) continue;
    const prod = productRecordFromListingJoin(listing);
    if (prod) productsById.set(pid, prod);
    for (const v of externalListingIdKeyVariants(listing.external_listing_id)) {
      listingKeyToProductId.set(listingGridJoinKey(normalizeMarketplaceSlug(mkt), v), pid);
    }
  }

  /** @type {Map<string, Awaited<ReturnType<typeof resolveSaleInternalTaxProfile>> | null>} */
  const taxProfileCache = new Map();

  /**
   * @param {Record<string, unknown>} item
   * @param {Record<string, unknown> | null} orderMeta
   */
  async function taxForItem(item, orderMeta) {
    const sellerCompanyId =
      item.seller_company_id != null && String(item.seller_company_id).trim() !== ""
        ? String(item.seller_company_id).trim()
        : orderMeta?.seller_company_id != null && String(orderMeta.seller_company_id).trim() !== ""
          ? String(orderMeta.seller_company_id).trim()
          : "";
    const accountId =
      item.marketplace_account_id != null && String(item.marketplace_account_id).trim() !== ""
        ? String(item.marketplace_account_id).trim()
        : orderMeta?.marketplace_account_id != null && String(orderMeta.marketplace_account_id).trim() !== ""
          ? String(orderMeta.marketplace_account_id).trim()
          : "";
    const cacheKey = `${sellerCompanyId}|${accountId}`;
    if (taxProfileCache.has(cacheKey)) return taxProfileCache.get(cacheKey) ?? null;
    const profile = await resolveSaleInternalTaxProfile(supabase, userId, {
      seller_company_id: sellerCompanyId || null,
      marketplace_account_id: accountId || null,
    });
    taxProfileCache.set(cacheKey, profile);
    return profile;
  }

  const { data: items, error: iErr } = await supabase
    .from("sales_order_items")
    .select(
      "sales_order_id, marketplace, marketplace_account_id, seller_company_id, external_listing_id, quantity, gross_amount, net_amount, unit_price"
    )
    .eq("user_id", userId)
    .not("external_listing_id", "is", null);

  if (iErr) throw iErr;

  const orderIds = [
    ...new Set(
      (items || [])
        .map((it) => (it?.sales_order_id != null ? String(it.sales_order_id) : ""))
        .filter(Boolean)
    ),
  ];

  /** @type {Map<string, Record<string, unknown>>} */
  const orderById = new Map();
  if (orderIds.length > 0) {
    const chunkSize = 200;
    for (let i = 0; i < orderIds.length; i += chunkSize) {
      const slice = orderIds.slice(i, i + chunkSize);
      const { data: orders, error: oErr } = await supabase
        .from("sales_orders")
        .select("id, marketplace_account_id, seller_company_id")
        .eq("user_id", userId)
        .in("id", slice);
      if (oErr) throw oErr;
      for (const o of orders || []) {
        if (o?.id != null) orderById.set(String(o.id), /** @type {Record<string, unknown>} */ (o));
      }
    }
  }

  for (const raw of items || []) {
    if (!raw || typeof raw !== "object") continue;
    const item = /** @type {Record<string, unknown>} */ (raw);
    const mkt = item.marketplace != null ? String(item.marketplace).trim() : "";

    const qtyN = toNum(item.quantity);
    const qty = qtyN != null && qtyN > 0 ? Math.trunc(qtyN) : 1;

    let grossN = toNum(item.gross_amount);
    if (grossN == null) {
      const unit = toNum(item.unit_price);
      if (unit != null && qty > 0) grossN = unit * qty;
    }
    if (grossN == null) grossN = 0;
    const grossDec = new Decimal(String(grossN));

    let netN = toNum(item.net_amount);
    if (netN == null) netN = grossN;
    const netDec = new Decimal(String(netN));

    const pid = getProductIdForListing(listingKeyToProductId, mkt, item.external_listing_id);
    const product = pid ? productsById.get(pid) ?? null : null;

    const orderMeta =
      item.sales_order_id != null ? orderById.get(String(item.sales_order_id)) ?? null : null;
    const taxProfile = await taxForItem(item, orderMeta);

    const internalCosts = buildSaleDetailInternalCostsContract({
      product,
      productId: pid || null,
      qty,
      grossDec,
      taxPercent: taxProfile?.tax_percent ?? null,
      taxPercentSource: taxProfile?.source ?? null,
      seller_company_id: taxProfile?.seller_company_id ?? null,
      marketplace_account_id: taxProfile?.marketplace_account_id ?? null,
    });

    const { profitDec } = computeSaleDetailRealResult({
      netReceivedDec: netDec,
      internalCosts,
    });

    let listingAgg = getListingGridRow(byListingKey, mkt, item.external_listing_id);
    if (!listingAgg) {
      listingAgg = { profit: new Decimal(0), gross: new Decimal(0), profitLines: 0 };
    }
    listingAgg.gross = listingAgg.gross.plus(grossDec);
    if (profitDec != null) {
      listingAgg.profit = listingAgg.profit.plus(profitDec);
      listingAgg.profitLines += 1;
    }
    putListingGridRowValueAliases(byListingKey, mkt, item.external_listing_id, listingAgg);

    if (pid) {
      let productAgg = byProductId.get(pid);
      if (!productAgg) {
        productAgg = { profit: new Decimal(0), gross: new Decimal(0), profitLines: 0 };
        byProductId.set(pid, productAgg);
      }
      productAgg.gross = productAgg.gross.plus(grossDec);
      if (profitDec != null) {
        productAgg.profit = productAgg.profit.plus(profitDec);
        productAgg.profitLines += 1;
      }
    }
  }

  return { byListingKey, byProductId };
}

/**
 * @param {{ profit: InstanceType<typeof Decimal>; gross: InstanceType<typeof Decimal>; profitLines: number } | undefined} agg
 * @returns {{ profitBrl: string | null; profitPercent: string | null }}
 */
export function historicalCardProfitAggToPayload(agg) {
  if (!agg || agg.gross.isZero() || agg.profitLines === 0) {
    return { profitBrl: null, profitPercent: null };
  }

  const profitBrl = agg.profit.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const profitPercent = agg.profit
    .div(agg.gross)
    .mul(100)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
  return { profitBrl, profitPercent };
}
