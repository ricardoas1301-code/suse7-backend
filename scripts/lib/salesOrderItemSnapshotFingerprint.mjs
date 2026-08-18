/**
 * Fingerprint determinístico dos componentes imutáveis de snapshot financeiro.
 * Uso exclusivo: testes/auditoria — não entra em código de produção.
 */

import { createHash } from "node:crypto";

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normMoney(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normPercent(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(4);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function normTs(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  return s || null;
}

/**
 * Extrai componentes imutáveis a partir de sales_order_items row (ou objeto fin).
 *
 * @param {{
 *   fee_amount?: unknown;
 *   shipping_share_amount?: unknown;
 *   net_amount?: unknown;
 *   raw_json?: { _s7_financial?: Record<string, unknown> } | null;
 * }} itemRow
 */
export function extractImmutableSnapshotComponents(itemRow) {
  const fin =
    itemRow?.raw_json?._s7_financial && typeof itemRow.raw_json._s7_financial === "object"
      ? /** @type {Record<string, unknown>} */ (itemRow.raw_json._s7_financial)
      : {};
  const internal =
    fin.internal_costs_snapshot && typeof fin.internal_costs_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.internal_costs_snapshot)
      : {};
  const tax =
    fin.tax_snapshot && typeof fin.tax_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.tax_snapshot)
      : {};
  const product =
    fin.product_cost_snapshot && typeof fin.product_cost_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.product_cost_snapshot)
      : {};
  const op =
    fin.operational_cost_snapshot && typeof fin.operational_cost_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.operational_cost_snapshot)
      : {};
  const ads =
    fin.ads_snapshot && typeof fin.ads_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.ads_snapshot)
      : {};
  const reserve =
    fin.contingency_margin_snapshot && typeof fin.contingency_margin_snapshot === "object"
      ? /** @type {Record<string, unknown>} */ (fin.contingency_margin_snapshot)
      : {};

  return {
    has_s7_financial: Boolean(itemRow?.raw_json?._s7_financial),
    snapshot_created_at: normTs(fin.snapshot_created_at),
    immutable_since: normTs(fin.immutable_since),
    tax_percent_applied: normPercent(
      tax.tax_percent_applied ?? internal.tax_percent_applied ?? null,
    ),
    internal_tax_brl: normMoney(tax.amount_brl ?? internal.internal_tax_brl ?? null),
    product_cost_brl: normMoney(product.amount_brl ?? internal.product_cost_brl ?? null),
    operation_cost_brl: normMoney(op.operation_cost_brl ?? internal.operation_cost_brl ?? null),
    packaging_cost_brl: normMoney(op.packaging_cost_brl ?? internal.packaging_cost_brl ?? null),
    operation_packaging_cost_brl: normMoney(
      op.operation_packaging_cost_brl ?? internal.operation_packaging_cost_brl ?? null,
    ),
    ads_amount_brl: normMoney(ads.amount_brl ?? ads.ml_ads_brl ?? reserve.ml_ads_brl ?? null),
    reserve_brl: normMoney(
      reserve.reserve_brl ?? reserve.safety_reserve_brl ?? op.reserve_brl ?? null,
    ),
    fee_amount: normMoney(itemRow?.fee_amount),
    shipping_share_amount: normMoney(itemRow?.shipping_share_amount),
    net_amount: normMoney(itemRow?.net_amount),
  };
}

/** @type {(keyof ReturnType<typeof extractImmutableSnapshotComponents>)[]} */
const FINGERPRINT_KEYS = [
  "snapshot_created_at",
  "immutable_since",
  "tax_percent_applied",
  "internal_tax_brl",
  "product_cost_brl",
  "operation_cost_brl",
  "packaging_cost_brl",
  "operation_packaging_cost_brl",
  "ads_amount_brl",
  "reserve_brl",
];

/**
 * @param {ReturnType<typeof extractImmutableSnapshotComponents>} components
 */
export function fingerprintImmutableSnapshotComponents(components) {
  const payload = {};
  for (const key of FINGERPRINT_KEYS) {
    payload[key] = components[key] ?? null;
  }
  const canonical = JSON.stringify(payload);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return { hash, canonical, components: payload };
}

/**
 * @param {ReturnType<typeof extractImmutableSnapshotComponents>} before
 * @param {ReturnType<typeof extractImmutableSnapshotComponents>} after
 */
export function diffImmutableSnapshotComponents(before, after) {
  /** @type {Record<string, { before: unknown; after: unknown }>} */
  const delta = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key] !== after[key]) {
      delta[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
  }
  return delta;
}

/**
 * Detecta regressão transitória observável durante stress/read polling.
 *
 * @param {ReturnType<typeof extractImmutableSnapshotComponents>} reading
 * @param {ReturnType<typeof extractImmutableSnapshotComponents>} baseline
 */
export function isSnapshotRegressionReading(reading, baseline) {
  if (baseline.has_s7_financial && !reading.has_s7_financial) return true;
  if (baseline.internal_tax_brl != null && reading.internal_tax_brl == null) return true;
  if (baseline.product_cost_brl != null && reading.product_cost_brl == null) return true;
  if (baseline.shipping_share_amount != null && reading.shipping_share_amount == null) return true;
  if (baseline.net_amount != null && reading.net_amount == null) return true;
  if (
    baseline.snapshot_created_at != null &&
    reading.snapshot_created_at != null &&
    reading.snapshot_created_at !== baseline.snapshot_created_at
  ) {
    return true;
  }
  return false;
}
