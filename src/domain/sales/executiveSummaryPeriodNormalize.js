// ======================================================================
// Normalização de período — dedupe/coalescing (operational_cycle instável por ms)
// ======================================================================

/**
 * Trunca ISO para minuto UTC (estabiliza chaves de dedupe e single-flight).
 * @param {string | null | undefined} iso
 */
export function truncateExecutiveIsoToMinute(iso) {
  if (iso == null || String(iso).trim() === "") return null;
  const d = new Date(String(iso).trim());
  if (!Number.isFinite(d.getTime())) return null;
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

/**
 * @param {{ preset?: string | null; start_datetime?: string | null; end_datetime?: string | null; start_ms?: number | null; end_ms_exclusive?: number | null }} period
 */
export function buildExecutiveSummaryPeriodDedupeFields(period) {
  const preset = period?.preset != null ? String(period.preset) : null;
  const startDatetime = truncateExecutiveIsoToMinute(period?.start_datetime ?? null);
  let endDatetime = truncateExecutiveIsoToMinute(period?.end_datetime ?? null);

  if (preset === "operational_cycle" && endDatetime == null && period?.end_ms_exclusive != null) {
    const endMs = Number(period.end_ms_exclusive) - 1;
    if (Number.isFinite(endMs) && endMs > 0) {
      endDatetime = truncateExecutiveIsoToMinute(new Date(endMs).toISOString());
    }
  }

  return {
    period_preset: preset,
    start_datetime: startDatetime,
    end_datetime: endDatetime,
    start_date: period?.start_date ?? null,
    end_date: period?.end_date ?? null,
  };
}
