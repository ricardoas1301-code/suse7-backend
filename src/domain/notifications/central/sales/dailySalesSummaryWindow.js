// =============================================================================
// Janela de vendas — last_successful_run_at → scheduled_at (America/Sao_Paulo)
// Fallback sem histórico: últimas 24h antes de scheduled_at.
// =============================================================================

import { DAILY_SALES_SUMMARY_TIMEZONE } from "./dailySalesSummaryAutomationConstants.js";

const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;

/**
 * @param {Date} dateUtc
 */
export function toBrtParts(dateUtc) {
  const localMs = dateUtc.getTime() + BRT_OFFSET_MS;
  const d = new Date(localMs);
  return {
    weekday: d.getUTCDay(),
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    dateKey: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
  };
}

/**
 * @param {string} dateKey YYYY-MM-DD (BRT)
 * @param {string} timeHHmm
 */
export function buildBrtScheduledAtUtc(dateKey, timeHHmm) {
  const [h, m] = String(timeHHmm).split(":").map(Number);
  const iso = `${dateKey}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000-03:00`;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * @param {Date} nowUtc
 * @param {readonly number[]} weekdays
 * @param {readonly string[]} times
 * @param {number} [toleranceMin=3]
 * @returns {{
 *   matched: boolean;
 *   scheduled_at?: Date;
 *   time?: string;
 *   debug: Record<string, unknown>;
 * }}
 */
export function explainDailySalesScheduleSlot(nowUtc, weekdays, times, toleranceMin = 3) {
  const now = nowUtc instanceof Date ? nowUtc : new Date();
  const parts = toBrtParts(now);
  const weekdaySet = new Set(weekdays);
  const nowMinutes = parts.hours * 60 + parts.minutes;

  /** @type {Array<Record<string, unknown>>} */
  const slotsChecked = [];

  if (!weekdaySet.has(parts.weekday)) {
    return {
      matched: false,
      debug: {
        now_brt: formatBrtLogTimestamp(now),
        weekday_brt: parts.weekday,
        weekdays,
        times,
        tolerance_min: toleranceMin,
        reason: "weekday_not_selected",
        slots_checked: slotsChecked,
      },
    };
  }

  for (const time of times) {
    const [h, m] = String(time).split(":").map(Number);
    const slotMinutes = h * 60 + m;
    const delta = Math.abs(nowMinutes - slotMinutes);
    slotsChecked.push({
      time,
      slot_minutes: slotMinutes,
      now_minutes: nowMinutes,
      delta_min: delta,
      within_tolerance: delta <= toleranceMin,
    });
    if (delta <= toleranceMin) {
      const scheduled = buildBrtScheduledAtUtc(parts.dateKey, time);
      if (scheduled) {
        return {
          matched: true,
          scheduled_at: scheduled,
          time,
          debug: {
            now_brt: formatBrtLogTimestamp(now),
            weekday_brt: parts.weekday,
            weekdays,
            times,
            tolerance_min: toleranceMin,
            scheduled_at: scheduled.toISOString(),
            slots_checked: slotsChecked,
          },
        };
      }
    }
  }

  return {
    matched: false,
    debug: {
      now_brt: formatBrtLogTimestamp(now),
      weekday_brt: parts.weekday,
      weekdays,
      times,
      tolerance_min: toleranceMin,
      reason: "outside_tolerance",
      slots_checked: slotsChecked,
    },
  };
}

/**
 * @param {Date} nowUtc
 * @param {readonly number[]} weekdays 0=Dom … 6=Sáb
 * @param {readonly string[]} times HH:mm
 * @param {number} [toleranceMin=3]
 * @returns {{ scheduled_at: Date; time: string } | null}
 */
export function resolvePendingDailySalesScheduleSlot(nowUtc, weekdays, times, toleranceMin = 3) {
  const explained = explainDailySalesScheduleSlot(nowUtc, weekdays, times, toleranceMin);
  if (!explained.matched || !explained.scheduled_at || !explained.time) return null;
  return { scheduled_at: explained.scheduled_at, time: explained.time };
}

/**
 * @param {Date} dateUtc
 */
export function formatBrtLogTimestamp(dateUtc) {
  const p = toBrtParts(dateUtc);
  return `${p.dateKey} ${String(p.hours).padStart(2, "0")}:${String(p.minutes).padStart(2, "0")} BRT (wd=${p.weekday})`;
}

/**
 * @param {{
 *   lastSuccessfulRunAt?: string | Date | null;
 *   scheduledAt: Date;
 *   timezone?: string;
 * }} input
 * @returns {{ period_start: Date; period_end: Date; fallback: "last_24h" | "last_run" }}
 */
export function calculateDailySalesSummaryWindow(input) {
  const scheduledAt = input.scheduledAt instanceof Date ? input.scheduledAt : new Date(input.scheduledAt);
  const period_end = scheduledAt;

  const lastRaw = input.lastSuccessfulRunAt;
  if (lastRaw != null && String(lastRaw).trim() !== "") {
    const last = lastRaw instanceof Date ? lastRaw : new Date(String(lastRaw));
    if (Number.isFinite(last.getTime())) {
      return {
        period_start: new Date(last.getTime() + 1000),
        period_end,
        fallback: "last_run",
      };
    }
  }

  return {
    period_start: new Date(scheduledAt.getTime() - 24 * 60 * 60 * 1000),
    period_end,
    fallback: "last_24h",
  };
}

/**
 * @param {Date} start
 * @param {Date} endExclusive
 */
export function formatDailySalesSummaryPeriodLabel(start, endExclusive) {
  void DAILY_SALES_SUMMARY_TIMEZONE;
  const fmt = (d) => {
    const p = toBrtParts(d);
    return `${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")} ${String(p.hours).padStart(2, "0")}:${String(p.minutes).padStart(2, "0")}`;
  };
  const endInclusive = new Date(endExclusive.getTime() - 60_000);
  return `${fmt(start)} → ${fmt(endInclusive)}`;
}
