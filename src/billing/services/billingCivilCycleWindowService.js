// ======================================================================
// Janela civil do ciclo — America/Sao_Paulo, semiaberta (S1.HF.6.9A.10)
// cycle_started_at <= official_order_at < cycle_ends_at_exclusive
// ======================================================================

import { BILLING_CANONICAL_TIMEZONE } from "./billingCycleService.js";

/**
 * @param {unknown} value
 */
function asCivilDate(value) {
  if (value == null || value === "") return null;
  const m = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Offset local−UTC (ms) do fuso no instante informado.
 *
 * @param {string} timeZone
 * @param {Date} instant
 */
function getTimeZoneOffsetMs(timeZone, instant) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  /** @type {Record<string, string>} */
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - instant.getTime();
}

/**
 * Início civil (00:00) em America/Sao_Paulo → instante UTC.
 *
 * @param {string} yyyyMmDd
 * @param {string} [timeZone]
 * @returns {Date | null}
 */
export function civilDateStartInstantSaoPaulo(yyyyMmDd, timeZone = BILLING_CANONICAL_TIMEZONE) {
  const civil = asCivilDate(yyyyMmDd);
  if (!civil) return null;
  const y = Number(civil.slice(0, 4));
  const m = Number(civil.slice(5, 7));
  const d = Number(civil.slice(8, 10));
  let utc = Date.UTC(y, m - 1, d, 3, 0, 0);
  for (let i = 0; i < 4; i += 1) {
    const offset = getTimeZoneOffsetMs(timeZone, new Date(utc));
    utc = Date.UTC(y, m - 1, d, 0, 0, 0) - offset;
  }
  return new Date(utc);
}

/**
 * Fim exclusivo = início do dia civil seguinte em SP.
 *
 * @param {string} yyyyMmDdInclusiveEnd
 * @param {string} [timeZone]
 * @returns {Date | null}
 */
export function civilDateEndExclusiveInstantSaoPaulo(
  yyyyMmDdInclusiveEnd,
  timeZone = BILLING_CANONICAL_TIMEZONE,
) {
  const civil = asCivilDate(yyyyMmDdInclusiveEnd);
  if (!civil) return null;
  const y = Number(civil.slice(0, 4));
  const m = Number(civil.slice(5, 7));
  const d = Number(civil.slice(8, 10));
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextCivil = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  return civilDateStartInstantSaoPaulo(nextCivil, timeZone);
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
export function resolveCurrentBabyCycleWindow(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const cycleKey =
    asCivilDate(meta.usage_limit_cycle_key) ?? asCivilDate(meta.fallback_period_start);
  const startCivil = asCivilDate(meta.fallback_period_start) ?? cycleKey;
  const endCivilInclusive = asCivilDate(meta.fallback_period_end);
  const cycle_started_at = startCivil ? civilDateStartInstantSaoPaulo(startCivil) : null;
  const cycle_ends_at_exclusive = endCivilInclusive
    ? civilDateEndExclusiveInstantSaoPaulo(endCivilInclusive)
    : null;
  return {
    timezone: BILLING_CANONICAL_TIMEZONE,
    cycle_key: cycleKey,
    cycle_start_civil: startCivil,
    cycle_end_civil_inclusive: endCivilInclusive,
    cycle_started_at,
    cycle_ends_at_exclusive,
  };
}

/**
 * @param {Date | null | undefined} official
 * @param {{ cycle_started_at?: Date | null; cycle_ends_at_exclusive?: Date | null }} window
 */
export function isOfficialOrderInCycleWindow(official, window) {
  if (!(official instanceof Date) || Number.isNaN(official.getTime())) return false;
  const start = window?.cycle_started_at;
  const endEx = window?.cycle_ends_at_exclusive;
  if (!(start instanceof Date) || !(endEx instanceof Date)) return false;
  return official.getTime() >= start.getTime() && official.getTime() < endEx.getTime();
}
