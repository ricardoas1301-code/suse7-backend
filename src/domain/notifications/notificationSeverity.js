// ============================================================
// Severidade canônica dos eventos (alinha ao catálogo de roteamento)
// ============================================================

export const NOTIFICATION_SEVERITIES = Object.freeze({
  critical: "critical",
  important: "important",
  medium: "medium",
  info: "info",
});

/**
 * @param {string | null | undefined} catalogPriority — ex.: catálogo Fase 1 `priority`
 * @returns {string}
 */
export function severityFromCatalogPriority(catalogPriority) {
  const p = catalogPriority != null ? String(catalogPriority).trim().toLowerCase() : "";
  if (p === NOTIFICATION_SEVERITIES.critical) return NOTIFICATION_SEVERITIES.critical;
  if (p === NOTIFICATION_SEVERITIES.important) return NOTIFICATION_SEVERITIES.important;
  if (p === NOTIFICATION_SEVERITIES.medium) return NOTIFICATION_SEVERITIES.medium;
  return NOTIFICATION_SEVERITIES.info;
}
