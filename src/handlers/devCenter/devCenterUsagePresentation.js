// ======================================================
// Dev Center — apresentação de consumo (ciclo civil + sale_order).
// Não altera quota, trial, plano ou persistência de billing.
// ======================================================

import Decimal from "decimal.js";
import { DEV_CENTER_TOOLBOX_METADATA_KEYS } from "./devCenterToolboxOperationalConstants.js";

/**
 * @param {unknown} status
 */
export function isConnectedMarketplaceAccountStatus(status) {
  const st = String(status ?? "").trim().toLowerCase();
  return st === "active" || st === "connected";
}

/**
 * Janela inclusiva do medidor canônico (`subscriptionUsageMeter`).
 *
 * @param {unknown} dateCreatedMarketplace
 * @param {string | null | undefined} periodStart YYYY-MM-DD
 * @param {string | null | undefined} periodEnd YYYY-MM-DD
 */
export function isMarketplaceSaleInCivilWindow(dateCreatedMarketplace, periodStart, periodEnd) {
  if (!dateCreatedMarketplace || !periodStart || !periodEnd) return false;
  const t = new Date(String(dateCreatedMarketplace)).getTime();
  if (!Number.isFinite(t)) return false;
  const start = Date.parse(`${periodStart}T00:00:00.000Z`);
  const end = Date.parse(`${periodEnd}T23:59:59.999Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return t >= start && t <= end;
}

/**
 * @param {Record<string, unknown>[]} salesRows
 * @param {Map<string, { period_start?: string | null; period_end?: string | null }>} cycleByUser
 * @returns {Map<string, number>}
 */
export function countSalesInCycleWindows(salesRows, cycleByUser) {
  /** @type {Map<string, number>} */
  const map = new Map();
  const rows = Array.isArray(salesRows) ? salesRows : [];
  for (const row of rows) {
    const uid = row?.user_id != null ? String(row.user_id) : "";
    if (!uid) continue;
    const cycle = cycleByUser.get(uid);
    if (!cycle) continue;
    if (
      !isMarketplaceSaleInCivilWindow(
        row.date_created_marketplace,
        cycle.period_start,
        cycle.period_end,
      )
    ) {
      continue;
    }
    map.set(uid, (map.get(uid) ?? 0) + 1);
  }
  return map;
}

/**
 * Percentual canônico — Decimal, 2 casas, HALF_UP. Sem teto artificial.
 *
 * @param {number | null | undefined} used
 * @param {number | null | undefined} limit
 * @returns {number | null}
 */
export function computeUsagePercentDecimal(used, limit) {
  if (limit == null || !Number.isFinite(Number(limit)) || Number(limit) <= 0) return null;
  const u = Number.isFinite(Number(used)) ? Number(used) : 0;
  return new Decimal(u).div(Number(limit)).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

/**
 * @param {Record<string, unknown> | null | undefined} sub
 */
export function readSubscriptionMeta(sub) {
  return sub?.metadata && typeof sub.metadata === "object"
    ? /** @type {Record<string, unknown>} */ (sub.metadata)
    : {};
}

/**
 * Bônus administrativo já persistido — não altera o limite Baby de 60.
 *
 * @param {Record<string, unknown> | null | undefined} sub
 */
export function readExtraSalesBonus(sub) {
  const n = Number(readSubscriptionMeta(sub)[DEV_CENTER_TOOLBOX_METADATA_KEYS.EXTRA_SALES_BONUS]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {number | null | undefined} baseLimit
 * @param {number} extraBonus
 */
export function resolveEffectiveSalesLimit(baseLimit, extraBonus) {
  if (baseLimit == null || !Number.isFinite(Number(baseLimit))) return null;
  const extra = Number.isFinite(Number(extraBonus)) ? Number(extraBonus) : 0;
  return Number(baseLimit) + extra;
}

/**
 * @param {unknown} value
 * @param {number} days
 */
export function isTimestampWithinLastDays(value, days) {
  if (!value) return false;
  const t = new Date(String(value)).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= Date.now() - days * 86400000;
}
