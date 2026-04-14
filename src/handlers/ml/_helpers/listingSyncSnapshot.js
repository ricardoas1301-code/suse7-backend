// ======================================================================
// Snapshot leve para comparar estado ML + health antes de reprocessar tudo.
// Campos alinhados ao prompt (preço, promo, frete, taxas, visitas, SKU…).
// Taxas do item: listing_prices (enriquecido em mercadoLibreItemsApi) quando o GET /items veio sem sale_fee_details.
// ======================================================================

import {
  extractPromotionPrice,
  extractSaleFee,
  extractShippingCost,
} from "./mlItemMoneyExtract.js";

/** @param {unknown} v */
function n(v) {
  if (v == null || v === "") return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

/** @param {unknown} v */
function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * @param {Record<string, unknown>} item - GET /items/:id
 * @param {Record<string, unknown> | null | undefined} health - linha marketplace_listing_health (parcial)
 * @param {string | null} sellerSku - seller_sku já extraído
 */
export function buildListingSyncCompareSnapshot(item, health, sellerSku) {
  const h = health && typeof health === "object" ? health : {};
  const ship = item?.shipping && typeof item.shipping === "object" ? item.shipping : null;
  const it = item && typeof item === "object" ? /** @type {Record<string, unknown>} */ (item) : {};
  const feeFromItem = extractSaleFee(it, { listing: it, health: h });
  const shipItem = extractShippingCost(
    item && typeof item === "object" ? /** @type {Record<string, unknown>} */ (item) : {}
  );
  const promoItem = extractPromotionPrice(
    item && typeof item === "object" ? /** @type {Record<string, unknown>} */ (item) : {}
  );

  return {
    price: n(item?.price),
    base_price: n(item?.base_price),
    original_price: n(item?.original_price),
    promotional_price: n(h.promotion_price) ?? (promoItem != null ? promoItem : null),
    shipping_cost: n(h.shipping_cost) ?? (shipItem != null ? shipItem : null),
    sale_fee_percent: n(h.sale_fee_percent) ?? (feeFromItem.percent != null ? feeFromItem.percent : null),
    sale_fee_amount: n(h.sale_fee_amount) ?? (feeFromItem.amount != null ? feeFromItem.amount : null),
    net_receivable: n(h.net_receivable),
    marketplace_payout_amount: n(h.marketplace_payout_amount ?? h.marketplace_payout_amount_brl),
    visits: h.visits != null && h.visits !== "" ? Math.trunc(Number(h.visits)) : null,
    sold_quantity: item?.sold_quantity != null ? Math.trunc(Number(item.sold_quantity)) : null,
    available_quantity:
      item?.available_quantity != null ? Math.trunc(Number(item.available_quantity)) : null,
    status: str(item?.status),
    listing_type_id: str(item?.listing_type_id),
    health_percent: (() => {
      const hi = item?.health;
      if (typeof hi === "number" && Number.isFinite(hi)) return hi <= 1 ? hi * 100 : hi;
      if (hi && typeof hi === "object") {
        const inner = n(/** @type {{ health?: unknown; score?: unknown }} */ (hi).health ?? hi.score);
        if (inner != null) return inner <= 1 ? inner * 100 : inner;
      }
      return null;
    })(),
    logistic_type: str(h.shipping_logistic_type) ?? str(ship?.logistic_type),
    sku: sellerSku ? str(sellerSku) : null,
    title: str(item?.title),
    listing_quality_score: n(h.listing_quality_score),
    listing_quality_status: str(h.listing_quality_status),
  };
}

/**
 * Comparação estável para decidir reprocessamento.
 * @param {unknown} prev
 * @param {unknown} next
 */
export function listingSnapshotsEqual(prev, next) {
  try {
    return stableStringify(prev) === stableStringify(next);
  } catch {
    return false;
  }
}

/** @param {unknown} obj */
function stableStringify(obj) {
  if (obj === null || obj === undefined) return "null";
  const t = typeof obj;
  if (t === "number" || t === "boolean") return JSON.stringify(obj);
  if (t === "string") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map((x) => stableStringify(x)).join(",")}]`;
  if (t !== "object") return JSON.stringify(String(obj));
  const keys = Object.keys(/** @type {object} */ (obj)).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(/** @type {Record<string, unknown>} */ (obj)[k])}`).join(",")}}`;
}

/**
 * @param {Record<string, unknown>} prev
 * @param {Record<string, unknown>} next
 * @returns {string[]} chaves com valores diferentes
 */
export function diffListingSnapshotKeys(prev, next) {
  const p = prev && typeof prev === "object" ? prev : {};
  const nxt = next && typeof next === "object" ? next : {};
  const keys = new Set([...Object.keys(p), ...Object.keys(nxt)]);
  const out = [];
  for (const k of keys) {
    const a = /** @type {Record<string, unknown>} */ (p)[k];
    const b = /** @type {Record<string, unknown>} */ (nxt)[k];
    try {
      if (stableStringify(a) !== stableStringify(b)) out.push(k);
    } catch {
      out.push(k);
    }
  }
  return out.sort();
}

/**
 * @param {string[]} changedKeys
 * @returns {string}
 */
export function inferPrimarySyncReason(changedKeys) {
  if (!changedKeys.length) return "periodic_check";
  const set = new Set(changedKeys);
  if (set.has("sold_quantity")) return "sale_detected";
  if (set.has("price") || set.has("base_price") || set.has("original_price") || set.has("promotional_price")) {
    return "price_changed";
  }
  if (set.has("visits") || set.has("health_percent") || set.has("listing_quality_score")) {
    return "health_changed";
  }
  if (set.has("status") || set.has("listing_type_id")) return "listing_status_changed";
  if (set.has("sku") || set.has("title")) return "catalog_changed";
  if (
    set.has("shipping_cost") ||
    set.has("sale_fee_percent") ||
    set.has("net_receivable") ||
    set.has("marketplace_payout_amount") ||
    set.has("logistic_type")
  ) {
    return "fees_or_shipping_changed";
  }
  return "listing_changed";
}

/**
 * @param {string[]} changedKeys
 */
export function inferNeedsAttention(changedKeys) {
  const marginOrFee = new Set([
    "price",
    "base_price",
    "original_price",
    "promotional_price",
    "shipping_cost",
    "sale_fee_percent",
    "sale_fee_amount",
    "net_receivable",
    "marketplace_payout_amount",
  ]);
  const health = new Set(["health_percent", "listing_quality_score", "listing_quality_status", "visits", "status"]);
  return changedKeys.some((k) => marginOrFee.has(k) || health.has(k));
}
