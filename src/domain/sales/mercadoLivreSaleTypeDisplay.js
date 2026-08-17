/**
 * Tipo de venda (publicidade / afiliado / padrão) — contrato general.sale_type_display.
 */

import { findMercadoLivreOrderLine } from "../../handlers/sales/_vendasSalesRows.js";

const BRAZIL_TZ = "America/Sao_Paulo";

/** @param {unknown} v */
function safeStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** @param {unknown} v */
function asObj(v) {
  if (!v || typeof v !== "object") return null;
  return /** @type {Record<string, unknown>} */ (v);
}

/** @param {unknown} tags */
function tagListIncludesAds(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => {
    const t = String(tag ?? "").trim().toLowerCase();
    return (
      t === "advertising" ||
      t === "ads" ||
      t === "product_ad" ||
      t === "pads" ||
      t.includes("publicidade") ||
      t.includes("advertis")
    );
  });
}

/** @param {unknown} tags */
function tagListIncludesAffiliate(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => /affiliat|afiliad/i.test(String(tag ?? "")));
}

/**
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {Record<string, unknown> | null | undefined} itemRaw
 * @param {Record<string, unknown> | null | undefined} lineRaw
 * @returns {"affiliate" | "advertising" | "standard"}
 */
export function resolveSaleChannelKind(orderRaw, itemRaw, lineRaw) {
  if (tagListIncludesAffiliate(orderRaw?.tags) || tagListIncludesAffiliate(orderRaw?.internal_tags)) {
    return "affiliate";
  }

  const context = asObj(orderRaw?.context);
  if (Array.isArray(context?.flows)) {
    for (const flow of context.flows) {
      const f = String(flow ?? "").trim().toLowerCase();
      if (/affiliat|afiliad/.test(f)) return "affiliate";
      if (f.includes("advertis") || f.includes("publicidade") || f === "pads" || f === "product_ad") {
        return "advertising";
      }
    }
  }

  const channel = safeStr(orderRaw?.channel);
  if (channel && /affiliat|afiliad/i.test(channel)) return "affiliate";
  if (channel && /advertis|publicidade|product_ad|pads/i.test(channel)) return "advertising";

  if (tagListIncludesAds(orderRaw?.static_tags)) return "advertising";

  const orderItems = Array.isArray(orderRaw?.order_items) ? orderRaw.order_items : [];
  for (const line of orderItems) {
    const row = asObj(line);
    if (!row) continue;
    if (
      tagListIncludesAds(row.tags) ||
      row.advertising === true ||
      tagListIncludesAds(asObj(row.item)?.tags)
    ) {
      return "advertising";
    }
  }

  if (
    tagListIncludesAds(orderRaw?.tags) ||
    tagListIncludesAds(orderRaw?.internal_tags) ||
    tagListIncludesAds(itemRaw?.tags) ||
    tagListIncludesAds(lineRaw?.tags) ||
    orderRaw?.advertising === true ||
    lineRaw?.advertising === true ||
    itemRaw?.advertising === true
  ) {
    return "advertising";
  }

  const fin = asObj(orderRaw?._s7_financial);
  const discounts = fin?.discounts_snapshot;
  if (discounts && typeof discounts === "object") {
    const blob = JSON.stringify(discounts).toLowerCase();
    if (/product_ad|publicidade|advertising|pads/.test(blob)) return "advertising";
  }

  return "standard";
}

/**
 * @param {"affiliate" | "advertising" | "standard"} kind
 * @param {{ source?: string }} [meta]
 */
export function buildSaleTypeDisplayFromKind(kind, meta = {}) {
  if (kind === "affiliate") {
    return {
      type: "affiliate",
      label: "Venda por afiliado",
      icon: null,
      source: meta.source ?? "order_raw",
    };
  }
  if (kind === "advertising") {
    return {
      type: "ads",
      label: "Venda por publicidade",
      icon: "mercado_livre_ads",
      source: meta.source ?? "order_raw",
    };
  }
  return {
    type: "standard",
    label: "Padrão",
    icon: null,
    source: meta.source ?? "default",
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} orderRaw
 * @param {Record<string, unknown> | null | undefined} itemRaw
 * @param {Record<string, unknown> | null | undefined} lineRaw
 */
export function buildSaleTypeDisplay(orderRaw, itemRaw, lineRaw) {
  const kind = resolveSaleChannelKind(orderRaw, itemRaw, lineRaw);
  return buildSaleTypeDisplayFromKind(kind);
}

/**
 * @param {string | null | undefined} iso
 */
function toBrazilDateYmd(iso) {
  const s = safeStr(iso);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BRAZIL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * @param {unknown} metrics
 */
function productAdsMetricsIndicateAdvertisingSale(metrics) {
  const m = asObj(metrics);
  if (!m) return false;
  const adItems = Number(m.advertising_items_quantity) || 0;
  const organicItems = Number(m.organic_items_quantity) || 0;
  const units = Number(m.units_quantity) || 0;
  if (adItems <= 0) return false;
  if (organicItems <= 0) return true;
  if (units > 0 && adItems >= units && organicItems === 0) return true;
  return false;
}

import { fetchMercadoLivreProductAdsItemDayMetrics } from "../../handlers/ml/_helpers/mercadoLibreOrdersApi.js";

/**
 * Enriquecimento assíncrono via Product Ads (métricas do dia da venda).
 * @param {Record<string, unknown>} general
 * @param {{
 *   order?: Record<string, unknown> | null;
 *   item?: Record<string, unknown> | null;
 *   row?: Record<string, unknown> | null;
 *   accessToken: string;
 *   marketplaceAccountId?: string | null;
 * }} ctx
 */
export async function enrichMercadoLivreSaleTypeDisplay(general, ctx) {
  const current =
    general?.sale_type_display && typeof general.sale_type_display === "object"
      ? /** @type {Record<string, unknown>} */ (general.sale_type_display)
      : null;
  if (current?.type === "ads" || current?.type === "affiliate") {
    return general;
  }

  const order = ctx.order && typeof ctx.order === "object" ? ctx.order : null;
  const item = ctx.item && typeof ctx.item === "object" ? ctx.item : null;
  const row = ctx.row && typeof ctx.row === "object" ? ctx.row : null;
  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (order.raw_json)
      : null;

  const extListing =
    safeStr(item?.external_listing_id) ??
    safeStr(row?.external_listing_id) ??
    safeStr(row?.listing_id_display);
  const saleDate =
    toBrazilDateYmd(row?.sale_date) ??
    toBrazilDateYmd(orderRaw?.date_closed) ??
    toBrazilDateYmd(orderRaw?.date_created);

  if (!extListing || !saleDate || !ctx.accessToken) return general;

  const paPayload = await fetchMercadoLivreProductAdsItemDayMetrics(
    ctx.accessToken,
    extListing,
    saleDate,
    { marketplaceAccountId: ctx.marketplaceAccountId ?? null },
  );
  const metrics = asObj(paPayload)?.metrics;
  if (!productAdsMetricsIndicateAdvertisingSale(metrics)) return general;

  const display = buildSaleTypeDisplayFromKind("advertising", { source: "product_ads_metrics" });
  return {
    ...general,
    sale_type_display: display,
    sale_type_label: display.label,
    sale_origin_label: general.sale_origin_label ?? display.label,
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown> | null | undefined} order
 * @param {Record<string, unknown> | null | undefined} item
 */
export function resolveSaleTypeDisplayForDetail(row, order, item = null) {
  const orderRaw =
    order?.raw_json && typeof order.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (order.raw_json)
      : null;
  const itemRaw =
    item?.raw_json && typeof item.raw_json === "object"
      ? /** @type {Record<string, unknown>} */ (item.raw_json)
      : null;
  const extListing =
    row.external_listing_id != null
      ? String(row.external_listing_id).trim()
      : row.listing_id_display != null
        ? String(row.listing_id_display).trim()
        : itemRaw?.external_listing_id != null
          ? String(itemRaw.external_listing_id).trim()
          : "";
  const extItem =
    row.external_order_item_id != null
      ? String(row.external_order_item_id).trim()
      : itemRaw?.external_order_item_id != null
        ? String(itemRaw.external_order_item_id).trim()
        : "";
  const orderLine = findMercadoLivreOrderLine(orderRaw, extItem || null, extListing || null);
  return buildSaleTypeDisplay(orderRaw, itemRaw, orderLine);
}
