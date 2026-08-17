// =============================================================================
// Catálogo operacional de feature flags (Dev Center Toolbox — S1 Bloco 3)
// Preparado para rollout, plano, marketplace e flags sistêmicas futuras.
// =============================================================================

/** @type {Record<string, { key: string; label: string; description: string; category: string; default_enabled: boolean; source: string }>} */
export const DEV_CENTER_FEATURE_FLAG_CATALOG = Object.freeze({
  smart_pricing_ai: {
    key: "smart_pricing_ai",
    label: "Precificação IA",
    description: "Habilita recomendações inteligentes de precificação.",
    category: "pricing",
    default_enabled: false,
    source: "manual",
  },
  whatsapp_notifications: {
    key: "whatsapp_notifications",
    label: "Notificações WhatsApp",
    description: "Envia alertas operacionais e cobrança pelo WhatsApp.",
    category: "notifications",
    default_enabled: false,
    source: "plan",
  },
  advanced_dashboard: {
    key: "advanced_dashboard",
    label: "Dashboard avançado",
    description: "Painéis analíticos estendidos e widgets personalizados.",
    category: "analytics",
    default_enabled: false,
    source: "manual",
  },
  ml_real_time_sync: {
    key: "ml_real_time_sync",
    label: "Sync ML em tempo real",
    description: "Sincroniza pedidos do Mercado Livre em tempo real.",
    category: "sync",
    default_enabled: false,
    source: "system",
  },
});

/**
 * @param {string | null | undefined} flagKey
 */
export function isDevCenterFeatureFlagCatalogKey(flagKey) {
  return Boolean(DEV_CENTER_FEATURE_FLAG_CATALOG[String(flagKey ?? "").trim()]);
}
