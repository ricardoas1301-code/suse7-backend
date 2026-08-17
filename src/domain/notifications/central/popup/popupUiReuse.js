// =============================================================================
// S7 — Canal Pop-up (Fase S5.7) — mapeamento de reaproveitamento UI (auditoria)
// Somente documentação estrutural — não altera componentes.
// =============================================================================

/**
 * Descreve componentes existentes no frontend que podem evoluir para o canal Pop-up.
 */
export function describePopupMultiSurfaceReuse() {
  return {
    toast: {
      component: "suse7-frontend/src/components/NotificationToast.jsx",
      severity_mapping: "info | warning | critical (auto-dismiss)",
      reusable: true,
    },
    modal: {
      examples: ["ContactModal.jsx", "modais operacionais Dev Center"],
      reusable: true,
    },
    inline_feedback: {
      examples: ["DevCenterOperationalFeedbackBanner", "mini cards contextuais CSS"],
      reusable: true,
    },
    preferences: {
      page: "AlertasPopup.jsx",
      catalog: "POPUP_ALERTS_CATALOG_BY_VIEW",
      note: "Preferências seller — integração futura com motor, sem quebra nesta fase.",
    },
  };
}
