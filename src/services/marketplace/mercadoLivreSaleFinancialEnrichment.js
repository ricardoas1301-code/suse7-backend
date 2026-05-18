import Decimal from "decimal.js";
import {
  fetchMercadoLivreOrderDiscountsById,
  fetchMercadoLivreShipmentById,
  fetchOrderById,
} from "../../handlers/ml/_helpers/mercadoLibreOrdersApi.js";
import { toFiniteNumber } from "../../handlers/ml/_helpers/mlItemMoneyExtract.js";
import {
  resolveMercadoLivreFinancialFormula,
  resolveMercadoLivreShippingSellerCost,
} from "../../domain/sales/mercadoLivreSaleFinancialFormula.js";
import { formatMercadoLivreListingTypeLabel } from "../../domain/sales/mercadoLivreSaleRevenueRules.js";

export const ML_FINANCIAL_ENRICHMENT_SOURCE = "mercado_livre_financial_enrichment_v1";
export const ML_FINANCIAL_SNAPSHOT_VERSION = "ml_financial_v2";

/** @param {unknown} v */
function parseMlMoney(v) {
  return toFiniteNumber(v);
}

/** @param {unknown} v */
function pickTrim(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s;
}

/**
 * @param {Record<string, unknown>} order
 */
export function resolveMercadoLivreShipmentIdFromOrder(order) {
  if (!order || typeof order !== "object") return null;
  const shipping = order.shipping && typeof order.shipping === "object" ? /** @type {Record<string, unknown>} */ (order.shipping) : null;
  const s7 =
    order._s7_delivery && typeof order._s7_delivery === "object"
      ? /** @type {Record<string, unknown>} */ (order._s7_delivery)
      : null;
  for (const v of [shipping?.id, order.shipment_id, s7?.shipment_id]) {
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

/**
 * @param {unknown} shipment
 * @param {number | null} [grossHint]
 */
export function extractSellerShippingCostFromShipmentSnapshot(shipment, grossHint = null) {
  const grossDec = grossHint != null && grossHint > 0 ? new Decimal(grossHint) : null;
  const resolved = resolveMercadoLivreShippingSellerCost(shipment, grossDec);
  return resolved.amount;
}

/**
 * @param {unknown} discountsPayload
 * @param {string | null | undefined} externalOrderItemId
 */
export function extractPositiveAdjustmentsFromDiscountsSnapshot(discountsPayload, externalOrderItemId = null) {
  const want = externalOrderItemId != null ? String(externalOrderItemId).trim() : "";
  /** @type {number[]} */
  const amounts = [];

  const consider = (row) => {
    if (!row || typeof row !== "object") return;
    const o = /** @type {Record<string, unknown>} */ (row);
    if (want) {
      const lineRef =
        o.order_item_id != null
          ? String(o.order_item_id).trim()
          : o.item_id != null
            ? String(o.item_id).trim()
            : "";
      if (lineRef && lineRef !== want) return;
    }
    const type = String(o.type ?? o.discount_type ?? o.coupon_type ?? "").toLowerCase();
    const isCredit =
      /coupon|discount|rebate|bonus|campaign|cashback|credit|refund|estorno|compensation|subsidy|promo/.test(type) ||
      o.benefited != null;
    const amt = parseMlMoney(
      o.amount ?? o.coupon_amount ?? o.discount_amount ?? o.total_amount ?? o.value ?? o.details?.amount,
    );
    if (amt != null && amt > 0.001 && (isCredit || type === "")) amounts.push(amt);
  };

  if (Array.isArray(discountsPayload)) {
    for (const row of discountsPayload) consider(row);
  } else if (discountsPayload && typeof discountsPayload === "object") {
    const root = /** @type {Record<string, unknown>} */ (discountsPayload);
    const arr = root.results ?? root.discounts ?? root.coupons ?? root.items;
    if (Array.isArray(arr)) {
      for (const row of arr) consider(row);
    } else {
      consider(root);
    }
  }

  if (amounts.length === 0) return null;
  return Math.max(...amounts);
}

/**
 * @param {Record<string, unknown>} order
 * @param {Record<string, unknown> | null | undefined} line
 * @param {{ qty?: number; unitPrice?: number | null }} [opts]
 */
export function extractMarketplaceFeeFromOrderPayments(order, line, opts = {}) {
  const payments = order.payments;
  if (!Array.isArray(payments) || payments.length === 0) return null;

  let feeSum = new Decimal(0);
  let any = false;
  for (const p of payments) {
    if (!p || typeof p !== "object") continue;
    const pay = /** @type {Record<string, unknown>} */ (p);
    const feeDetails =
      pay.fee_details && typeof pay.fee_details === "object"
        ? /** @type {Record<string, unknown>} */ (pay.fee_details)
        : null;
    const fee = parseMlMoney(
      pay.marketplace_fee ?? pay.marketplace_fee_amount ?? feeDetails?.marketplace_fee ?? pay.sale_fee,
    );
    if (fee != null && fee > 0) {
      feeSum = feeSum.plus(fee);
      any = true;
    }
  }
  if (!any) return null;

  const lineGross =
    parseMlMoney(line?.total_amount) ?? (opts.unitPrice != null && opts.qty != null ? opts.unitPrice * opts.qty : null);
  let orderGross = parseMlMoney(order.total_amount ?? order.paid_amount);
  if (orderGross == null && Array.isArray(order.order_items)) {
    let sum = 0;
    for (const it of order.order_items) {
      const g = parseMlMoney(it?.total_amount);
      if (g != null) sum += g;
    }
    if (sum > 0) orderGross = sum;
  }

  if (lineGross != null && orderGross != null && orderGross > 0 && lineGross > 0 && orderGross > lineGross + 0.01) {
    return { fee: feeSum.mul(new Decimal(lineGross).div(orderGross)), source: "payments.marketplace_fee_proportional" };
  }

  return { fee: feeSum, source: "payments.marketplace_fee" };
}

/** @param {Record<string, unknown> | null | undefined} fin */
export function isFinancialSnapshotVersionCurrent(fin) {
  if (!fin || typeof fin !== "object") return false;
  const version = fin.snapshot_version != null ? String(fin.snapshot_version).trim() : "";
  return version === ML_FINANCIAL_SNAPSHOT_VERSION;
}

/** @param {Record<string, unknown> | null | undefined} fin */
function hasRequiredFinancialSnapshotFields(fin) {
  if (!fin || typeof fin !== "object") return false;
  const gross = fin.gross_sale_amount_brl != null ? String(fin.gross_sale_amount_brl).trim() : "";
  const fee = fin.marketplace_fee_amount_brl != null ? String(fin.marketplace_fee_amount_brl).trim() : "";
  const shipping = fin.shipping_amount_brl != null ? String(fin.shipping_amount_brl).trim() : "";
  const net = fin.net_received_amount_brl != null ? String(fin.net_received_amount_brl).trim() : "";
  return gross !== "" && fee !== "" && shipping !== "" && net !== "";
}

/** @param {Record<string, unknown> | null | undefined} fin */
export function isItemFinancialSnapshotComplete(fin) {
  if (!fin || typeof fin !== "object") return false;
  if (fin.snapshot_complete === false) return false;
  if (!isFinancialSnapshotVersionCurrent(fin)) return false;
  return hasRequiredFinancialSnapshotFields(fin);
}

/**
 * @param {Record<string, unknown> | null | undefined} fin
 */
export function validateFinancialSnapshot(fin) {
  if (!fin || typeof fin !== "object") {
    return {
      snapshot_complete: false,
      snapshot_version: null,
      is_legacy_snapshot: true,
      should_reenrich: true,
      reason: "missing_snapshot",
    };
  }

  const snapshotVersion = fin.snapshot_version != null ? String(fin.snapshot_version).trim() : null;
  const isLegacySnapshot = !isFinancialSnapshotVersionCurrent(fin);
  const fieldsComplete = hasRequiredFinancialSnapshotFields(fin);
  const snapshotComplete = fin.snapshot_complete === true && fieldsComplete && !isLegacySnapshot;

  /** @type {string} */
  let reason = "ok";
  if (isLegacySnapshot) {
    reason = snapshotVersion ? `snapshot_version_mismatch:${snapshotVersion}` : "snapshot_version_missing";
  } else if (fin.snapshot_complete === false) {
    reason = "snapshot_complete_false";
  } else if (!fieldsComplete) {
    reason = "snapshot_incomplete_fields";
  }

  const shouldReenrich = isLegacySnapshot || fin.snapshot_complete === false || !fieldsComplete;

  return {
    snapshot_complete: snapshotComplete,
    snapshot_version: snapshotVersion,
    is_legacy_snapshot: isLegacySnapshot,
    should_reenrich: shouldReenrich,
    reason,
  };
}

/**
 * @param {Record<string, unknown>} itemRow
 */
export function itemNeedsFinancialEnrichment(itemRow) {
  const raw =
    itemRow.raw_json && typeof itemRow.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (itemRow.raw_json)
      : null;
  const fin = raw?._s7_financial;
  return validateFinancialSnapshot(fin && typeof fin === "object" ? fin : null).should_reenrich;
}

/**
 * @param {Record<string, unknown>} order
 * @param {Array<Record<string, unknown>>} dbItems
 */
function resolveOrderLinesForEnrichment(order, dbItems) {
  if (Array.isArray(order.order_items) && order.order_items.length > 0) {
    return /** @type {Record<string, unknown>[]} */ (order.order_items);
  }

  const nested = order.raw_json && typeof order.raw_json === "object" ? order.raw_json : null;
  if (nested && Array.isArray(nested.order_items) && nested.order_items.length > 0) {
    return /** @type {Record<string, unknown>[]} */ (nested.order_items);
  }

  /** @type {Record<string, unknown>[]} */
  const fromItems = [];
  for (const row of dbItems) {
    if (row.raw_json && typeof row.raw_json === "object") {
      fromItems.push(/** @type {Record<string, unknown>} */ (row.raw_json));
    }
  }
  return fromItems;
}

/**
 * @param {Record<string, unknown>} line
 */
function collectLineIdAliases(line) {
  /** @type {string[]} */
  const out = [];
  for (const key of ["id", "order_item_id"]) {
    const v = pickTrim(line[key]);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} itemRow
 */
function collectDbItemMatchKeys(itemRow, orderExternalId = "") {
  /** @type {string[]} */
  const keys = [];
  const push = (v) => {
    const s = pickTrim(v);
    if (!s || keys.includes(s)) return;
    if (orderExternalId && s === orderExternalId) return;
    keys.push(s);
  };

  push(itemRow.external_order_item_id);
  push(itemRow.id);

  const raw =
    itemRow.raw_json && typeof itemRow.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (itemRow.raw_json)
      : null;
  if (raw) {
    push(raw.id);
    push(raw.order_item_id);
  }

  return keys;
}

/**
 * @param {Record<string, unknown>} itemRow
 * @param {Record<string, unknown>[]} orderLines
 * @param {string} orderExternalId
 */
function matchDbItemToOrderLine(itemRow, orderLines, orderExternalId = "") {
  const keys = collectDbItemMatchKeys(itemRow, orderExternalId);
  for (const line of orderLines) {
    if (!line || typeof line !== "object") continue;
    const aliases = collectLineIdAliases(line);
    if (keys.some((k) => aliases.includes(k))) return line;
  }

  if (orderLines.length === 1) return orderLines[0];

  const raw =
    itemRow.raw_json && typeof itemRow.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (itemRow.raw_json)
      : null;
  if (raw && (raw.total_amount != null || raw.sale_fee != null || raw.unit_price != null)) {
    return raw;
  }

  return null;
}

/**
 * @param {Record<string, unknown>} revenue
 * @param {{
 *   orderId: string | null;
 *   shipmentId: string | null;
 *   itemRow: Record<string, unknown>;
 *   line: Record<string, unknown> | null;
 * }} meta
 */
function toItemFinancialContract(revenue, meta) {
  const line = meta.line ?? {};
  const qty = Math.max(1, Math.trunc(Number(meta.itemRow.quantity ?? line.quantity ?? 1)));
  const unit = parseMlMoney(meta.itemRow.unit_price ?? line.unit_price ?? line.discounted_unit_price);
  const listingTypeId =
    revenue.listing_type_id != null
      ? String(revenue.listing_type_id)
      : line.listing_type_id != null
        ? String(line.listing_type_id)
        : line.item &&
            typeof line.item === "object" &&
            /** @type {Record<string, unknown>} */ (line.item).listing_type_id != null
          ? String(/** @type {Record<string, unknown>} */ (line.item).listing_type_id)
          : null;

  const nowIso = new Date().toISOString();
  const snapshotComplete = revenue.snapshot_complete === true;

  return {
    source: ML_FINANCIAL_ENRICHMENT_SOURCE,
    gross_sale_amount_brl: revenue.gross_sale_amount_brl ?? null,
    marketplace_fee_amount_brl: revenue.marketplace_fee_amount_brl ?? null,
    marketplace_fee_net_amount_brl: revenue.marketplace_fee_net_amount_brl ?? null,
    marketplace_fee_percent: revenue.marketplace_fee_percent ?? null,
    listing_type_id: listingTypeId,
    listing_type_label: revenue.listing_type_label ?? formatMercadoLivreListingTypeLabel(listingTypeId),
    shipping_amount_brl: revenue.shipping_amount_brl ?? null,
    positive_adjustments_brl: revenue.positive_adjustments_brl ?? null,
    net_received_amount_brl: snapshotComplete ? (revenue.net_received_amount_brl ?? null) : null,
    snapshot_complete: snapshotComplete,
    missing_fields: revenue.formula_debug?.missing_fields ?? null,
    unit_price_brl: unit != null ? new Decimal(unit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
    quantity: qty,
    ml_order_id: meta.orderId,
    ml_shipping_id: meta.shipmentId,
    sales_order_item_id: meta.itemRow.id != null ? String(meta.itemRow.id) : null,
    external_order_item_id:
      meta.itemRow.external_order_item_id != null ? String(meta.itemRow.external_order_item_id) : null,
    sources: revenue._sources ?? revenue.sources ?? null,
    formula_debug: revenue.formula_debug ?? null,
    updated_at: nowIso,
  };
}

function isEnrichmentDebugEnabled() {
  return process.env.NODE_ENV !== "production" || process.env.S7_SALES_DETAIL_DEBUG === "1";
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} salesOrderId
 * @param {Record<string, unknown>} order
 * @param {{
 *   shipmentSnapshot: Record<string, unknown> | null;
 *   discountsSnapshot: unknown;
 *   shipmentId: string | null;
 *   orderId: string;
 *   debug: Record<string, unknown>;
 * }} ctx
 */
async function persistFinancialEnrichmentToDatabase(supabase, userId, salesOrderId, order, ctx) {
  const nowIso = new Date().toISOString();
  const orderExternalId = order.id != null ? String(order.id).trim() : "";

  const { data: items, error: itemsErr } = await supabase
    .from("sales_order_items")
    .select("id, external_order_item_id, external_order_id, quantity, unit_price, gross_amount, fee_amount, shipping_share_amount, net_amount, raw_json")
    .eq("user_id", userId)
    .eq("sales_order_id", salesOrderId);
  if (itemsErr) throw itemsErr;

  const dbItems = (items || []).filter((r) => r && typeof r === "object");
  const orderLines = resolveOrderLinesForEnrichment(order, dbItems);

  /** @type {Record<string, Record<string, unknown>>} */
  const linesIndex = {};
  /** @type {Array<Record<string, unknown>>} */
  const persistLog = [];

  for (const itemRow of dbItems) {
    const row = /** @type {Record<string, unknown>} */ (itemRow);
    const line = matchDbItemToOrderLine(row, orderLines, orderExternalId);

    const lineRaw =
      row.raw_json && typeof row.raw_json === "object" ? /** @type {Record<string, unknown>} */ ({ ...row.raw_json }) : {};

    const externalOrderItemId =
      row.external_order_item_id != null ? String(row.external_order_item_id).trim() : null;

    const revenue = resolveMercadoLivreFinancialFormula({
      order,
      line: line && typeof line === "object" ? line : {},
      shipmentSnapshot: ctx.shipmentSnapshot,
      discountsSnapshot: ctx.discountsSnapshot,
      externalOrderItemId,
    });

    const contract = toItemFinancialContract(revenue, {
      orderId: ctx.orderId,
      shipmentId: ctx.shipmentId,
      itemRow: row,
      line: line && typeof line === "object" ? line : null,
    });

    if (isEnrichmentDebugEnabled()) {
      console.log("[sales/detail] ml_financial_formula_debug", {
        order_id: ctx.orderId,
        item_id: row.id,
        external_order_item_id: externalOrderItemId,
        ...revenue.formula_debug,
      });
    }

    const mergedRaw = line ? { ...lineRaw, ...line } : lineRaw;
    mergedRaw._s7_financial = contract;
    if (ctx.shipmentSnapshot) {
      mergedRaw._s7_shipment_snapshot = ctx.shipmentSnapshot;
    }

    const patch = {
      raw_json: mergedRaw,
      updated_at: nowIso,
      gross_amount: contract.gross_sale_amount_brl ?? row.gross_amount,
    };
    if (contract.snapshot_complete) {
      patch.fee_amount = contract.marketplace_fee_amount_brl;
      patch.shipping_share_amount = contract.shipping_amount_brl;
      patch.net_amount = contract.net_received_amount_brl;
    }

    const { error: upErr } = await supabase.from("sales_order_items").update(patch).eq("id", row.id).eq("user_id", userId);
    if (upErr) throw upErr;

    linesIndex[String(row.id)] = contract;
    for (const key of collectDbItemMatchKeys(row, orderExternalId)) {
      linesIndex[key] = contract;
    }
    if (line) {
      for (const alias of collectLineIdAliases(line)) {
        linesIndex[alias] = contract;
      }
    }

    persistLog.push({
      sales_order_item_id: row.id,
      external_order_item_id: row.external_order_item_id ?? null,
      matched_line: Boolean(line),
      gross: contract.gross_sale_amount_brl,
      fee: contract.marketplace_fee_amount_brl,
      shipping: contract.shipping_amount_brl,
      net: contract.net_received_amount_brl,
      snapshot_complete: contract.snapshot_complete,
      missing_fields: contract.missing_fields,
    });
  }

  const enrichedOrder = {
    ...order,
    _s7_financial: {
      enriched_at: nowIso,
      order_id: ctx.orderId,
      shipment_id: ctx.shipmentId,
      shipment_snapshot: ctx.shipmentSnapshot,
      discounts_snapshot: ctx.discountsSnapshot,
      lines: linesIndex,
    },
  };

  const { error: ordErr } = await supabase
    .from("sales_orders")
    .update({ raw_json: enrichedOrder, updated_at: nowIso })
    .eq("user_id", userId)
    .eq("id", salesOrderId);
  if (ordErr) throw ordErr;

  if (isEnrichmentDebugEnabled()) {
    console.log("[sales/detail] ml_financial_enrichment_persist", {
      sales_order_id: salesOrderId,
      order_id: ctx.orderId,
      order_lines_count: orderLines.length,
      db_items_count: dbItems.length,
      lines_index_keys: Object.keys(linesIndex),
      items: persistLog,
    });
  }

  return { enrichedOrder, linesIndex, persistLog };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} order
 * @param {{
 *   accessToken: string;
 *   marketplaceAccountId?: string | null;
 *   salesOrderId?: string | null;
 *   logContext?: string;
 *   force?: boolean;
 * }} opts
 */
export async function enrichMercadoLivreSaleFinancialSnapshot(supabase, userId, order, opts) {
  const accessToken = opts.accessToken != null ? String(opts.accessToken).trim() : "";
  if (!accessToken || !order || typeof order !== "object") {
    return { order, debug: { skipped: "no_token_or_order" } };
  }

  let orderPayload = { ...order };
  const orderId = orderPayload.id != null ? String(orderPayload.id).trim() : "";

  if ((!Array.isArray(orderPayload.order_items) || orderPayload.order_items.length === 0) && orderId) {
    try {
      const fresh = await fetchOrderById(accessToken, orderId, {
        marketplaceAccountId: opts.marketplaceAccountId ?? null,
      });
      if (fresh && typeof fresh === "object") {
        orderPayload = { ...orderPayload, ...fresh, order_items: fresh.order_items ?? orderPayload.order_items };
      }
    } catch (e) {
      /** segue com payload local */
    }
  }

  const shipmentId = resolveMercadoLivreShipmentIdFromOrder(orderPayload);
  const mpAcct = opts.marketplaceAccountId ?? null;

  /** @type {Record<string, unknown>} */
  const debug = {
    order_id: orderId || null,
    shipping_id: shipmentId,
    fetched_shipment: false,
    discounts_fetched: false,
    shipment_cost_candidates: [],
    positive_adjustments_candidates: [],
    selected_fee_source: null,
    selected_shipping_source: null,
    selected_positive_adjustments_source: null,
  };

  /** @type {Record<string, unknown> | null} */
  let shipmentSnapshot = null;
  if (shipmentId) {
    try {
      shipmentSnapshot = await fetchMercadoLivreShipmentById(accessToken, shipmentId, {
        marketplaceAccountId: mpAcct,
      });
      debug.fetched_shipment = true;
      const shipCost = extractSellerShippingCostFromShipmentSnapshot(shipmentSnapshot);
      if (shipCost != null) {
        debug.shipment_cost_candidates.push({ source: "shipment_api", amount: shipCost });
      }
    } catch (e) {
      debug.shipment_fetch_error = e instanceof Error ? e.message : String(e);
    }
  }

  /** @type {unknown} */
  let discountsSnapshot = null;
  if (orderId) {
    try {
      discountsSnapshot = await fetchMercadoLivreOrderDiscountsById(accessToken, orderId, {
        marketplaceAccountId: mpAcct,
      });
      debug.discounts_fetched = true;
      const pos = extractPositiveAdjustmentsFromDiscountsSnapshot(discountsSnapshot);
      if (pos != null) {
        debug.positive_adjustments_candidates.push({ source: "orders_discounts_api", amount: pos });
      }
    } catch (e) {
      debug.discounts_fetch_error = e instanceof Error ? e.message : String(e);
    }
  }

  if (opts.salesOrderId && supabase) {
    const { enrichedOrder, linesIndex, persistLog } = await persistFinancialEnrichmentToDatabase(
      supabase,
      userId,
      opts.salesOrderId,
      orderPayload,
      {
        shipmentSnapshot,
        discountsSnapshot,
        shipmentId,
        orderId,
        debug,
      },
    );

    const sample = persistLog[0] ?? null;
    if (sample) {
      debug.selected_fee_source = "persisted_per_item";
      debug.selected_shipping_source = "persisted_per_item";
      debug.final_marketplace_revenue = sample;
    }

    if (isEnrichmentDebugEnabled()) {
      console.log("[sales/detail] ml_financial_enrichment_debug", {
        ...debug,
        log_context: opts.logContext ?? null,
        line_keys: Object.keys(linesIndex),
        final_marketplace_revenue: sample,
      });
    }

    return { order: enrichedOrder, debug, lineSnapshots: linesIndex };
  }

  return { order: orderPayload, debug, lineSnapshots: {} };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 * @param {string} accessToken
 */
/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown> | null | undefined} order
 */
export function logFinancialSnapshotValidation(item, order) {
  const raw =
    item.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;
  const fin = raw?._s7_financial;
  const validation = validateFinancialSnapshot(fin && typeof fin === "object" ? fin : null);

  console.log("[sales/detail] financial_snapshot_validation", {
    item_id: item.id != null ? String(item.id) : null,
    external_order_id:
      item.external_order_id != null
        ? String(item.external_order_id)
        : order?.external_order_id != null
          ? String(order.external_order_id)
          : null,
    snapshot_complete: validation.snapshot_complete,
    snapshot_version: validation.snapshot_version,
    is_legacy_snapshot: validation.is_legacy_snapshot,
    should_reenrich: validation.should_reenrich,
    reason: validation.reason,
  });

  return validation;
}

export async function ensureMercadoLivreSaleFinancialEnrichmentForDetail(supabase, userId, item, order, accessToken) {
  if (!order?.id) {
    return { order, item, enriched: false };
  }

  const validation = logFinancialSnapshotValidation(item, order);
  if (!validation.should_reenrich) {
    return { order, item, enriched: false };
  }

  const orderRaw =
    order.raw_json && typeof order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ ({ .../** @type {Record<string, unknown>} */ (order.raw_json) })
      : {};

  const marketplaceAccountId =
    item.marketplace_account_id != null
      ? String(item.marketplace_account_id).trim()
      : order.marketplace_account_id != null
        ? String(order.marketplace_account_id).trim()
        : null;

  const { order: enrichedOrder } = await enrichMercadoLivreSaleFinancialSnapshot(supabase, userId, orderRaw, {
    accessToken,
    marketplaceAccountId,
    salesOrderId: order.id != null ? String(order.id) : null,
    logContext: "sales_detail_lazy",
    force: true,
  });

  const { data: refreshedItem, error: refErr } = await supabase
    .from("sales_order_items")
    .select("*")
    .eq("user_id", userId)
    .eq("id", item.id)
    .maybeSingle();
  if (refErr) throw refErr;

  const { data: refreshedOrder, error: ordErr } = await supabase
    .from("sales_orders")
    .select("id,order_status,external_order_id,raw_json,marketplace_account_id,marketplace,seller_company_id")
    .eq("user_id", userId)
    .eq("id", order.id)
    .maybeSingle();
  if (ordErr) throw ordErr;

  return {
    order: refreshedOrder ?? { ...order, raw_json: enrichedOrder },
    item: refreshedItem ?? item,
    enriched: true,
  };
}
