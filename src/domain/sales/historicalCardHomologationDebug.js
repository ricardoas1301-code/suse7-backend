// ======================================================
// Debug direcionado — homologação card lateral S1.8A
// MLBs: 4615133425, 4222565497 (somente estes, sempre em DEV).
// ======================================================

import Decimal from "decimal.js";
import { normalizeExternalListingId } from "../../handlers/ml/_helpers/mlSalesPersist.js";
import { normalizeMercadoLibreExternalListingId } from "../../handlers/ml/_helpers/mercadoLibreListingCoverImage.js";
import {
  externalListingIdKeyVariants,
  getListingGridRow,
  listingGridJoinKey,
  normalizeMarketplaceSlug,
} from "../../handlers/ml/_helpers/listingGridJoinKeys.js";
import { historicalCardSalesAggToPayload } from "./historicalCardOrderItemsAggregates.js";

/** IDs numéricos dos MLBs de homologação (sem prefixo). */
export const HOMOLOG_MLB_DIGITS = ["4615133425", "4222565497"];

/**
 * @param {unknown} ext
 */
export function homologMlbDigitsFromExternal(ext) {
  const s = String(ext ?? "").trim();
  if (!s) return "";
  const u = s.toUpperCase();
  if (u.startsWith("MLB")) return u.replace(/^MLB/i, "").replace(/\D/g, "");
  if (/^\d+$/.test(s)) return s;
  return "";
}

/**
 * @param {unknown} ext
 */
export function isHomologMlbExternal(ext) {
  const digits = homologMlbDigitsFromExternal(ext);
  return digits !== "" && HOMOLOG_MLB_DIGITS.includes(digits);
}

/**
 * @param {unknown} v
 */
function toNum(v) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} sku
 */
function normalizeSkuKey(sku) {
  if (sku == null || String(sku).trim() === "") return "";
  return String(sku).trim().toUpperCase();
}

/**
 * @param {Record<string, unknown>} item
 */
function itemGrossAndQty(item) {
  const qtyN = toNum(item.quantity);
  const qty = qtyN != null && qtyN > 0 ? Math.trunc(qtyN) : 1;
  let grossN = toNum(item.gross_amount);
  if (grossN == null) {
    const unit = toNum(item.unit_price);
    if (unit != null && qty > 0) grossN = unit * qty;
  }
  if (grossN == null) grossN = 0;
  return { qty, gross: grossN };
}

/**
 * @param {Record<string, unknown>[]} items
 * @param {(item: Record<string, unknown>) => boolean} predicate
 */
function sumItems(items, predicate) {
  let qty = 0;
  let gross = new Decimal(0);
  let count = 0;
  for (const raw of items || []) {
    if (!raw || typeof raw !== "object") continue;
    const item = /** @type {Record<string, unknown>} */ (raw);
    if (!predicate(item)) continue;
    const { qty: q, gross: g } = itemGrossAndQty(item);
    qty += q;
    gross = gross.plus(new Decimal(String(g)));
    count += 1;
  }
  return {
    count,
    qtyUnits: qty,
    grossBrl: gross.isZero() ? null : gross.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
  };
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
 * @param {Record<string, unknown> | null | undefined} listing
 */
function listingSku(listing) {
  if (!listing) return null;
  const pr = listing.products;
  const prod =
    Array.isArray(pr) && pr[0] && typeof pr[0] === "object"
      ? /** @type {Record<string, unknown>} */ (pr[0])
      : pr && typeof pr === "object" && !Array.isArray(pr)
        ? /** @type {Record<string, unknown>} */ (pr)
        : null;
  const sku =
    listing.product_sku ?? listing.seller_sku ?? prod?.sku ?? listing.sku ?? null;
  return sku != null && String(sku).trim() !== "" ? String(sku).trim() : null;
}

/**
 * @param {{
 *   supabase?: import("@supabase/supabase-js").SupabaseClient;
 *   userId?: string;
 *   homologDigits: string;
 *   catalogListing: Record<string, unknown> | null;
 *   gridRow: Record<string, unknown> | null;
 *   orderItems: Record<string, unknown>[];
 *   orderById: Map<string, Record<string, unknown>>;
 *   accountById: Map<string, { alias: string | null; logoUrl: string | null }>;
 *   orderItemsMaps?: {
 *     byListingKey?: Map<string, unknown>;
 *     byProductId?: Map<string, unknown>;
 *     accountAliasByListingKey?: Map<string, string | null>;
 *     accountIdByListingKey?: Map<string, string>;
 *   } | null;
 *   metricsByKey?: Map<string, Record<string, unknown>> | null;
 * }} ctx
 */
export async function logHomologationMlbCardMetricsDebug(ctx) {
  const {
    supabase,
    userId,
    homologDigits,
    catalogListing,
    gridRow,
    orderItems,
    orderById,
    accountById,
    orderItemsMaps,
    metricsByKey,
  } = ctx;

  const mlbWithPrefix = `MLB${homologDigits}`;
  const catalogExt = catalogListing?.external_listing_id ?? null;
  const gridExt = gridRow?.external_listing_id ?? null;
  const productId =
    catalogListing?.product_id != null
      ? String(catalogListing.product_id).trim()
      : gridRow?.product_id != null
        ? String(gridRow.product_id).trim()
        : "";
  const sku = listingSku(catalogListing) ?? (gridRow?.sku != null ? String(gridRow.sku) : null);
  const skuNorm = normalizeSkuKey(sku);

  const variantSet = new Set();
  for (const seed of [catalogExt, gridExt, mlbWithPrefix, homologDigits]) {
    for (const v of externalListingIdKeyVariants(seed)) variantSet.add(v);
  }
  const extVariants = [...variantSet];

  const byExtMlb = sumItems(orderItems, (it) => {
    const ext = String(it.external_listing_id ?? "");
    return extVariants.some((v) => ext === v || ext.toUpperCase() === v.toUpperCase());
  });

  const byExtDigitsOnly = sumItems(orderItems, (it) => {
    const d = homologMlbDigitsFromExternal(it.external_listing_id);
    return d === homologDigits;
  });

  const byProductId = productId
    ? sumItems(orderItems, (it) => itemContributesToProduct(it, productId, skuNorm, catalogExt, homologDigits))
    : { count: 0, qtyUnits: 0, grossBrl: null };

  const bySkuSnapshot = skuNorm
    ? sumItems(orderItems, (it) => normalizeSkuKey(it.sku_snapshot) === skuNorm)
    : { count: 0, qtyUnits: 0, grossBrl: null };

  const listingAccountId =
    catalogListing?.marketplace_account_id != null
      ? String(catalogListing.marketplace_account_id).trim()
      : gridRow?.marketplace_account_id != null
        ? String(gridRow.marketplace_account_id).trim()
        : "";

  /** @type {Record<string, unknown> | null} */
  let accountRowFromDb = null;
  if (supabase && userId && listingAccountId) {
    const { data: acc } = await supabase
      .from("marketplace_accounts")
      .select("id,account_alias,ml_nickname,account_logo_url")
      .eq("user_id", userId)
      .eq("id", listingAccountId)
      .maybeSingle();
    accountRowFromDb = acc ?? null;
  }

  const orderAccountVotes = new Map();
  for (const raw of orderItems || []) {
    if (!raw || typeof raw !== "object") continue;
    const item = /** @type {Record<string, unknown>} */ (raw);
    if (!externalListingIdsMatch(item.external_listing_id, catalogExt ?? mlbWithPrefix)) continue;
    const orderMeta =
      item.sales_order_id != null ? orderById.get(String(item.sales_order_id)) ?? null : null;
    const aid =
      item.marketplace_account_id != null && String(item.marketplace_account_id).trim() !== ""
        ? String(item.marketplace_account_id).trim()
        : orderMeta?.marketplace_account_id != null
          ? String(orderMeta.marketplace_account_id).trim()
          : "";
    if (aid) orderAccountVotes.set(aid, (orderAccountVotes.get(aid) ?? 0) + 1);
  }

  const byListingKey = orderItemsMaps?.byListingKey ?? null;
  const listingAgg =
    gridRow && byListingKey
      ? getListingGridRow(byListingKey, gridRow.marketplace, gridRow.external_listing_id)
      : undefined;
  const productAgg =
    productId && orderItemsMaps?.byProductId
      ? orderItemsMaps.byProductId.get(productId)
      : undefined;

  const pcm =
    gridRow?.product_card_metrics != null && typeof gridRow.product_card_metrics === "object"
      ? gridRow.product_card_metrics
      : null;

  const metricsRow =
    metricsByKey && gridRow
      ? getListingGridRow(metricsByKey, gridRow.marketplace, gridRow.external_listing_id)
      : null;

  const accountAliasFromMap =
    listingAccountId && accountById.has(listingAccountId)
      ? accountById.get(listingAccountId)?.alias ?? null
      : null;

  const accountAliasFromVotesKey =
    orderItemsMaps?.accountAliasByListingKey && gridRow
      ? getListingGridRow(
          orderItemsMaps.accountAliasByListingKey,
          gridRow.marketplace,
          gridRow.external_listing_id
        )
      : null;

  const profitReason = buildProfitReasonSummary({
    productId,
    catalogListing,
    listingAgg,
    productAgg,
  });

  console.info("[S7_HOMOLOG_MLB_CARD_DEBUG]", {
    homolog_mlb: mlbWithPrefix,
    homolog_digits: homologDigits,

    listing_internal_id: catalogListing?.id ?? gridRow?.id ?? null,
    external_listing_id_raw_catalog: catalogExt,
    external_listing_id_raw_grid: gridExt,
    external_listing_id_normalized_ml: normalizeMercadoLibreExternalListingId(catalogExt ?? gridExt),
    external_listing_id_normalized_join: normalizeExternalListingId(catalogExt ?? gridExt),
    external_listing_id_variants: extVariants,

    marketplace_account_id_listing: listingAccountId || null,
    joined_account_alias_catalog: catalogListing?.joined_account_alias ?? null,
    account_alias_grid_row: gridRow?.account_alias ?? null,
    ml_account_alias_grid_row: gridRow?.ml_account_alias ?? null,
    marketplace_accounts_row: accountRowFromDb
      ? {
          id: accountRowFromDb.id,
          account_alias: accountRowFromDb.account_alias,
          ml_nickname: accountRowFromDb.ml_nickname,
        }
      : null,
    account_alias_from_account_by_id_map: accountAliasFromMap,
    account_alias_from_order_items_votes: accountAliasFromVotesKey,
    account_id_votes_from_order_items: Object.fromEntries(orderAccountVotes),
    product_card_metrics_account_display_name: pcm?.accountDisplayName ?? null,

    product_id: productId || null,
    sku,
    sku_normalized: skuNorm || null,

    sales_order_items_match_by_external_listing_id: byExtMlb,
    sales_order_items_match_by_mlb_digits_only: byExtDigitsOnly,
    sales_order_items_match_by_product_id: byProductId,
    sales_order_items_match_by_sku_snapshot: bySkuSnapshot,

    listing_totals_from_aggregate_map: historicalCardSalesAggToPayload(listingAgg),
    product_totals_from_aggregate_map: historicalCardSalesAggToPayload(productAgg),

    listing_sales_metrics_fallback_row: metricsRow
      ? {
          qty_sold_total: metricsRow.qty_sold_total,
          gross_revenue_total: metricsRow.gross_revenue_total,
        }
      : null,

    product_card_metrics_ui: pcm,

    profit_diagnosis: profitReason,
  });
}

/**
 * @param {Record<string, unknown>} item
 * @param {string} targetProductId
 * @param {string} skuNorm
 * @param {unknown} catalogExt
 * @param {string} homologDigits
 */
function itemContributesToProduct(item, targetProductId, skuNorm, catalogExt, homologDigits) {
  if (catalogExt && externalListingIdsMatch(item.external_listing_id, catalogExt)) return true;
  if (homologMlbDigitsFromExternal(item.external_listing_id) === homologDigits) return true;
  const skuKey = normalizeSkuKey(item.sku_snapshot);
  return Boolean(skuNorm && skuKey && skuKey === skuNorm);
}

/**
 * @param {{
 *   productId: string;
 *   catalogListing: Record<string, unknown> | null;
 *   listingAgg: unknown;
 *   productAgg: unknown;
 * }} ctx
 */
function buildProfitReasonSummary(ctx) {
  const { productId, catalogListing, listingAgg, productAgg } = ctx;
  const pr = catalogListing?.products;
  const prod =
    Array.isArray(pr) && pr[0] && typeof pr[0] === "object"
      ? /** @type {Record<string, unknown>} */ (pr[0])
      : pr && typeof pr === "object" && !Array.isArray(pr)
        ? /** @type {Record<string, unknown>} */ (pr)
        : null;

  const listingProfitLines =
    listingAgg && typeof listingAgg === "object" && "profitLines" in listingAgg
      ? Number(/** @type {{ profitLines?: number }} */ (listingAgg).profitLines)
      : 0;
  const productProfitLines =
    productAgg && typeof productAgg === "object" && "profitLines" in productAgg
      ? Number(/** @type {{ profitLines?: number }} */ (productAgg).profitLines)
      : 0;

  let profitUiReason = "sem_linhas_com_lucro_calculado";
  if (!productId) profitUiReason = "missing_product_id_no_listing";
  else if (!prod) profitUiReason = "produto_nao_encontrado_no_join_catalogo";
  else if (prod.cost_price == null || String(prod.cost_price).trim() === "") {
    profitUiReason = "missing_product_cost";
  } else if (listingProfitLines === 0 && productProfitLines === 0) {
    profitUiReason = "missing_tax_profile_ou_missing_product_link_nas_linhas";
  } else {
    profitUiReason = "ok_parcial_ou_completo";
  }

  return {
    product_id: productId || null,
    product_found_in_join: Boolean(prod),
    cost_price: prod?.cost_price ?? null,
    packaging_cost: prod?.packaging_cost ?? null,
    operational_cost: prod?.operational_cost ?? null,
    listing_profit_lines: listingProfitLines,
    product_profit_lines: productProfitLines,
    profit_ui_reason: profitUiReason,
  };
}

/**
 * @param {{
 *   listings: Record<string, unknown>[];
 *   gridRows: Record<string, unknown>[];
 *   orderItems: Record<string, unknown>[];
 *   orderById: Map<string, Record<string, unknown>>;
 *   accountById: Map<string, { alias: string | null; logoUrl: string | null }>;
 *   orderItemsMaps?: Record<string, unknown> | null;
 *   metricsByKey?: Map<string, Record<string, unknown>> | null;
 *   supabase?: import("@supabase/supabase-js").SupabaseClient;
 *   userId?: string;
 * }} ctx
 */
export async function logHomologationMlbsCardDebug(ctx) {
  const debugOn =
    process.env.S7_HOMOLOG_MLB_DEBUG === "1" ||
    process.env.ML_CARD_METRICS_DEBUG === "1" ||
    process.env.NODE_ENV === "development" ||
    process.env.VERCEL_ENV === "development";
  if (!debugOn) return;

  const listingByDigits = new Map();
  for (const l of ctx.listings || []) {
    const d = homologMlbDigitsFromExternal(l.external_listing_id);
    if (d && HOMOLOG_MLB_DIGITS.includes(d)) listingByDigits.set(d, l);
  }

  const gridByDigits = new Map();
  for (const r of ctx.gridRows || []) {
    const d = homologMlbDigitsFromExternal(r.external_listing_id);
    if (d && HOMOLOG_MLB_DIGITS.includes(d)) gridByDigits.set(d, r);
  }

  for (const digits of HOMOLOG_MLB_DIGITS) {
    const catalogListing = listingByDigits.get(digits) ?? null;
    const gridRow = gridByDigits.get(digits) ?? null;
    if (!catalogListing && !gridRow) {
      console.info("[S7_HOMOLOG_MLB_CARD_DEBUG]", {
        homolog_mlb: `MLB${digits}`,
        homolog_digits: digits,
        error: "mlb_not_found_in_catalog_or_grid",
        listings_scanned: (ctx.listings || []).length,
        grid_rows_scanned: (ctx.gridRows || []).length,
        hint: "Verifique se o anúncio está no marketplace_listings do usuário autenticado.",
      });
      continue;
    }
    await logHomologationMlbCardMetricsDebug({
      supabase: ctx.supabase,
      userId: ctx.userId,
      homologDigits: digits,
      catalogListing,
      gridRow,
      orderItems: ctx.orderItems,
      orderById: ctx.orderById,
      accountById: ctx.accountById,
      orderItemsMaps: ctx.orderItemsMaps,
      metricsByKey: ctx.metricsByKey,
    });
  }
}
