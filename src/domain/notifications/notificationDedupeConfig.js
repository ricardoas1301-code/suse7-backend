// ============================================================
// Janelas de deduplicação por severidade (Fase 2)
// critical → sem dedupe (sempre gera evento)
// ============================================================

/** @type {Record<string, number>} — milissegundos */
export const NOTIFICATION_DEDUPE_WINDOW_MS_BY_SEVERITY = Object.freeze({
  critical: 0,
  important: 5 * 60 * 1000,
  medium: 15 * 60 * 1000,
  info: 60 * 60 * 1000,
});

/**
 * @param {string | null | undefined} severity
 * @returns {number}
 */
export function getDedupeWindowMsForSeverity(severity) {
  const s = severity != null ? String(severity).trim().toLowerCase() : "info";
  const w = NOTIFICATION_DEDUPE_WINDOW_MS_BY_SEVERITY[s];
  return typeof w === "number" ? w : NOTIFICATION_DEDUPE_WINDOW_MS_BY_SEVERITY.info;
}
