// =============================================================================
// Validação — config de agendamento do Resumo de vendas do dia
// =============================================================================

import {
  DAILY_SALES_SUMMARY_TIMEZONE,
  DEFAULT_DAILY_SALES_SUMMARY_CONFIG,
} from "./dailySalesSummaryAutomationConstants.js";

const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * @param {string} raw
 */
export function isValidDailySalesSummaryTime(raw) {
  return HH_MM_RE.test(String(raw ?? "").trim());
}

/**
 * @param {unknown} raw
 * @returns {number[]}
 */
export function normalizeDailySalesSummaryWeekdays(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const set = new Set();
  for (const item of list) {
    const n = Number(item);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeDailySalesSummaryTimes(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const normalized = [];
  for (const item of list) {
    const t = String(item ?? "").trim();
    if (!isValidDailySalesSummaryTime(t)) continue;
    if (!normalized.includes(t)) normalized.push(t);
  }
  return normalized.sort();
}

/**
 * @param {unknown} raw
 */
export function normalizeDailySalesSummaryChannels(raw) {
  const base = { ...DEFAULT_DAILY_SALES_SUMMARY_CONFIG.channels };
  if (!raw || typeof raw !== "object") return base;
  const src = /** @type {Record<string, unknown>} */ (raw);
  return {
    whatsapp: src.whatsapp !== false,
    email: src.email !== false,
    in_app: src.in_app !== false,
    popup: src.popup !== false,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} patch
 * @param {{ enabled?: boolean; config?: Record<string, unknown> }} [current]
 */
export function validateDailySalesSummaryAutomationPatch(patch, current = {}) {
  const enabled = patch?.enabled !== undefined ? Boolean(patch.enabled) : Boolean(current.enabled ?? true);
  const prevConfig =
    current.config && typeof current.config === "object"
      ? /** @type {Record<string, unknown>} */ (current.config)
      : {};
  const nextConfigRaw =
    patch?.config && typeof patch.config === "object"
      ? { ...prevConfig, .../** @type {Record<string, unknown>} */ (patch.config) }
      : prevConfig;

  const weekdays = normalizeDailySalesSummaryWeekdays(nextConfigRaw.weekdays);
  const times = normalizeDailySalesSummaryTimes(nextConfigRaw.times);
  const timezone = String(nextConfigRaw.timezone ?? DAILY_SALES_SUMMARY_TIMEZONE).trim();
  const channels = normalizeDailySalesSummaryChannels(nextConfigRaw.channels);

  if (enabled && times.length === 0) {
    return { ok: false, error: "SCHEDULE_TIME_REQUIRED", message: "Informe ao menos um horário válido (HH:mm)." };
  }

  if (enabled && weekdays.length === 0) {
    return {
      ok: false,
      error: "SCHEDULE_WEEKDAY_REQUIRED",
      message: "Selecione ao menos um dia da semana.",
    };
  }

  if (times.length > 2) {
    return { ok: false, error: "SCHEDULE_TOO_MANY_TIMES", message: "Máximo de 2 horários por dia." };
  }

  const rawTimes = Array.isArray(nextConfigRaw.times) ? nextConfigRaw.times : [];
  for (const t of rawTimes) {
    const s = String(t ?? "").trim();
    if (s && !isValidDailySalesSummaryTime(s)) {
      return { ok: false, error: "INVALID_TIME_FORMAT", message: `Horário inválido: ${s}` };
    }
  }

  if (timezone !== DAILY_SALES_SUMMARY_TIMEZONE) {
    return {
      ok: false,
      error: "INVALID_TIMEZONE",
      message: "Timezone deve ser America/Sao_Paulo.",
    };
  }

  return {
    ok: true,
    rule: {
      enabled,
      config: {
        channels,
        weekdays,
        times,
        timezone,
      },
    },
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} config
 */
export function formatDailySalesSummaryScheduleSummary(config) {
  const weekdays = normalizeDailySalesSummaryWeekdays(config?.weekdays);
  const times = normalizeDailySalesSummaryTimes(config?.times);
  if (weekdays.length === 0 || times.length === 0) return null;

  const weekdayLabel =
    weekdays.length === 7
      ? "Todos os dias"
      : weekdays.map((d) => ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"][d]).join(", ");

  const timesLabel = times.join(" e ");
  return `${weekdayLabel}\n${timesLabel}`;
}
