// ======================================================================
// Janela canônica de histórico ML — exatamente 12 meses calendário.
// Hot = subjanela de priorização (~90d) dentro dos mesmos 12 meses.
// Backfill = [history_start, hot_start) — sem gap, sem overlap com hot.
// FIN.SSOT / DEV.V2.ML-INITIAL-SYNC-ORDER-HISTORY-WINDOW-CLOSE.01E-E
// ======================================================================

/** Cutover fixo para testes de contrato (mission 01E-E). */
export const ML_SALES_HISTORY_FIXED_TEST_CUTOVER = "2026-08-15T12:00:00.000Z";

const DAY_MS = 86400000;

/** @param {unknown} v */
function parseCutover(v) {
  if (v instanceof Date && Number.isFinite(v.getTime())) return v;
  if (v != null && String(v).trim() !== "") {
    const d = new Date(String(v));
    if (Number.isFinite(d.getTime())) return d;
  }
  return new Date();
}

/**
 * Subtrai meses calendário preservando dia-alvo (clamp fim de mês).
 * @param {Date} anchor
 * @param {number} months
 */
export function subtractCalendarMonths(anchor, months) {
  const d = new Date(anchor.getTime());
  const origDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(origDay, lastDay));
  return d;
}

export function resolveMlHotRecentDays() {
  return Math.min(
    3650,
    Math.max(1, parseInt(process.env.ML_INITIAL_RECENT_DAYS || "90", 10) || 90),
  );
}

export function resolveMlHistoryCalendarMonths() {
  return Math.min(
    24,
    Math.max(1, parseInt(process.env.ML_HISTORY_BACKFILL_MONTHS || "12", 10) || 12),
  );
}

export function resolveMlHistoryBackfillChunkDays() {
  return Math.min(
    45,
    Math.max(1, parseInt(process.env.ML_HISTORY_BACKFILL_WINDOW_DAYS || "30", 10) || 30),
  );
}

/**
 * Contrato de janela total + hot + backfill.
 * @param {Date | string | number | undefined} cutoverInput
 * @param {{ calendarMonths?: number; hotDays?: number }} [options]
 */
export function resolveMlSalesHistoryWindow(cutoverInput, options = {}) {
  const cutover = parseCutover(cutoverInput);
  const calendarMonths = options.calendarMonths ?? resolveMlHistoryCalendarMonths();
  const hotDays = options.hotDays ?? resolveMlHotRecentDays();

  const targetHistoryEnd = new Date(cutover.getTime());
  const targetHistoryStart = subtractCalendarMonths(targetHistoryEnd, calendarMonths);

  let hotStart = new Date(targetHistoryEnd.getTime() - hotDays * DAY_MS);
  if (hotStart.getTime() < targetHistoryStart.getTime()) {
    hotStart = new Date(targetHistoryStart.getTime());
  }
  const hotEnd = new Date(targetHistoryEnd.getTime());
  const backfillStart = new Date(targetHistoryStart.getTime());
  const backfillEnd = new Date(hotStart.getTime());

  return {
    cutover_iso: targetHistoryEnd.toISOString(),
    target_history_start_iso: targetHistoryStart.toISOString(),
    target_history_end_iso: targetHistoryEnd.toISOString(),
    total_history_start_iso: targetHistoryStart.toISOString(),
    total_history_end_iso: targetHistoryEnd.toISOString(),
    hot_start_iso: hotStart.toISOString(),
    hot_end_iso: hotEnd.toISOString(),
    backfill_start_iso: backfillStart.toISOString(),
    backfill_end_iso: backfillEnd.toISOString(),
    earliest_requested_sale_iso: targetHistoryStart.toISOString(),
    latest_requested_sale_iso: targetHistoryEnd.toISOString(),
    calendar_months: calendarMonths,
    hot_days: hotDays,
    hot_is_subset_of_total: hotStart.getTime() >= targetHistoryStart.getTime(),
    boundary_contract: "backfill_half_open_hot_closed",
  };
}

/**
 * Fatias de API para backfill — apenas [backfill_start, backfill_end).
 * @param {Date | string | number | undefined} cutoverInput
 * @param {{ calendarMonths?: number; hotDays?: number; chunkDays?: number }} [options]
 */
export function buildHistoricalSalesBackfillWindows(cutoverInput, options = {}) {
  const win = resolveMlSalesHistoryWindow(cutoverInput, options);
  const chunkDays = options.chunkDays ?? resolveMlHistoryBackfillChunkDays();
  const iso = (ts) => new Date(ts).toISOString();

  const oldestTs = Date.parse(win.backfill_start_iso);
  let rangeToTs = Date.parse(win.backfill_end_iso);

  /** @type {{ date_from: string; date_to: string; window_index: number; label: string }[]} */
  const windows = [];
  let idx = 0;

  while (rangeToTs > oldestTs) {
    const nextFromTs = rangeToTs - chunkDays * DAY_MS;
    const rangeFromTs = Math.max(oldestTs, nextFromTs);
    windows.push({
      date_from: iso(rangeFromTs),
      date_to: iso(rangeToTs),
      window_index: idx,
      label: `api_window_${chunkDays}d_idx_${idx}`,
    });
    idx += 1;
    rangeToTs = rangeFromTs;
    if (rangeToTs <= oldestTs) break;
  }

  return {
    windows,
    ...win,
    historical_period_start: win.target_history_start_iso,
    historical_period_end: win.target_history_end_iso,
    hot_cutoff_iso: win.hot_end_iso,
    recent_days_anchor: win.hot_days,
    chunk_days: chunkDays,
    progress_total_windows: windows.length,
  };
}

/**
 * Valida partição hot/backfill sem gap/overlap de fronteira.
 * @param {ReturnType<typeof resolveMlSalesHistoryWindow>} win
 * @param {ReturnType<typeof buildHistoricalSalesBackfillWindows>["windows"]} [chunks]
 */
export function validateMlSalesHistoryWindowPartition(win, chunks = []) {
  const hs = Date.parse(win.target_history_start_iso);
  const he = Date.parse(win.target_history_end_iso);
  const hotS = Date.parse(win.hot_start_iso);
  const hotE = Date.parse(win.hot_end_iso);
  const bfS = Date.parse(win.backfill_start_iso);
  const bfE = Date.parse(win.backfill_end_iso);

  if (bfS !== hs) return { ok: false, gap_ms: null, overlap_ms: null, reason: "backfill_start_ne_history_start" };
  if (bfE !== hotS) return { ok: false, gap_ms: null, overlap_ms: null, reason: "backfill_end_ne_hot_start" };
  if (hotE !== he) return { ok: false, gap_ms: null, overlap_ms: null, reason: "hot_end_ne_history_end" };
  if (hotS < hs || hotS > he) return { ok: false, gap_ms: null, overlap_ms: null, reason: "hot_start_outside_total" };

  let gap_ms = 0;
  let overlap_ms = 0;

  if (chunks.length > 0 && bfE > bfS) {
    const sorted = [...chunks].sort((a, b) => Date.parse(a.date_from) - Date.parse(b.date_from));
    let cursor = bfS;
    for (const c of sorted) {
      const cf = Date.parse(c.date_from);
      const ct = Date.parse(c.date_to);
      if (cf > cursor) gap_ms += cf - cursor;
      if (cf < cursor) overlap_ms += cursor - cf;
      cursor = Math.max(cursor, ct);
    }
    if (cursor < bfE) gap_ms += bfE - cursor;
  }

  return { ok: gap_ms === 0 && overlap_ms === 0, gap_ms, overlap_ms, reason: null };
}

/**
 * @param {ReturnType<typeof resolveMlSalesHistoryWindow>} win
 * @param {number} [months]
 */
export function assertExactCalendarMonthSpan(win, months = 12) {
  const end = new Date(win.target_history_end_iso);
  const expectedStart = subtractCalendarMonths(end, months);
  const actualStart = new Date(win.target_history_start_iso);
  return expectedStart.getTime() === actualStart.getTime();
}

/**
 * Duração efetiva em dias UTC entre início e fim da janela total.
 * @param {ReturnType<typeof resolveMlSalesHistoryWindow>} win
 */
export function totalHistoryEffectiveDays(win) {
  const ms = Date.parse(win.target_history_end_iso) - Date.parse(win.target_history_start_iso);
  return Math.round(ms / DAY_MS);
}
