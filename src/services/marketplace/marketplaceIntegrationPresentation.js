// ======================================================================
// Apresentação integração marketplace — auth × sync (sem maquiar estado)
// Prioridade: unresolved → auth inválida → auth saudável → classificação sync
// ======================================================================

/**
 * @param {{
 *   connectionPack: {
 *     connection_health: string;
 *     connection_badge_label: string;
 *     connection_alert_message: string | null;
 *     show_reconnect_cta: boolean;
 *     monitoring_headline: string | null;
 *     pipeline_active: boolean;
 *   };
 *   mlInitialSyncPhase?: "none" | "awaiting_start" | "in_progress" | null;
 *   syncOverall?: string | null;
 *   authResolved?: boolean;
 * }} input
 */
export function buildMarketplaceIntegrationPresentation(input) {
  const pack = input.connectionPack;
  const authResolved = input.authResolved !== false;

  if (!authResolved) {
    return {
      integration_badge_label: "Status",
      integration_resolved: false,
      show_reconnect_cta: false,
      connection_alert_message: pack.connection_alert_message ?? null,
      monitoring_headline: null,
      sync_presentation_code: "unknown",
    };
  }

  if (pack.connection_health === "disconnected") {
    return {
      integration_badge_label: pack.connection_badge_label,
      integration_resolved: true,
      show_reconnect_cta: pack.show_reconnect_cta,
      connection_alert_message: pack.connection_alert_message ?? null,
      monitoring_headline: pack.monitoring_headline ?? null,
      sync_presentation_code: "disconnected",
    };
  }

  if (pack.show_reconnect_cta || pack.connection_health === "auth_required") {
    return {
      integration_badge_label: pack.connection_badge_label,
      integration_resolved: true,
      show_reconnect_cta: true,
      connection_alert_message: pack.connection_alert_message ?? null,
      monitoring_headline: pack.monitoring_headline ?? null,
      sync_presentation_code: "reconnect_required",
    };
  }

  const phase = String(input.mlInitialSyncPhase ?? "none").trim();
  const overall = String(input.syncOverall ?? "").toLowerCase();

  if (phase === "awaiting_start" || overall === "awaiting_start") {
    return {
      integration_badge_label: "Sincronização necessária",
      integration_resolved: true,
      show_reconnect_cta: false,
      connection_alert_message: null,
      monitoring_headline: null,
      sync_presentation_code: "sync_required",
    };
  }

  if (
    phase === "in_progress" ||
    overall === "running" ||
    overall === "completed_with_errors" ||
    pack.pipeline_active
  ) {
    return {
      integration_badge_label: "Sincronização em andamento",
      integration_resolved: true,
      show_reconnect_cta: false,
      connection_alert_message: null,
      monitoring_headline: pack.monitoring_headline ?? "Sincronização em andamento",
      sync_presentation_code: "sync_in_progress",
    };
  }

  return {
    integration_badge_label: "Conectada",
    integration_resolved: true,
    show_reconnect_cta: false,
    connection_alert_message: null,
    monitoring_headline: pack.monitoring_headline ?? "Monitoramento ativo",
    sync_presentation_code: "connected",
  };
}
