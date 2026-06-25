// ======================================================================
// Período para métricas executivas de vendas.
// ======================================================================

const MAX_PERIOD_DAYS = 730;

/**
 * @param {string | null | undefined} raw
 * @returns {Date | null}
 */
function parseIsoDateOnly(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const s = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * @param {string | null | undefined} raw
 * @returns {Date | null}
 */
function parseIsoDateTime(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const s = String(raw).trim();
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * @param {Date} d
 */
function formatIsoDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * @param {Date} start
 * @param {Date} end
 */
function periodSpanDaysInclusive(start, end) {
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * @param {Record<string, unknown> | null | undefined} query
 */
export function resolveExecutiveSummaryPeriod(query) {
  const q = query ?? {};
  const startDatetimeAlias =
    q.start_datetime != null && String(q.start_datetime).trim() !== ""
      ? String(q.start_datetime).trim()
      : q.period_start_datetime != null && String(q.period_start_datetime).trim() !== ""
        ? String(q.period_start_datetime).trim()
        : null;
  const endDatetimeAlias =
    q.end_datetime != null && String(q.end_datetime).trim() !== ""
      ? String(q.end_datetime).trim()
      : q.period_end_datetime != null && String(q.period_end_datetime).trim() !== ""
        ? String(q.period_end_datetime).trim()
        : null;

  const startAlias =
    q.start_date != null && String(q.start_date).trim() !== ""
      ? String(q.start_date).trim()
      : q.period_start != null && String(q.period_start).trim() !== ""
        ? String(q.period_start).trim()
        : null;
  const endAlias =
    q.end_date != null && String(q.end_date).trim() !== ""
      ? String(q.end_date).trim()
      : q.period_end != null && String(q.period_end).trim() !== ""
        ? String(q.period_end).trim()
        : null;

  let presetRaw =
    q.period_preset != null && String(q.period_preset).trim() !== ""
      ? String(q.period_preset).trim().toLowerCase()
      : "";

  /** @type {string[]} */
  const warnings = [];

  const startDatetimeIn = parseIsoDateTime(startDatetimeAlias);
  const endDatetimeIn = parseIsoDateTime(endDatetimeAlias);
  const hasDatetimeRange = Boolean(startDatetimeIn && endDatetimeIn);

  if (!presetRaw && !startAlias && !endAlias && !hasDatetimeRange) {
    presetRaw = "60d";
  }

  if ((presetRaw === "all" || presetRaw === "") && !hasDatetimeRange) {
    presetRaw = "60d";
    warnings.push("period_preset=all substituído por últimos 60 dias no resumo executivo.");
  }

  const startIn = parseIsoDateOnly(startAlias);
  const endIn = parseIsoDateOnly(endAlias);

  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  /** @type {Date | null} */
  let start = startIn;
  /** @type {Date | null} */
  let end = endIn;
  /** @type {string} */
  let preset = presetRaw;
  /** @type {number | null} */
  let startMs = null;
  /** @type {number | null} */
  let endMsExclusive = null;

  if (hasDatetimeRange) {
    if (startDatetimeIn.getTime() > endDatetimeIn.getTime()) {
      return { ok: false, error: "start_datetime não pode ser posterior a end_datetime." };
    }
    preset = presetRaw === "operational_cycle" ? "operational_cycle" : presetRaw || "custom";
    start = startDatetimeIn;
    end = endDatetimeIn;
    startMs = startDatetimeIn.getTime();
    endMsExclusive = endDatetimeIn.getTime() + 1;
  }

  if (!hasDatetimeRange && preset === "custom") {
    if (!start || !end) {
      return { ok: false, error: "Período custom requer start_date e end_date (YYYY-MM-DD)." };
    }
  } else if (!hasDatetimeRange && preset === "today") {
    start = todayUtc;
    end = todayUtc;
  } else if (!hasDatetimeRange && preset === "7d") {
    start = new Date(todayUtc);
    start.setUTCDate(start.getUTCDate() - 6);
    end = todayUtc;
  } else if (!hasDatetimeRange && preset === "30d") {
    start = new Date(todayUtc);
    start.setUTCDate(start.getUTCDate() - 29);
    end = todayUtc;
  } else if (!hasDatetimeRange && preset === "60d") {
    start = new Date(todayUtc);
    start.setUTCDate(start.getUTCDate() - 59);
    end = todayUtc;
  } else if (!hasDatetimeRange && preset === "month") {
    start = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), 1));
    end = todayUtc;
  } else if (!hasDatetimeRange && preset === "lifetime") {
    start = null;
    end = null;
    startMs = null;
    endMsExclusive = null;
  } else if (!hasDatetimeRange && !start && !end) {
    return { ok: false, error: `period_preset desconhecido: ${presetRaw}` };
  }

  if (start && end && start.getTime() > end.getTime()) {
    return { ok: false, error: "start_date não pode ser posterior a end_date." };
  }

  if (start && end && periodSpanDaysInclusive(start, end) > MAX_PERIOD_DAYS) {
    return {
      ok: false,
      error: `Período máximo permitido: ${MAX_PERIOD_DAYS} dias (2 anos). Utilize Relatórios para histórico completo.`,
    };
  }

  if (!hasDatetimeRange) {
    startMs = start ? start.getTime() : null;
    endMsExclusive = end ? end.getTime() + 24 * 60 * 60 * 1000 : null;
  }

  return {
    ok: true,
    period: {
      start_date: start ? formatIsoDateOnly(start) : null,
      end_date: end ? formatIsoDateOnly(end) : null,
      start_datetime: hasDatetimeRange && start ? start.toISOString() : null,
      end_datetime: hasDatetimeRange && end ? end.toISOString() : null,
      preset,
      start_ms: startMs,
      end_ms_exclusive: endMsExclusive,
    },
    warnings,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} order
 * @param {{ start_ms: number | null; end_ms_exclusive: number | null }} period
 * @param {Record<string, unknown> | null | undefined} [item]
 */
export function orderMatchesExecutivePeriod(order, period, item = null) {
  if (!period.start_ms && !period.end_ms_exclusive) return true;

  const raw = order?.date_created_marketplace;
  if (raw == null || String(raw).trim() === "") return false;
  const t = Date.parse(String(raw));
  if (!Number.isFinite(t)) return false;
  if (period.start_ms != null && t < period.start_ms) return false;
  if (period.end_ms_exclusive != null && t >= period.end_ms_exclusive) return false;
  return true;
}

