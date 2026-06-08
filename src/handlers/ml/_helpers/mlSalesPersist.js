// ======================================================
// FASE 3 — Persistência de vendas ML → sales_* + listing_sales_metrics
//
// Pedido:
// - upsert sales_orders por (marketplace, marketplace_account_id, external_order_id) — multi-conta
// - itens: DELETE por sales_order_id + INSERT (evita duplicata em resync;
//   external_order_item_id do ML é persistido em raw_json quando existir)
// - snapshot: append-only em order_raw_snapshots
//
// Consolidado:
// - após o sync, rebuildListingSalesMetricsForUser recalcula TODAS as linhas
//   de listing_sales_metrics do usuário+marketplace a partir de sales_order_items
//   (idempotente, sem soma duplicada em reimportações)
// ======================================================

import Decimal from "decimal.js";
import { ML_MARKETPLACE_SLUG } from "./mlMarketplace.js";
import { fetchOrderById } from "./mercadoLibreOrdersApi.js";
import {
  extractBuyerForGlobalSync,
  touchGlobalCustomerFromOrderContext,
} from "../../../services/customers/s7GlobalCustomerSync.js";

/** Chave estável para join com marketplace_listings / listing_sales_metrics. */
export function normalizeExternalListingId(id) {
  if (id == null) return "";
  return String(id).trim();
}

/**
 * ID do anúncio ML a partir de uma linha de pedido (order_items) ou do raw_json persistido.
 * Usado em mapMlOrderItemToRow e no backfill de linhas antigas com external_listing_id nulo.
 */
/** Primeira URL de foto do item na linha do pedido ML (persistência em thumbnail_snapshot). */
export function extractMlLineThumbnail(line) {
  if (!line || typeof line !== "object") return null;
  const itemObj = line.item && typeof line.item === "object" ? line.item : {};
  const th = itemObj.thumbnail ?? line.thumbnail;
  if (typeof th === "string" && th.trim()) return th.trim();
  if (th && typeof th === "object" && th.secure_url != null && String(th.secure_url).trim()) {
    return String(th.secure_url).trim();
  }
  const pics = itemObj.pictures ?? line.pictures;
  if (!Array.isArray(pics) || pics.length === 0) return null;
  const p0 = pics[0];
  if (p0 && typeof p0 === "object" && p0.secure_url) return String(p0.secure_url).trim();
  if (p0 && typeof p0 === "object" && p0.url) return String(p0.url).trim();
  return null;
}

export function extractExternalListingIdFromOrderLine(line) {
  if (!line || typeof line !== "object") return null;
  const itemObj = line.item && typeof line.item === "object" ? line.item : {};
  const bundleFirst =
    Array.isArray(line.bundle_items) && line.bundle_items[0] && typeof line.bundle_items[0] === "object"
      ? line.bundle_items[0].item
      : null;
  const raw =
    itemObj.id ??
    line.item_id ??
    line.item?.id ??
    line.listing_id ??
    line.product_id ??
    (bundleFirst && typeof bundleFirst === "object" ? bundleFirst.id : null);
  return raw != null ? normalizeExternalListingId(raw) : null;
}

/** @param {unknown} v */
function toFiniteNumber(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} v */
function toInt(v) {
  const n = toFiniteNumber(v);
  if (n == null) return null;
  return Math.trunc(n);
}

/**
 * Valores monetários ML podem vir number, string ("99.90" / "99,90") ou
 * objeto { value, amount, total } (às vezes aninhado em currency_id).
 */
function parseMlMoney(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const lastComma = t.lastIndexOf(",");
    const lastDot = t.lastIndexOf(".");
    if (lastComma !== -1 && lastComma > lastDot) {
      return toFiniteNumber(t.replace(/\./g, "").replace(",", "."));
    }
    if (lastDot !== -1 && lastDot > lastComma) {
      return toFiniteNumber(t.replace(/,/g, ""));
    }
    return toFiniteNumber(t.replace(",", "."));
  }
  if (typeof v === "object") {
    const inner = v.value ?? v.amount ?? v.total;
    if (inner != null && inner !== v) return parseMlMoney(inner);
  }
  return toFiniteNumber(v);
}

/**
 * Preços por linha em order_items (ML varia formato; vários fallbacks).
 *
 * Regras finais:
 * - unit_price: preço efetivo de venda (promo/desconto antes de preço de tabela quando existir).
 * - gross_amount: total da linha; se a API não mandar total explícito, quantity * unit_price.
 * - fee_amount: sale_fee da linha quando existir.
 * - net_amount: apenas quando há fee confiável → gross_amount - fee_amount; senão null
 *   (evita duplicar bruto como “líquido”; no rebuild, net usa fallback para gross só na agregação).
 */
export function extractOrderLinePricing(line) {
  const qty = toInt(line?.quantity) ?? 1;
  const itemObj = line?.item && typeof line.item === "object" ? line.item : {};

  const unitCandidates = [
    line?.discounted_unit_price,
    line?.unit_price,
    line?.paid_unit_price,
    line?.promotional_price,
    itemObj?.promotional_price,
    line?.full_unit_price,
    line?.base_unit_price,
    itemObj?.base_price,
    itemObj?.price,
  ];

  let unit = null;
  for (const c of unitCandidates) {
    unit = parseMlMoney(c);
    if (unit != null) break;
  }

  const grossCandidates = [
    line?.total_amount,
    line?.paid_amount,
    line?.transaction_amount,
    line?.gross_amount,
    line?.gross_price,
    line?.full_total_amount,
    line?.base_total_amount,
  ];

  let gross = null;
  for (const c of grossCandidates) {
    gross = parseMlMoney(c);
    if (gross != null) break;
  }

  if (gross == null && unit != null && qty > 0) {
    gross = unit * qty;
  }

  if (gross != null && unit != null && qty > 0) {
    const expected = unit * qty;
    const ratio = gross / expected;
    if (ratio > 0.01 && ratio < 0.99) {
      unit = gross / qty;
    }
  }

  let fee = parseMlMoney(line?.sale_fee ?? line?.listing_fee ?? line?.discount_fee);

  if (fee != null && gross != null && qty > 1) {
    const feeLineTotal = fee * qty;
    const ratioUnit = fee / gross;
    const ratioTotal = feeLineTotal / gross;
    if (ratioUnit > 0 && ratioUnit < 0.06 && ratioTotal >= 0.08 && ratioTotal <= 0.35) {
      fee = feeLineTotal;
    }
  }

  let net = null;
  if (gross != null && fee != null) {
    net = gross - fee;
  }

  return { qty, unit, gross, fee, net };
}

/**
 * Primeira data de pagamento aprovado (quando existir).
 */
function extractPaidAt(order) {
  const ps = order?.payments;
  if (!Array.isArray(ps) || ps.length === 0) return null;
  const dates = ps
    .map((p) => p?.date_approved || p?.date_created)
    .filter(Boolean)
    .sort();
  return dates.length > 0 ? String(dates[0]) : null;
}

/**
 * Soma simples de impostos no payload do pedido (quando houver).
 */
function extractTaxAmount(order) {
  const taxes = order?.taxes;
  if (!Array.isArray(taxes) || taxes.length === 0) return null;
  let sum = 0;
  let any = false;
  for (const t of taxes) {
    const v = parseMlMoney(t?.amount ?? t?.value);
    if (v != null) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

/**
 * Metadados de envio / entrega combinada (não bloqueia persistência se shipment estiver ausente).
 * @param {unknown} order
 */
export function extractMlOrderDeliveryMeta(order) {
  if (!order || typeof order !== "object") {
    return {
      shipping_mode: null,
      logistic_type: null,
      fulfillment_mode: null,
      shipping_status: null,
      shipment_id: null,
      needs_manual_delivery_arrangement: false,
      delivery_hints: [],
    };
  }
  const o = /** @type {Record<string, unknown>} */ (order);
  const shipping = o.shipping && typeof o.shipping === "object" ? /** @type {Record<string, unknown>} */ (o.shipping) : {};
  const tags = Array.isArray(o.tags) ? o.tags.map((t) => String(t)) : [];
  const statusDetail =
    o.status_detail && typeof o.status_detail === "object"
      ? /** @type {Record<string, unknown>} */ (o.status_detail).code
      : o.status_detail;
  const shippingMode = shipping.mode != null ? String(shipping.mode) : null;
  const logisticType = shipping.logistic_type != null ? String(shipping.logistic_type) : null;
  const fulfillmentMode =
    shipping.fulfillment_type != null
      ? String(shipping.fulfillment_type)
      : o.fulfillment_type != null
        ? String(o.fulfillment_type)
        : null;
  const shippingStatus = shipping.status != null ? String(shipping.status) : null;
  const shipmentId =
    shipping.id != null
      ? String(shipping.id)
      : o.shipment_id != null
        ? String(o.shipment_id)
        : null;
  const hints = [];
  const modeLower = shippingMode ? shippingMode.toLowerCase() : "";
  const logisticLower = logisticType ? logisticType.toLowerCase() : "";
  const statusDetailLower = statusDetail != null ? String(statusDetail).toLowerCase() : "";
  if (tags.some((t) => /combine|arrange|entrega|delivery/i.test(t))) hints.push("tag_delivery_arrangement");
  if (modeLower === "custom" || modeLower === "not_specified") hints.push("shipping_mode_non_standard");
  if (
    logisticLower === "self_service" ||
    logisticLower === "flex" ||
    logisticLower === "drop_off" ||
    logisticLower === "xd_drop_off"
  ) {
    hints.push("logistic_type_manual_or_flex");
  }
  if (/arrange|combine|deliver|entrega/.test(statusDetailLower)) hints.push("status_detail_delivery_arrangement");
  const needsManual =
    hints.length > 0 ||
    (modeLower === "custom" && !shipmentId) ||
    (logisticLower === "self_service" && !shipmentId);

  return {
    shipping_mode: shippingMode,
    logistic_type: logisticType,
    fulfillment_mode: fulfillmentMode,
    shipping_status: shippingStatus,
    shipment_id: shipmentId,
    needs_manual_delivery_arrangement: needsManual,
    delivery_hints: hints,
  };
}

/**
 * Anota o payload do pedido com metadados S7 de entrega (persistido em raw_json).
 * @param {unknown} order
 */
export function annotateMlOrderForPersist(order) {
  if (!order || typeof order !== "object") return order;
  const delivery = extractMlOrderDeliveryMeta(order);
  return {
    .../** @type {Record<string, unknown>} */ (order),
    _s7_delivery: delivery,
  };
}

/**
 * Normaliza candidatos a array de linhas de pedido (formatos variados da API ML).
 * @param {unknown} candidate
 * @returns {Record<string, unknown>[]}
 */
function unwrapMlOrderItemsCandidate(candidate) {
  if (candidate == null) return [];
  if (Array.isArray(candidate)) {
    return candidate.filter((x) => x && typeof x === "object").map((x) => /** @type {Record<string, unknown>} */ (x));
  }
  if (typeof candidate === "object") {
    const o = /** @type {Record<string, unknown>} */ (candidate);
    for (const key of ["elements", "items", "results", "order_items"]) {
      const nested = o[key];
      if (Array.isArray(nested) && nested.length > 0) {
        return nested.filter((x) => x && typeof x === "object").map((x) => /** @type {Record<string, unknown>} */ (x));
      }
    }
  }
  return [];
}

/**
 * Extrai linhas vendáveis do payload do pedido (independente de modalidade de envio).
 * @param {unknown} order
 * @returns {Record<string, unknown>[]}
 */
export function resolveMlOrderLinesFromOrder(order) {
  if (!order || typeof order !== "object") return [];
  const o = /** @type {Record<string, unknown>} */ (order);

  const sources = [
    o.order_items,
    o.items,
    o.orderItems,
    o._s7_order_items,
    o.raw_json && typeof o.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (o.raw_json).order_items
      : null,
    o.raw_json && typeof o.raw_json === "object" ? /** @type {Record<string, unknown>} */ (o.raw_json).items : null,
  ];

  for (const src of sources) {
    const lines = unwrapMlOrderItemsCandidate(src);
    if (lines.length > 0) return lines;
  }

  /** @type {Record<string, unknown>[]} */
  const bundleFlat = [];
  for (const src of [o.bundle_items, o.order_bundles]) {
    const arr = unwrapMlOrderItemsCandidate(src);
    for (const entry of arr) {
      if (entry.item && typeof entry.item === "object") {
        bundleFlat.push(entry);
      } else {
        bundleFlat.push(...unwrapMlOrderItemsCandidate(entry.order_items));
      }
    }
  }
  if (bundleFlat.length > 0) return bundleFlat;

  const synthesized = synthesizeMlOrderLineFromOrderShell(o);
  return synthesized ? [synthesized] : [];
}

/**
 * Último recurso: linha sintética a partir do cabeçalho do pedido (total/pagamentos),
 * sem regra por tipo de envio — apenas quando a API não enviou order_items.
 * @param {Record<string, unknown>} order
 * @returns {Record<string, unknown> | null}
 */
function synthesizeMlOrderLineFromOrderShell(order) {
  const total =
    parseMlMoney(order.total_amount) ??
    parseMlMoney(order.paid_amount) ??
    (order.order_totals && typeof order.order_totals === "object"
      ? parseMlMoney(/** @type {Record<string, unknown>} */ (order.order_totals).total)
      : null);
  if (total == null || total <= 0) return null;

  const payments = Array.isArray(order.payments) ? order.payments : [];
  const approved =
    payments.find((p) => p && typeof p === "object" && String(/** @type {Record<string, unknown>} */ (p).status || "").toLowerCase() === "approved") ??
    payments[0];
  const pay = approved && typeof approved === "object" ? /** @type {Record<string, unknown>} */ (approved) : null;

  const title = pay?.reason != null ? String(pay.reason).trim() : null;
  const unit =
    parseMlMoney(pay?.transaction_amount) ?? parseMlMoney(pay?.total_paid_amount) ?? total;

  let itemId = null;
  for (const key of ["item_id", "listing_id", "product_id"]) {
    if (order[key] != null && String(order[key]).trim() !== "") {
      itemId = String(order[key]).trim();
      break;
    }
  }
  if (!itemId && pay) {
    for (const key of ["item_id", "listing_id"]) {
      if (pay[key] != null && String(pay[key]).trim() !== "") {
        itemId = String(pay[key]).trim();
        break;
      }
    }
  }

  /** @type {Record<string, unknown>} */
  const item = {
    title: title || "Pedido Mercado Livre",
    seller_custom_field: null,
  };
  if (itemId) item.id = itemId;

  return {
    quantity: 1,
    unit_price: unit,
    full_unit_price: unit,
    currency_id: order.currency_id ?? pay?.currency_id ?? null,
    item,
    _s7_synthesized: {
      source: "order_shell",
      at: new Date().toISOString(),
      had_payments: payments.length > 0,
    },
  };
}

/**
 * Garante order_items no payload antes da persistência (refetch ML quando vazio).
 * @param {unknown} order
 * @param {string} [accessToken]
 * @param {{ marketplaceAccountId?: string | null; log?: (msg: string, extra?: Record<string, unknown>) => void }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function hydrateMlOrderLinesIfMissing(order, accessToken, options = {}) {
  if (!order || typeof order !== "object") return /** @type {Record<string, unknown>} */ ({});
  let o = { .../** @type {Record<string, unknown>} */ (order) };
  const log = options.log || (() => {});

  let lines = resolveMlOrderLinesFromOrder(o);
  if (lines.length > 0) {
    if (!Array.isArray(o.order_items) || o.order_items.length === 0) {
      o.order_items = lines;
    }
    return o;
  }

  const orderId = o.id != null ? String(o.id).trim() : "";
  const token = accessToken != null ? String(accessToken).trim() : "";

  if (token && orderId) {
    try {
      const fresh = await fetchOrderById(token, orderId, {
        marketplaceAccountId: options.marketplaceAccountId ?? null,
      });
      if (fresh && typeof fresh === "object") {
        o = { ...o, .../** @type {Record<string, unknown>} */ (fresh) };
        lines = resolveMlOrderLinesFromOrder(o);
        if (lines.length > 0) {
          log("hydrate_order_items_refetch_ok", { orderId, line_count: lines.length });
          o.order_items = lines;
          return o;
        }
      }
    } catch (e) {
      log("hydrate_order_items_refetch_failed", {
        orderId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  lines = resolveMlOrderLinesFromOrder(o);
  if (lines.length > 0) {
    o.order_items = lines;
    return o;
  }

  const synthesized = synthesizeMlOrderLineFromOrderShell(o);
  if (synthesized) {
    log("hydrate_order_items_synthesized", { orderId: orderId || null });
    o.order_items = [synthesized];
  } else {
    const delivery = extractMlOrderDeliveryMeta(o);
    log("hydrate_order_items_still_empty", {
      orderId: orderId || null,
      shipping_status: delivery.shipping_status,
      shipment_id: delivery.shipment_id,
    });
  }
  return o;
}

/**
 * Repara pedidos já gravados em sales_orders sem linhas em sales_order_items,
 * usando order_items presentes em raw_json (ex.: após enrichment/refetch).
 */
export async function backfillMissingSalesOrderItemsFromOrderRaw(supabase, userId, marketplace, log = () => {}) {
  const { data: orders, error: oErr } = await supabase
    .from("sales_orders")
    .select("id, external_order_id, raw_json, marketplace_account_id, seller_company_id")
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .order("updated_at", { ascending: false })
    .limit(800);

  if (oErr) {
    log("backfill_items_fetch_orders_failed", { oErr });
    throw oErr;
  }

  let repairedOrders = 0;
  let insertedLines = 0;
  const nowIso = new Date().toISOString();

  for (const ord of orders || []) {
    const salesOrderId = ord.id;
    const { count, error: cErr } = await supabase
      .from("sales_order_items")
      .select("id", { count: "exact", head: true })
      .eq("sales_order_id", salesOrderId);
    if (cErr) {
      log("backfill_items_count_failed", { salesOrderId, cErr });
      continue;
    }
    if ((count ?? 0) > 0) continue;

    const raw = ord.raw_json && typeof ord.raw_json === "object" ? ord.raw_json : null;
    const lines = resolveMlOrderLinesFromOrder(raw ?? {});
    if (lines.length === 0) continue;

    const extPreview = ord.external_order_id != null ? String(ord.external_order_id) : null;
    const marketplaceAccountId =
      ord.marketplace_account_id != null ? String(ord.marketplace_account_id).trim() : null;
    const sellerCompanyId = ord.seller_company_id != null ? String(ord.seller_company_id).trim() : null;

    const rows = lines.map((line) =>
      mapMlOrderItemToRow(
        userId,
        marketplace,
        salesOrderId,
        line,
        nowIso,
        marketplaceAccountId,
        sellerCompanyId,
        extPreview
      )
    );

    const { error: insErr } = await supabase.from("sales_order_items").insert(rows);
    if (insErr) {
      log("backfill_items_insert_failed", { salesOrderId, external_order_id: extPreview, insErr });
      continue;
    }
    repairedOrders += 1;
    insertedLines += rows.length;
  }

  log("backfill_items_from_raw_done", { repairedOrders, insertedLines });
  return { repairedOrders, insertedLines };
}

/**
 * Insere sales_order_items quando o pedido existe mas a listagem /vendas ficaria vazia.
 * Usado após enrichment/refetch que populou order_items em raw_json.
 */
export async function ensureSalesOrderItemsFromOrderLines(
  supabase,
  userId,
  salesOrderId,
  order,
  marketplace = ML_MARKETPLACE_SLUG
) {
  const { count, error: cErr } = await supabase
    .from("sales_order_items")
    .select("id", { count: "exact", head: true })
    .eq("sales_order_id", salesOrderId);
  if (cErr) throw cErr;
  if ((count ?? 0) > 0) return { inserted: 0, skipped: "already_has_items" };

  const lines = resolveMlOrderLinesFromOrder(order);
  if (lines.length === 0) return { inserted: 0, skipped: "no_lines" };

  const { data: salesOrder, error: oErr } = await supabase
    .from("sales_orders")
    .select("external_order_id, marketplace_account_id, seller_company_id")
    .eq("id", salesOrderId)
    .eq("user_id", userId)
    .maybeSingle();
  if (oErr) throw oErr;
  if (!salesOrder) return { inserted: 0, skipped: "order_not_found" };

  const nowIso = new Date().toISOString();
  const extPreview =
    salesOrder.external_order_id != null ? String(salesOrder.external_order_id) : null;
  const marketplaceAccountId =
    salesOrder.marketplace_account_id != null ? String(salesOrder.marketplace_account_id).trim() : null;
  const sellerCompanyId =
    salesOrder.seller_company_id != null ? String(salesOrder.seller_company_id).trim() : null;

  const rows = lines.map((line) =>
    mapMlOrderItemToRow(
      userId,
      marketplace,
      salesOrderId,
      line,
      nowIso,
      marketplaceAccountId,
      sellerCompanyId,
      extPreview
    )
  );

  const { error: insErr } = await supabase.from("sales_order_items").insert(rows);
  if (insErr) throw insErr;
  return { inserted: rows.length, skipped: null };
}

/**
 * Monta linha sales_orders a partir do GET /orders/:id.
 */
export function mapMlOrderToSalesOrderRow(
  userId,
  order,
  marketplace,
  nowIso,
  marketplaceAccountId = null,
  sellerCompanyId = null
) {
  const extId = order?.id != null ? String(order.id) : null;
  if (!extId) throw new Error("Pedido ML sem id");

  const total =
    parseMlMoney(order.total_amount) ??
    parseMlMoney(order.paid_amount) ??
    parseMlMoney(order.order_totals?.total);

  const ship =
    parseMlMoney(order.shipping_cost) ??
    parseMlMoney(order.shipping?.cost) ??
    parseMlMoney(order.order_totals?.shipping);

  const deliveryMeta = extractMlOrderDeliveryMeta(order);
  const rawOrder =
    order && typeof order === "object"
      ? {
          .../** @type {Record<string, unknown>} */ (order),
          _s7_delivery: deliveryMeta,
        }
      : order;

  return {
    user_id: userId,
    marketplace,
    marketplace_account_id: marketplaceAccountId,
    seller_company_id: sellerCompanyId,
    external_order_id: extId,
    external_pack_id: order.pack_id != null ? String(order.pack_id) : null,
    order_status: order.status != null ? String(order.status) : null,
    order_substatus:
      order.status_detail?.code != null
        ? String(order.status_detail.code)
        : order.substatus != null
          ? String(order.substatus)
          : null,
    date_created_marketplace: order.date_created ? String(order.date_created) : null,
    date_closed_marketplace: order.date_closed ? String(order.date_closed) : null,
    last_updated_marketplace: order.last_updated ? String(order.last_updated) : null,
    paid_at: extractPaidAt(order),
    currency_id: order.currency_id != null ? String(order.currency_id) : null,
    total_amount: total,
    shipping_amount: ship,
    tax_amount: extractTaxAmount(order),
    raw_json: rawOrder,
    api_imported_at: nowIso,
    api_last_seen_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Converte uma linha de order_items do ML em sales_order_items.
 * Estratégia: sem id estável confiável em todos os casos → sempre substituir
 * todas as linhas do pedido no resync (ver persistMercadoLibreOrder).
 */
export function mapMlOrderItemToRow(
  userId,
  marketplace,
  salesOrderId,
  line,
  nowIso,
  marketplaceAccountId = null,
  sellerCompanyId = null,
  externalOrderId = null
) {
  const itemObj = line?.item && typeof line.item === "object" ? line.item : {};
  const listingId = extractExternalListingIdFromOrderLine(line);
  const variationId =
    itemObj.variation_id != null
      ? String(itemObj.variation_id)
      : line.variation_id != null
        ? String(line.variation_id)
        : null;

  const { qty, unit, gross: lineTotal, fee, net } = extractOrderLinePricing(line);

  const extLineId =
    line.id != null
      ? String(line.id)
      : line.order_item_id != null
        ? String(line.order_item_id)
        : null;

  return {
    sales_order_id: salesOrderId,
    user_id: userId,
    marketplace,
    marketplace_account_id: marketplaceAccountId,
    seller_company_id: sellerCompanyId,
    external_order_id: externalOrderId,
    external_order_item_id: extLineId,
    external_listing_id: listingId,
    external_variation_id: variationId,
    title_snapshot:
      itemObj.title != null
        ? String(itemObj.title)
        : line.title != null
          ? String(line.title)
          : null,
    sku_snapshot:
      itemObj.seller_custom_field != null
        ? String(itemObj.seller_custom_field)
        : itemObj.seller_sku != null
          ? String(itemObj.seller_sku)
          : null,
    quantity: qty,
    unit_price: unit,
    gross_amount: lineTotal,
    fee_amount: fee ?? null,
    shipping_share_amount: parseMlMoney(line.shipping_cost_share),
    tax_amount: parseMlMoney(line.taxes?.[0]?.amount ?? line.tax_amount),
    net_amount: net,
    thumbnail_snapshot: extractMlLineThumbnail(line),
    raw_json: line,
    api_imported_at: nowIso,
    api_last_seen_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Upsert pedido + substitui itens + snapshot append-only.
 * Em resync: preserva api_imported_at e created_at implícitos do primeiro insert
 * (consulta prévia por marketplace + marketplace_account_id + external_order_id).
 */
export async function persistMercadoLibreOrder(supabase, userId, order, opts = {}) {
  const log = opts.log || (() => {});
  const traceCtx = opts.traceCtx && typeof opts.traceCtx === "object" ? opts.traceCtx : {};
  const logStep = (step, extra = {}) => {
    console.info("[S7][ml-sales-sync-order-step]", {
      syncRunId: traceCtx.syncRunId ?? null,
      marketplaceAccountId: opts.marketplaceAccountId ?? null,
      sellerCompanyId: opts.sellerCompanyId ?? null,
      externalOrderId: order?.id != null ? String(order.id) : null,
      index: traceCtx.orderIndex ?? null,
      total: traceCtx.total ?? null,
      step,
      ...extra,
    });
  };
  /** @type {{ remaining: number } | null | undefined} */
  const pricingDebug = opts.pricingDebug;
  const marketplace = opts.marketplace || ML_MARKETPLACE_SLUG;
  const marketplaceAccountId =
    opts.marketplaceAccountId != null && String(opts.marketplaceAccountId).trim() !== ""
      ? String(opts.marketplaceAccountId).trim()
      : null;
  if (marketplace === ML_MARKETPLACE_SLUG && !marketplaceAccountId) {
    throw new Error("marketplace_account_id é obrigatório para persistir pedido Mercado Livre (multi-conta).");
  }
  const sellerCompanyId =
    opts.sellerCompanyId != null && String(opts.sellerCompanyId).trim() !== ""
      ? String(opts.sellerCompanyId).trim()
      : null;
  const nowIso = new Date().toISOString();

  const extPreview = order?.id != null ? String(order.id) : null;
  if (!extPreview) throw new Error("Pedido ML sem id");

  logStep("resolve order_items");
  const accessToken = opts.accessToken != null ? String(opts.accessToken).trim() : "";
  const orderForPersist = accessToken
    ? await hydrateMlOrderLinesIfMissing(order, accessToken, {
        marketplaceAccountId,
        log: (msg, extra) => log(msg, { external_order_id: extPreview, ...extra }),
      })
    : (() => {
        const resolved = resolveMlOrderLinesFromOrder(order);
        if (resolved.length > 0 && (!Array.isArray(order.order_items) || order.order_items.length === 0)) {
          return { .../** @type {Record<string, unknown>} */ (order), order_items: resolved };
        }
        return /** @type {Record<string, unknown>} */ (order);
      })();

  const existingQuery = supabase
    .from("sales_orders")
    .select("id, api_imported_at")
    .eq("marketplace", marketplace)
    .eq("marketplace_account_id", marketplaceAccountId)
    .eq("external_order_id", extPreview);
  logStep("prefetch order");
  const { data: existingOrder, error: exErr } = await existingQuery.maybeSingle();

  if (exErr) {
    log("sales_order_prefetch_failed", { exErr, external_order_id: extPreview });
    throw exErr;
  }

  const orderRow = mapMlOrderToSalesOrderRow(
    userId,
    orderForPersist,
    marketplace,
    nowIso,
    marketplaceAccountId,
    sellerCompanyId
  );
  orderRow.api_imported_at = existingOrder?.api_imported_at ?? nowIso;

  let salesOrderId;

  if (existingOrder?.id) {
    logStep("persist order");
    const { error: updErr } = await supabase
      .from("sales_orders")
      .update(orderRow)
      .eq("id", existingOrder.id);

    if (updErr) {
      log("sales_order_update_failed", { updErr, external_order_id: orderRow.external_order_id });
      throw updErr;
    }
    salesOrderId = existingOrder.id;
  } else {
    logStep("persist order");
    const { data: inserted, error: insErr } = await supabase
      .from("sales_orders")
      .insert(orderRow)
      .select("id")
      .single();

    if (insErr) {
      log("sales_order_insert_failed", { insErr, external_order_id: orderRow.external_order_id });
      throw insErr;
    }
    salesOrderId = inserted.id;
  }

  logStep("persist items");
  const { error: delI } = await supabase.from("sales_order_items").delete().eq("sales_order_id", salesOrderId);
  if (delI) log("delete_order_items_warn", { delI, salesOrderId });

  const lines = resolveMlOrderLinesFromOrder(orderForPersist);
  if (lines.length > 0) {
    const rows = lines.map((line) =>
      mapMlOrderItemToRow(
        userId,
        marketplace,
        salesOrderId,
        line,
        nowIso,
        marketplaceAccountId,
        sellerCompanyId,
        extPreview
      )
    );

    if (pricingDebug && pricingDebug.remaining > 0) {
      console.log("[ml/sync-sales] pricing_debug_sample", {
        external_order_id: extPreview,
        lines: rows.map((r) => ({
          external_listing_id: r.external_listing_id,
          quantity: r.quantity,
          unit_price: r.unit_price,
          gross_amount: r.gross_amount,
          fee_amount: r.fee_amount,
          tax_amount: r.tax_amount,
          net_amount: r.net_amount,
        })),
      });
      pricingDebug.remaining -= 1;
    }

    const { error: insErr } = await supabase.from("sales_order_items").insert(rows);
    if (insErr) log("insert_order_items_failed", { insErr, salesOrderId });
    if (insErr) throw insErr;
  } else {
    const delivery = extractMlOrderDeliveryMeta(orderForPersist);
    log("persist_order_without_items", {
      salesOrderId,
      external_order_id: extPreview,
      shipping_status: delivery.shipping_status,
      shipment_id: delivery.shipment_id,
    });
  }

  logStep("snapshot");
  const { error: snapErr } = await supabase.from("order_raw_snapshots").insert({
    sales_order_id: salesOrderId,
    payload: { order: orderForPersist, imported_at: nowIso, marketplace },
  });
  if (snapErr) log("order_snapshot_warn", { snapErr, salesOrderId });

  logStep("global_customer");
  try {
    const buyerPick = extractBuyerForGlobalSync(order);
    await touchGlobalCustomerFromOrderContext(supabase, {
      userId,
      marketplace,
      marketplaceAccountId,
      sellerCompanyId,
      orderDateIso: order?.date_created != null ? String(order.date_created) : null,
      orderTotal: orderRow.total_amount,
      buyerPick,
      bumpOrderAggregate: !existingOrder,
    });
  } catch (e) {
    log("global_customer_sync_warn", { message: e?.message });
  }

  logStep("metrics");
  return { salesOrderId, external_order_id: orderRow.external_order_id };
}

/**
 * Backfill de external_listing_id nulo a partir de raw_json (linhas antigas antes dos fallbacks).
 * Quando não for possível, marca raw_json._suse7.listing_id_unresolved para não reprocessar em loop.
 */
export async function backfillSalesOrderItemsExternalListingIds(supabase, userId, marketplace, log = () => {}) {
  const nowIso = new Date().toISOString();
  let updated = 0;
  let flaggedUnresolved = 0;
  let skippedAlreadyUnresolved = 0;
  let scanned = 0;
  const PAGE = 400;
  /** @type {string | null} */
  let afterId = null;

  for (;;) {
    let q = supabase
      .from("sales_order_items")
      .select("id, raw_json")
      .eq("user_id", userId)
      .eq("marketplace", marketplace)
      .is("external_listing_id", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (afterId != null) {
      q = q.gt("id", afterId);
    }

    const { data: rows, error } = await q;
    if (error) {
      log("backfill_select_failed", { error });
      throw error;
    }
    if (!rows?.length) break;

    scanned += rows.length;

    let progressed = false;

    for (const row of rows) {
      const line =
        row.raw_json && typeof row.raw_json === "object" ? { ...row.raw_json } : {};
      if (line._suse7 && typeof line._suse7 === "object" && line._suse7.listing_id_unresolved === true) {
        skippedAlreadyUnresolved += 1;
        continue;
      }
      const lid = extractExternalListingIdFromOrderLine(line);
      if (lid) {
        const { error: uErr } = await supabase
          .from("sales_order_items")
          .update({ external_listing_id: lid, updated_at: nowIso })
          .eq("id", row.id);
        if (uErr) log("backfill_update_id_failed", { uErr, id: row.id });
        else {
          updated += 1;
          progressed = true;
        }
      } else {
        line._suse7 = {
          ...(typeof line._suse7 === "object" && line._suse7 ? line._suse7 : {}),
          listing_id_unresolved: true,
          backfill_attempted_at: nowIso,
        };
        const { error: uErr } = await supabase
          .from("sales_order_items")
          .update({ raw_json: line, updated_at: nowIso })
          .eq("id", row.id);
        if (uErr) log("backfill_flag_raw_failed", { uErr, id: row.id });
        else {
          flaggedUnresolved += 1;
          progressed = true;
        }
      }
    }

    if (progressed) afterId = null;
    else afterId = rows[rows.length - 1].id;
  }

  log("backfill_external_listing_done", {
    scanned,
    updated,
    flagged_unresolved: flaggedUnresolved,
    skipped_already_unresolved: skippedAlreadyUnresolved,
  });

  return {
    scanned,
    updated,
    flagged_unresolved: flaggedUnresolved,
    skipped_already_unresolved: skippedAlreadyUnresolved,
  };
}

/**
 * Recalcula listing_sales_metrics a partir de sales_order_items + datas em sales_orders.
 * Remove linhas antigas do usuário+marketplace e reinsere agregados (sem duplicar vendas).
 */
export async function rebuildListingSalesMetricsForUser(supabase, userId, marketplace, log = () => {}) {
  const nowIso = new Date().toISOString();

  const itemsBackfill = await backfillMissingSalesOrderItemsFromOrderRaw(supabase, userId, marketplace, log);
  const backfill = await backfillSalesOrderItemsExternalListingIds(supabase, userId, marketplace, log);

  const { data: orders, error: oErr } = await supabase
    .from("sales_orders")
    .select("id, date_closed_marketplace, date_created_marketplace, paid_at")
    .eq("user_id", userId)
    .eq("marketplace", marketplace);

  if (oErr) {
    log("metrics_fetch_orders_failed", { oErr });
    throw oErr;
  }

  const orderMeta = new Map(
    (orders || []).map((o) => [
      o.id,
      {
        date_closed: o.date_closed_marketplace,
        date_created: o.date_created_marketplace,
        paid_at: o.paid_at,
      },
    ])
  );

  const { data: items, error: iErr } = await supabase
    .from("sales_order_items")
    .select(
      "sales_order_id, external_listing_id, quantity, gross_amount, net_amount, unit_price, fee_amount, shipping_share_amount"
    )
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .not("external_listing_id", "is", null);

  if (iErr) {
    log("metrics_fetch_items_failed", { iErr });
    throw iErr;
  }

  /** @type {Map<string, { qty: number; gross: Decimal; net: Decimal; fee: Decimal; shippingShare: Decimal; orderIds: Set<string>; lastSale: string | null }>} */
  const agg = new Map();

  for (const it of items || []) {
    const lid = normalizeExternalListingId(it.external_listing_id);
    if (!lid) continue;

    let row = agg.get(lid);
    if (!row) {
      row = {
        qty: 0,
        gross: new Decimal(0),
        net: new Decimal(0),
        fee: new Decimal(0),
        shippingShare: new Decimal(0),
        orderIds: new Set(),
        lastSale: null,
      };
      agg.set(lid, row);
    }

    const q = toInt(it.quantity) ?? 0;
    row.qty += q;

    let g = toFiniteNumber(it.gross_amount);
    if (g == null) {
      const unit = toFiniteNumber(it.unit_price);
      const qn = toInt(it.quantity) ?? 0;
      if (unit != null && qn > 0) g = unit * qn;
    }
    if (g == null) g = 0;
    row.gross = row.gross.plus(new Decimal(String(g)));

    const nRaw = toFiniteNumber(it.net_amount);
    const n = nRaw != null ? nRaw : g;
    row.net = row.net.plus(new Decimal(String(n)));

    let feeLine = toFiniteNumber(it.fee_amount);
    if (feeLine == null && g > 0 && nRaw != null && nRaw < g) {
      feeLine = g - nRaw;
    }
    if (feeLine == null || !Number.isFinite(feeLine) || feeLine < 0) feeLine = 0;
    row.fee = row.fee.plus(new Decimal(String(feeLine)));

    const shipLine = toFiniteNumber(it.shipping_share_amount);
    const shipAdd = shipLine != null && Number.isFinite(shipLine) && shipLine > 0 ? shipLine : 0;
    row.shippingShare = row.shippingShare.plus(new Decimal(String(shipAdd)));

    const meta = orderMeta.get(it.sales_order_id);
    if (meta) {
      row.orderIds.add(it.sales_order_id);
      const candidate = meta.date_closed || meta.paid_at || meta.date_created || null;
      if (candidate) {
        if (!row.lastSale || new Date(candidate) > new Date(row.lastSale)) {
          row.lastSale = String(candidate);
        }
      }
    }
  }

  const { error: delErr } = await supabase
    .from("listing_sales_metrics")
    .delete()
    .eq("user_id", userId)
    .eq("marketplace", marketplace);

  if (delErr) {
    log("metrics_delete_old_failed", { delErr });
    throw delErr;
  }

  const metricRows = [...agg.entries()].map(([external_listing_id, r]) => ({
    user_id: userId,
    marketplace,
    external_listing_id,
    qty_sold_total: r.qty,
    gross_revenue_total: r.gross.toFixed(6),
    net_revenue_total: r.net.toFixed(6),
    commission_amount_total: r.fee.toFixed(6),
    shipping_share_total: r.shippingShare.toFixed(6),
    orders_count: r.orderIds.size,
    last_sale_at: r.lastSale,
    last_sync_at: nowIso,
    updated_at: nowIso,
  }));

  if (metricRows.length > 0) {
    const { error: insErr } = await supabase.from("listing_sales_metrics").insert(metricRows);
    if (insErr) {
      log("metrics_insert_failed", { insErr });
      throw insErr;
    }
  }

  log("metrics_rebuild_done", { listings: metricRows.length });
  return { listingsUpdated: metricRows.length, backfill, itemsBackfill };
}
