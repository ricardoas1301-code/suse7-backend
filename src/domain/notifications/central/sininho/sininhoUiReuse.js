// =============================================================================
// S7 — Central Sininho (Fase S5.8) — mapeamento UI (auditoria)
// Somente documentação estrutural — não altera componentes.
// =============================================================================

/**
 * Componentes frontend existentes do sininho.
 */
export function describeSininhoUiReuse() {
  return {
    sininho_dropdown: {
      component: "suse7-frontend/src/components/notifications/S7NotificationCenter.jsx",
      hook: "useS7Inbox",
      api: "centralInboxApi.js",
      note: "Sininho no header — preview 8 itens, marcação de leitura, deep-link.",
    },
    notificacoes_hub: {
      component: "CentralNotificacoesHub.jsx",
      route: "/perfil/notificacoes",
      note: "Preferências e destinatários do motor central — separado do inbox.",
    },
    legacy_toast: {
      component: "NotificationToast.jsx",
      note: "Toasts globais — não substituídos; canal sininho usa dispatches.",
    },
    legacy_prefs: {
      component: "Notificacoes.jsx",
      note: "Preferências legadas notify.*.in_app — coexistem com motor central.",
    },
  };
}
