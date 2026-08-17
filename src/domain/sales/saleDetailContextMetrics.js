// ======================================================
// Métricas acumuladas — anúncio e produto (Raio-x da venda).
// Anúncio: listing_sales_metrics → fallback sales_order_items.
// Produto: SSOT catalog-financial-lite (mesmo motor do Raio-X do Produto).
// ======================================================

import Decimal from "decimal.js";
import { resolveProductLifetimeSalesMetricsFromCatalogSsot } from "../products/buildProductCatalogFinancial.js";
import { externalListingIdKeyVariants } from "../../handlers/ml/_helpers/listingGridJoinKeys.js";
import { ML_MARKETPLACE_LISTING_ALIASES } from "../../handlers/ml/_helpers/mlMarketplace.js";
import { resolveSaleCommercialLookup } from "./saleListingHealthCommercial.js";

/**
 * @param {unknown} raw
 */
function toNum(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Decimal} d
 */
function moneyDecimalString(d) {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/**
 * @param {unknown} qty
 */
function qtyIntString(qty) {
  const n = toNum(qty);
  if (n == null) return null;
  return String(Math.trunc(n));
}

/**
 * @param {unknown} error
 */
function isIgnorableMetricsSchemaError(error) {
  const code = String(/** @type {{ code?: unknown }} */ (error)?.code ?? "");
  const msg = String(/** @type {{ message?: unknown }} */ (error)?.message ?? "").toLowerCase();
  return (
    code === "42P01" ||
    code === "42703" ||
    code === "PGRST204" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache") ||
    msg.includes("could not find")
  );
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} marketplace
 * @param {string[]} extVariants
 */
async function fetchListingMetricsRow(supabase, userId, marketplace, extVariants) {
  if (!marketplace || extVariants.length === 0) return null;

  const { data, error } = await supabase
    .from("listing_sales_metrics")
    .select("qty_sold_total, gross_revenue_total, marketplace, external_listing_id")
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .in("external_listing_id", extVariants)
    .limit(1);

  if (error) {
    if (isIgnorableMetricsSchemaError(error)) return null;
    throw error;
  }
  const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
  return row && typeof row === "object" ? row : null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {ReturnType<typeof resolveSaleCommercialLookup>} lookup
 */
async function fallbackListingMetricsFromOrderItems(supabase, userId, lookup) {
  const variants = externalListingIdKeyVariants(lookup.externalListingId);
  if (variants.length === 0) {
    return { qty: null, amount: null, source: "none" };
  }

  let q = supabase
    .from("sales_order_items")
    .select("quantity, gross_amount, unit_price, marketplace")
    .eq("user_id", userId)
    .in("external_listing_id", variants);

  const marketplaces = lookup.marketplaceCandidates.filter(Boolean);
  if (marketplaces.length === 1) {
    q = q.eq("marketplace", marketplaces[0]);
  } else if (marketplaces.length > 1) {
    q = q.in("marketplace", marketplaces);
  }

  if (lookup.accountId) {
    q = q.eq("marketplace_account_id", lookup.accountId);
  }
  if (lookup.sellerCompanyId) {
    q = q.eq("seller_company_id", lookup.sellerCompanyId);
  }

  const { data, error } = await q;
  if (error) {
    const msg = String(error.message ?? "").toLowerCase();
    if (msg.includes("column") || String(error.code ?? "") === "42703") {
      return { qty: null, amount: null, source: "none" };
    }
    throw error;
  }

  let qty = new Decimal(0);
  let gross = new Decimal(0);
  let saw = false;

  for (const row of data || []) {
    if (!row || typeof row !== "object") continue;
    const qn = toNum(row.quantity);
    if (qn != null && qn > 0) {
      qty = qty.plus(Math.trunc(qn));
      saw = true;
    }
    let g = toNum(row.gross_amount);
    if (g == null) {
      const unit = toNum(row.unit_price);
      if (unit != null && qn != null && qn > 0) g = unit * qn;
    }
    if (g != null) {
      gross = gross.plus(new Decimal(String(g)));
      saw = true;
    }
  }

  if (!saw) return { qty: null, amount: null, source: "none" };
  return {
    qty: qty.isZero() ? null : String(qty.toNumber()),
    amount: gross.isZero() ? null : moneyDecimalString(gross),
    source: "sales_order_items_fallback",
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {ReturnType<typeof resolveSaleCommercialLookup>} lookup
 * @param {{ listingIdDisplay?: string | null; listingExternalId?: string | null; listingMarketplace?: string | null }} hints
 */
async function fetchListingAccumulatedMetrics(supabase, userId, item, order, hints) {
  const resolved = resolveSaleCommercialLookup(item, order, hints);
  const ext = resolved.externalListingId;
  if (!ext) {
    return {
      listing_sales_quantity: null,
      listing_sales_amount_brl: null,
      source: "none",
    };
  }

  const variants = externalListingIdKeyVariants(ext);
  const marketplaces =
    resolved.marketplaceCandidates.length > 0
      ? resolved.marketplaceCandidates
      : [...ML_MARKETPLACE_LISTING_ALIASES];

  /** @type {Record<string, unknown> | null} */
  let metricsRow = null;
  for (const mkt of marketplaces) {
    try {
      const row = await fetchListingMetricsRow(supabase, userId, mkt, variants);
      if (row) {
        metricsRow = row;
        break;
      }
    } catch {
      /* try next marketplace slug */
    }
  }

  if (metricsRow) {
    const qty = qtyIntString(metricsRow.qty_sold_total);
    const gross = toNum(metricsRow.gross_revenue_total);
    return {
      listing_sales_quantity: qty,
      listing_sales_amount_brl: gross != null ? moneyDecimalString(new Decimal(String(gross))) : null,
      source: "listing_sales_metrics",
    };
  }

  const fallback = await fallbackListingMetricsFromOrderItems(supabase, userId, resolved);
  return {
    listing_sales_quantity: fallback.qty,
    listing_sales_amount_brl: fallback.amount,
    source: fallback.source,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null} order
 * @param {Record<string, unknown> | null | undefined} uiRow
 * @param {string | null} listingInternalId
 */
export const EMPTY_SALE_CONTEXT_METRICS = {
  listing_sales_quantity: null,
  listing_sales_amount_brl: null,
  product_sales_quantity: null,
  product_sales_amount_brl: null,
};

/**
 * @param {{
 *   saleId?: string | null;
 *   orderId?: string | null;
 *   listingId?: string | null;
 *   productId?: string | null;
 *   listingMetrics: Record<string, unknown>;
 *   productMetrics: Record<string, unknown>;
 * }} ctx
 */
function logSaleRayxAccumulatedPerformanceDebug(ctx) {
  if (process.env.S7_SALE_RAYX_ACCUMULATED_PERFORMANCE_DEBUG !== "1") return;

  console.log("[S7_SALE_RAYX_ACCUMULATED_PERFORMANCE]", {
    sale_id: ctx.saleId ?? null,
    order_id: ctx.orderId ?? null,
    listing_id: ctx.listingId ?? null,
    product_id: ctx.productId ?? null,
    listing_qty: ctx.listingMetrics.listing_sales_quantity ?? null,
    listing_gross_amount: ctx.listingMetrics.listing_sales_amount_brl ?? null,
    product_qty: ctx.productMetrics.product_sales_quantity ?? null,
    product_gross_amount: ctx.productMetrics.product_sales_amount_brl ?? null,
    source_listing: ctx.listingMetrics.source ?? null,
    source_product: ctx.productMetrics.source ?? null,
    fallback_used: ctx.productMetrics.fallback_used === true,
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null} order
 * @param {Record<string, unknown> | null | undefined} uiRow
 * @param {string | null} listingInternalId
 */
export async function fetchSaleContextMetrics(supabase, userId, item, order, uiRow, listingInternalId) {
  try {
    const listingId = listingInternalId != null ? String(listingInternalId).trim() : "";
    /** @type {Record<string, unknown> | null} */
    let listingRow = null;
    if (listingId) {
      const { data, error } = await supabase
        .from("marketplace_listings")
        .select("external_listing_id, marketplace, marketplace_account_id, seller_company_id")
        .eq("user_id", userId)
        .eq("id", listingId)
        .maybeSingle();
      if (error && !isIgnorableMetricsSchemaError(error)) throw error;
      listingRow = data && typeof data === "object" ? data : null;
    }

    const lookupHints = {
      listingIdDisplay: uiRow?.listing_id_display ?? null,
      listingExternalId: listingRow?.external_listing_id ?? null,
      listingMarketplace: listingRow?.marketplace ?? null,
    };

    const productId = uiRow?.product_id != null ? String(uiRow.product_id).trim() : "";
    const [listingMetrics, productMetrics] = await Promise.all([
      fetchListingAccumulatedMetrics(supabase, userId, item, order, lookupHints).catch((error) => {
        console.warn("[sales/detail] listing_accumulated_metrics_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return {
          listing_sales_quantity: null,
          listing_sales_amount_brl: null,
          source: "error",
        };
      }),
      productId
        ? resolveProductLifetimeSalesMetricsFromCatalogSsot(supabase, userId, productId).catch((error) => {
            console.warn("[sales/detail] product_accumulated_metrics_failed", {
              message: error instanceof Error ? error.message : String(error),
            });
            return {
              product_sales_quantity: null,
              product_sales_amount_brl: null,
              source: "error",
              fallback_used: true,
            };
          })
        : Promise.resolve({
            product_sales_quantity: null,
            product_sales_amount_brl: null,
            source: "missing_product_id",
            fallback_used: true,
          }),
    ]);

    const payload = {
      listing_sales_quantity: listingMetrics.listing_sales_quantity,
      listing_sales_amount_brl: listingMetrics.listing_sales_amount_brl,
      product_sales_quantity: productMetrics.product_sales_quantity,
      product_sales_amount_brl: productMetrics.product_sales_amount_brl,
    };

    logSaleRayxAccumulatedPerformanceDebug({
      saleId: item?.id != null ? String(item.id) : null,
      orderId: item?.sales_order_id != null ? String(item.sales_order_id) : order?.id != null ? String(order.id) : null,
      listingId:
        uiRow?.listing_id_display != null
          ? String(uiRow.listing_id_display)
          : item?.external_listing_id != null
            ? String(item.external_listing_id)
            : null,
      productId: productId || null,
      listingMetrics,
      productMetrics,
    });

    return payload;
  } catch (error) {
    console.warn("[sales/detail] sale_context_metrics_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { ...EMPTY_SALE_CONTEXT_METRICS };
  }
}
