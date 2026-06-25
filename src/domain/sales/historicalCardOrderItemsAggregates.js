// ======================================================
// Métricas históricas do card lateral (Precificação Inteligente).
// Fonte única: sales_order_items (+ sales_orders para conta/imposto).
// Mesma base do Raio-X/Vendas — sem sold_quantity ML, sem período.
// ======================================================

import Decimal from "decimal.js";
import {
  externalListingIdKeyVariants,
  getListingGridRow,
  listingGridJoinKey,
  normalizeMarketplaceSlug,
  putListingGridRowValueAliases,
} from "../../handlers/ml/_helpers/listingGridJoinKeys.js";
import {
  buildSaleDetailInternalCostsContract,
  computeSaleDetailRealResult,
  resolveSaleInternalTaxProfile,
} from "./saleDetailInternalCosts.js";
import { logHomologationMlbsCardDebug } from "./historicalCardHomologationDebug.js";

/** @typedef {{ qtyUnits: number; gross: InstanceType<typeof Decimal>; profit: InstanceType<typeof Decimal>; profitLines: number }} CardItemsAgg */

/**
 * @param {unknown} v
 */
function toNum(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function externalListingIdsMatch(a, b) {
  const va = new Set(externalListingIdKeyVariants(a));
  for (const v of externalListingIdKeyVariants(b)) {
    if (va.has(v)) return true;
  }
  return false;
}

/**
 * @param {unknown} sku
 */
function normalizeSkuKey(sku) {
  if (sku == null || String(sku).trim() === "") return "";
  return String(sku).trim().toUpperCase();
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
  const costRow = listing.product_cost_row;
  if (costRow != null && typeof costRow === "object" && !Array.isArray(costRow)) {
    const cr = /** @type {Record<string, unknown>} */ (costRow);
    return {
      cost_price: cr.cost_price,
      operational_cost: cr.operational_cost,
      packaging_cost: cr.packaging_cost,
      sku: listing.product_sku ?? listing.seller_sku ?? null,
      product_name: listing.product_name ?? null,
    };
  }
  return null;
}

/**
 * @param {Map<string, string>} listingKeyToProductId
 * @param {Map<string, string>} skuToProductId
 * @param {unknown} marketplace
 * @param {unknown} externalListingId
 * @param {unknown} [skuSnapshot]
 */
function resolveProductIdForOrderItem(listingKeyToProductId, skuToProductId, marketplace, externalListingId, skuSnapshot) {
  const primary = normalizeMarketplaceSlug(marketplace);
  const mkTry = primary === "mercado_livre" ? [primary] : [primary, "mercado_livre"];
  for (const mkt of mkTry) {
    for (const v of externalListingIdKeyVariants(externalListingId)) {
      const pid = listingKeyToProductId.get(listingGridJoinKey(mkt, v));
      if (pid) return pid;
    }
  }
  const skuKey = normalizeSkuKey(skuSnapshot);
  if (skuKey && skuToProductId.has(skuKey)) return skuToProductId.get(skuKey) ?? "";
  return "";
}

/**
 * @param {CardItemsAgg | undefined} agg
 */
export function historicalCardSalesAggToPayload(agg) {
  if (!agg || (agg.qtyUnits <= 0 && agg.gross.isZero())) {
    return {
      salesCount: null,
      salesAmountBrl: null,
      profitBrl: null,
      profitPercent: null,
    };
  }
  const salesCount = agg.qtyUnits > 0 ? agg.qtyUnits : null;
  const salesAmountBrl = !agg.gross.isZero() ? agg.gross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null;

  let profitBrl = null;
  let profitPercent = null;
  if (agg.profitLines > 0 && !agg.gross.isZero()) {
    profitBrl = agg.profit.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
    profitPercent = agg.profit
      .div(agg.gross)
      .mul(100)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toFixed(2);
  }

  return { salesCount, salesAmountBrl, profitBrl, profitPercent };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>[]} items
 * @param {Map<string, Record<string, unknown>>} orderById
 */
async function preloadTaxProfileCache(supabase, userId, items, orderById) {
  /** @type {Map<string, Awaited<ReturnType<typeof resolveSaleInternalTaxProfile>> | null>} */
  const cache = new Map();
  /** @type {Set<string>} */
  const keys = new Set();

  for (const raw of items || []) {
    if (!raw || typeof raw !== "object") continue;
    const item = /** @type {Record<string, unknown>} */ (raw);
    const orderMeta =
      item.sales_order_id != null ? orderById.get(String(item.sales_order_id)) ?? null : null;
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
    keys.add(`${sellerCompanyId}\t${accountId}`);
  }

  const keyList = [...keys];
  const chunk = 24;
  for (let i = 0; i < keyList.length; i += chunk) {
    const slice = keyList.slice(i, i + chunk);
    await Promise.all(
      slice.map(async (cacheKey) => {
        const [sellerCompanyId, accountId] = cacheKey.split("\t");
        const profile = await resolveSaleInternalTaxProfile(supabase, userId, {
          seller_company_id: sellerCompanyId || null,
          marketplace_account_id: accountId || null,
        });
        cache.set(cacheKey, profile);
      })
    );
  }
  return cache;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>[]} listings
 * @param {Map<string, { alias: string | null; logoUrl: string | null }>} [accountById]
 */
export async function buildHistoricalCardOrderItemsAggregates(supabase, userId, listings, accountById = new Map()) {
  /** @type {Map<string, CardItemsAgg>} */
  const byListingKey = new Map();
  /** @type {Map<string, CardItemsAgg>} */
  const byProductId = new Map();
  /** @type {Map<string, string>} */
  const listingKeyToProductId = new Map();
  /** @type {Map<string, string>} */
  const skuToProductId = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const productsById = new Map();
  /** @type {Map<string, Map<string, number>>} */
  const accountVotesByListingKey = new Map();
  /** @type {Map<string, string>} */
  const catalogAccountAliasByListingKey = new Map();

  for (const listing of listings || []) {
    if (!listing || typeof listing !== "object") continue;
    const mkt = listing.marketplace != null ? String(listing.marketplace).trim() : "";
    const pid = listing.product_id != null ? String(listing.product_id).trim() : "";
    const skuNorm = normalizeSkuKey(
      listing.product_sku ?? listing.seller_sku ?? productRecordFromListingJoin(listing)?.sku
    );
    if (pid) {
      const prod = productRecordFromListingJoin(listing);
      if (prod) productsById.set(pid, prod);
      if (skuNorm) skuToProductId.set(skuNorm, pid);
    }
    for (const v of externalListingIdKeyVariants(listing.external_listing_id)) {
      listingKeyToProductId.set(listingGridJoinKey(normalizeMarketplaceSlug(mkt), v), pid);
    }
    const listingAccountId =
      listing.marketplace_account_id != null && String(listing.marketplace_account_id).trim() !== ""
        ? String(listing.marketplace_account_id).trim()
        : "";
    const joinedAlias =
      listing.joined_account_alias != null && String(listing.joined_account_alias).trim() !== ""
        ? String(listing.joined_account_alias).trim()
        : null;
    for (const v of externalListingIdKeyVariants(listing.external_listing_id)) {
      const lk = listingGridJoinKey(normalizeMarketplaceSlug(mkt), v);
      if (joinedAlias) catalogAccountAliasByListingKey.set(lk, joinedAlias);
      if (listingAccountId) {
        let votes = accountVotesByListingKey.get(lk);
        if (!votes) {
          votes = new Map();
          accountVotesByListingKey.set(lk, votes);
        }
        votes.set(listingAccountId, (votes.get(listingAccountId) ?? 0) + 1000);
      }
    }
  }

  const { data: items, error: iErr } = await supabase
    .from("sales_order_items")
    .select(
      "sales_order_id, marketplace, marketplace_account_id, seller_company_id, external_listing_id, sku_snapshot, quantity, gross_amount, net_amount, unit_price"
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

  const taxProfileCache = await preloadTaxProfileCache(supabase, userId, items, orderById);

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

    const pid = resolveProductIdForOrderItem(
      listingKeyToProductId,
      skuToProductId,
      mkt,
      item.external_listing_id,
      item.sku_snapshot
    );
    const product = pid ? productsById.get(pid) ?? null : null;

    const orderMeta =
      item.sales_order_id != null ? orderById.get(String(item.sales_order_id)) ?? null : null;

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

    if (accountId) {
      for (const v of externalListingIdKeyVariants(item.external_listing_id)) {
        const lk = listingGridJoinKey(normalizeMarketplaceSlug(mkt), v);
        let votes = accountVotesByListingKey.get(lk);
        if (!votes) {
          votes = new Map();
          accountVotesByListingKey.set(lk, votes);
        }
        votes.set(accountId, (votes.get(accountId) ?? 0) + 1);
      }
    }

    const taxKey = `${sellerCompanyId}\t${accountId}`;
    const taxProfile = taxProfileCache.get(taxKey) ?? null;

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

    const itemExt = item.external_listing_id;
    /** @type {Record<string, unknown>[]} */
    const matchedCatalogListings = [];
    for (const listing of listings || []) {
      if (!listing || typeof listing !== "object") continue;
      if (externalListingIdsMatch(listing.external_listing_id, itemExt)) {
        matchedCatalogListings.push(listing);
      }
    }

    let listingAgg = getListingGridRow(byListingKey, mkt, itemExt);
    if (!listingAgg) {
      listingAgg = { qtyUnits: 0, gross: new Decimal(0), profit: new Decimal(0), profitLines: 0 };
    }
    listingAgg.qtyUnits += qty;
    listingAgg.gross = listingAgg.gross.plus(grossDec);
    if (profitDec != null) {
      listingAgg.profit = listingAgg.profit.plus(profitDec);
      listingAgg.profitLines += 1;
    }
    putListingGridRowValueAliases(byListingKey, mkt, itemExt, listingAgg);
    for (const listing of matchedCatalogListings) {
      putListingGridRowValueAliases(
        byListingKey,
        listing.marketplace,
        listing.external_listing_id,
        listingAgg
      );
    }

    if (pid) {
      let productAgg = byProductId.get(pid);
      if (!productAgg) {
        productAgg = { qtyUnits: 0, gross: new Decimal(0), profit: new Decimal(0), profitLines: 0 };
        byProductId.set(pid, productAgg);
      }
      productAgg.qtyUnits += qty;
      productAgg.gross = productAgg.gross.plus(grossDec);
      if (profitDec != null) {
        productAgg.profit = productAgg.profit.plus(profitDec);
        productAgg.profitLines += 1;
      }
    }
  }

  /** @type {Map<string, string>} */
  const accountIdByListingKey = new Map();
  /** @type {Map<string, string | null>} */
  const accountAliasByListingKey = new Map();

  for (const listing of listings || []) {
    if (!listing || typeof listing !== "object") continue;
    const listingAccountId =
      listing.marketplace_account_id != null && String(listing.marketplace_account_id).trim() !== ""
        ? String(listing.marketplace_account_id).trim()
        : "";
    if (!listingAccountId) continue;
    const meta = accountById.get(listingAccountId);
    const aliasFromAccount = meta?.alias ?? null;
    for (const v of externalListingIdKeyVariants(listing.external_listing_id)) {
      const lk = listingGridJoinKey(normalizeMarketplaceSlug(listing.marketplace), v);
      accountIdByListingKey.set(lk, listingAccountId);
      if (aliasFromAccount) accountAliasByListingKey.set(lk, aliasFromAccount);
    }
  }

  for (const [lk, votes] of accountVotesByListingKey) {
    let bestId = "";
    let bestN = 0;
    for (const [aid, n] of votes) {
      if (n > bestN) {
        bestN = n;
        bestId = aid;
      }
    }
    if (bestId) {
      accountIdByListingKey.set(lk, bestId);
      const meta = accountById.get(bestId);
      accountAliasByListingKey.set(
        lk,
        meta?.alias ?? catalogAccountAliasByListingKey.get(lk) ?? accountAliasByListingKey.get(lk) ?? null
      );
    } else {
      const catalogAlias = catalogAccountAliasByListingKey.get(lk);
      if (catalogAlias) accountAliasByListingKey.set(lk, catalogAlias);
    }
  }

  await hydrateListingCardAggFromSalesMetrics(supabase, userId, byListingKey);

  return {
    byListingKey,
    byProductId,
    accountIdByListingKey,
    accountAliasByListingKey,
    orderItems: items ?? [],
    orderById,
  };
}

/**
 * Preenche lacunas do mapa de anúncio com listing_sales_metrics (mesma fonte da grade).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Map<string, CardItemsAgg>} byListingKey
 */
async function hydrateListingCardAggFromSalesMetrics(supabase, userId, byListingKey) {
  const { data: metrics, error } = await supabase
    .from("listing_sales_metrics")
    .select("marketplace, external_listing_id, qty_sold_total, gross_revenue_total")
    .eq("user_id", userId);
  if (error) {
    console.warn("[Suse7][card-metrics] listing_sales_metrics_hydrate_failed", {
      message: error.message,
      code: error.code,
    });
    return;
  }

  for (const m of metrics || []) {
    if (!m || typeof m !== "object") continue;
    const existing = getListingGridRow(
      byListingKey,
      m.marketplace,
      m.external_listing_id
    );
    if (existing && (existing.qtyUnits > 0 || !existing.gross.isZero())) continue;

    const qtyN = toNum(m.qty_sold_total);
    const grossN = toNum(m.gross_revenue_total);
    if ((qtyN == null || qtyN <= 0) && (grossN == null || grossN <= 0)) continue;

    let listingAgg = existing;
    if (!listingAgg) {
      listingAgg = { qtyUnits: 0, gross: new Decimal(0), profit: new Decimal(0), profitLines: 0 };
    }
    if (qtyN != null && qtyN > 0) listingAgg.qtyUnits += Math.trunc(qtyN);
    if (grossN != null && grossN > 0) {
      listingAgg.gross = listingAgg.gross.plus(new Decimal(String(grossN)));
    }
    putListingGridRowValueAliases(byListingKey, m.marketplace, m.external_listing_id, listingAgg);
  }
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   userId: string;
 *   listings: Record<string, unknown>[];
 *   gridRows: Record<string, unknown>[];
 *   orderItemsMaps: Awaited<ReturnType<typeof buildHistoricalCardOrderItemsAggregates>> | null;
 *   accountById: Map<string, { alias: string | null; logoUrl: string | null }>;
 *   metricsByKey: Map<string, Record<string, unknown>>;
 * }} ctx
 */
export async function runCardMetricsHomologationDebug(ctx) {
  const maps = ctx.orderItemsMaps;
  await logHomologationMlbsCardDebug({
    supabase: ctx.supabase,
    userId: ctx.userId,
    listings: ctx.listings,
    gridRows: ctx.gridRows,
    orderItems: maps?.orderItems ?? [],
    orderById: maps?.orderById ?? new Map(),
    accountById: ctx.accountById,
    orderItemsMaps: maps,
    metricsByKey: ctx.metricsByKey,
  });
}

/**
 * Logs DEV para homologação de card metrics (MLB específicos ou flag).
 * @param {Record<string, unknown>[]} gridRows
 * @param {Record<string, unknown>[]} listings
 */
export function logHistoricalCardMetricsProbe(gridRows, listings, orderItemsMaps = null) {
  const debugOn =
    process.env.ML_CARD_METRICS_DEBUG === "1" ||
    process.env.NODE_ENV === "development" ||
    process.env.VERCEL_ENV === "development";
  if (!debugOn) return;

  const probeRaw = String(process.env.ML_CARD_METRICS_PROBE_EXT ?? "4615133425,4222565497").trim();
  const probes = probeRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  /** @type {Map<string, Record<string, unknown>>} */
  const listingById = new Map();
  for (const l of listings || []) {
    if (l?.id != null) listingById.set(String(l.id), l);
  }

  for (const row of gridRows || []) {
    const ext = String(row.external_listing_id ?? "");
    if (!probes.some((p) => ext.includes(p))) continue;

    const listing = row.id != null ? listingById.get(String(row.id)) : null;
    const pcm =
      row.product_card_metrics != null && typeof row.product_card_metrics === "object"
        ? row.product_card_metrics
        : null;
    const byListingKey = orderItemsMaps?.byListingKey ?? null;
    const listingAgg =
      byListingKey != null
        ? getListingGridRow(byListingKey, row.marketplace, row.external_listing_id)
        : undefined;
    const listingAggPayload = historicalCardSalesAggToPayload(listingAgg);

    console.info("[S7_CARD_METRICS_PROBE]", {
      listing_id: row.id ?? null,
      external_listing_id: ext,
      marketplace_account_id: row.marketplace_account_id ?? listing?.marketplace_account_id ?? null,
      joined_account_alias: listing?.joined_account_alias ?? null,
      account_alias_row: row.account_alias ?? null,
      ml_account_alias_row: row.ml_account_alias ?? null,
      account_display_name: pcm?.accountDisplayName ?? null,
      product_id: row.product_id ?? listing?.product_id ?? null,
      sku: row.sku ?? listing?.product_sku ?? listing?.seller_sku ?? null,
      listing_agg_raw_qty: listingAgg?.qtyUnits ?? null,
      listing_agg_raw_gross: listingAgg?.gross?.toFixed?.(2) ?? null,
      listing_agg_payload: listingAggPayload,
      listing_sales_qty: pcm?.listingSalesCount ?? null,
      listing_sales_brl: pcm?.listingSalesAmountBrl ?? null,
      listing_profit_brl: pcm?.listingProfitBrl ?? null,
      listing_profit_pct: pcm?.listingProfitPercent ?? null,
      product_sales_qty: pcm?.productSalesCount ?? null,
      product_sales_brl: pcm?.productSalesAmountBrl ?? null,
      product_profit_brl: pcm?.productProfitBrl ?? null,
      product_profit_pct: pcm?.productProfitPercent ?? null,
      sold_quantity_grid: row.sold_quantity ?? null,
      gross_revenue_brl_grid: row.gross_revenue_brl ?? null,
      gross_revenue_missing: row.gross_revenue_missing ?? null,
    });
  }
}
