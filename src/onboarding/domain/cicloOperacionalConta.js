// ======================================================================
// Ciclo operacional — validação backend (espelho mínimo do frontend)
// ======================================================================

export const DEFAULT_OPERATIONAL_DAY_CLOSES_AT = "18:00:00";

/** @type {number[]} */
export const DEFAULT_OPERATIONAL_WORKING_DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * @param {unknown} raw
 */
export function normalizarHoraEncerramentoOperacional(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return DEFAULT_OPERATIONAL_DAY_CLOSES_AT;
  const match = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return DEFAULT_OPERATIONAL_DAY_CLOSES_AT;
  const hh = String(Math.min(23, Math.max(0, Number(match[1])))).padStart(2, "0");
  const mm = String(Math.min(59, Math.max(0, Number(match[2])))).padStart(2, "0");
  const ss = match[3] != null ? String(Math.min(59, Math.max(0, Number(match[3])))).padStart(2, "0") : "00";
  return `${hh}:${mm}:${ss}`;
}

/**
 * @param {unknown} raw
 * @returns {number[]}
 */
export function normalizarDiasOperacionais(raw) {
  if (raw == null) return [...DEFAULT_OPERATIONAL_WORKING_DAYS];
  const source = Array.isArray(raw) ? raw : [];
  const normalized = [
    ...new Set(
      source
        .map((day) => Number(day))
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
    ),
  ].sort((a, b) => a - b);
  return normalized.length > 0 ? normalized : [...DEFAULT_OPERATIONAL_WORKING_DAYS];
}

/**
 * @param {unknown} closesAt
 * @param {unknown} workingDays
 */
export function cicloOperacionalValoresValidos(closesAt, workingDays) {
  const days = normalizarDiasOperacionais(workingDays);
  if (days.length === 0) return false;
  return Boolean(normalizarHoraEncerramentoOperacional(closesAt));
}
