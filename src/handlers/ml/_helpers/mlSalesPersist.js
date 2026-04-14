// ======================================================
// FASE 3 — Persistência de vendas ML → sales_* + listing_sales_metrics
//
// Pedido:
// - upsert sales_orders por (marketplace, external_order_id)
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

/** Chave estável para join com marketplace_listings / listing_sales_metrics. */
export function normalizeExternalListingId(id) {
  if (id == null) return "";
  return String(id).trim();
}

/**
 * ID do anúncio ML a partir de uma linha de pedido (order_items) ou do raw_json persistido.
 * Usado em mapMlOrderItemToRow e no backfill de linhas antigas com external_listing_id nulo.
 */
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
    itemObj?.promotional_price,
    line?.promotional_price,
    itemObj?.price,
    line?.full_unit_price,
    line?.base_unit_price,
    itemObj?.base_price,
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
    line?.full_total_amount,
    line?.base_total_amount,
    line?.gross_amount,
    line?.gross_price,
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

  const fee = parseMlMoney(line?.sale_fee ?? line?.listing_fee ?? line?.discount_fee);

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
 * Monta linha sales_orders a partir do GET /orders/:id.
 */
export function mapMlOrderToSalesOrderRow(userId, order, marketplace, nowIso) {
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

  return {
    user_id: userId,
    marketplace,
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
    raw_json: order,
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
export function mapMlOrderItemToRow(userId, marketplace, salesOrderId, line, nowIso) {
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
    raw_json: line,
    api_imported_at: nowIso,
    api_last_seen_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Upsert pedido + substitui itens + snapshot append-only.
 * Em resync: preserva api_imported_at e created_at implícitos do primeiro insert
 * (consulta prévia por marketplace + external_order_id).
 */
export async function persistMercadoLibreOrder(supabase, userId, order, opts = {}) {
  const log = opts.log || (() => {});
  /** @type {{ remaining: number } | null | undefined} */
  const pricingDebug = opts.pricingDebug;
  const marketplace = opts.marketplace || ML_MARKETPLACE_SLUG;
  const nowIso = new Date().toISOString();

  const extPreview = order?.id != null ? String(order.id) : null;
  if (!extPreview) throw new Error("Pedido ML sem id");

  const { data: existingOrder, error: exErr } = await supabase
    .from("sales_orders")
    .select("id, api_imported_at")
    .eq("marketplace", marketplace)
    .eq("external_order_id", extPreview)
    .maybeSingle();

  if (exErr) {
    log("sales_order_prefetch_failed", { exErr, external_order_id: extPreview });
    throw exErr;
  }

  const orderRow = mapMlOrderToSalesOrderRow(userId, order, marketplace, nowIso);
  orderRow.api_imported_at = existingOrder?.api_imported_at ?? nowIso;

  let salesOrderId;

  if (existingOrder?.id) {
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

  const { error: delI } = await supabase.from("sales_order_items").delete().eq("sales_order_id", salesOrderId);
  if (delI) log("delete_order_items_warn", { delI, salesOrderId });

  const lines = Array.isArray(order.order_items) ? order.order_items : [];
  if (lines.length > 0) {
    const rows = lines.map((line) => mapMlOrderItemToRow(userId, marketplace, salesOrderId, line, nowIso));

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
  }

  const { error: snapErr } = await supabase.from("order_raw_snapshots").insert({
    sales_order_id: salesOrderId,
    payload: { order, imported_at: nowIso, marketplace },
  });
  if (snapErr) log("order_snapshot_warn", { snapErr, salesOrderId });

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
  return { listingsUpdated: metricRows.length, backfill };
}
