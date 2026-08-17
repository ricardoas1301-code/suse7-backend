// =============================================================================
// S7 — Catálogo de Notificações (Fase S5.11)
// Esqueleto oficial — futura fonte de verdade; sem notificações reais nesta fase.
// =============================================================================

/** Tabelas existentes reutilizadas (não criar paralelo). */
export const S7_NOTIFICATION_CATALOG_TABLES = Object.freeze({
  CATEGORIES: "s7_notification_categories",
  EVENT_TYPES: "s7_notification_event_types",
  TEMPLATES: "s7_notification_templates",
  EVENTS: "s7_notification_events",
});

/** Código espelho em runtime (Phase 3.1 — não é cadastro novo S5.11). */
export const S7_NOTIFICATION_CATALOG_CODE_MIRROR = "S7_NOTIFICATION_TYPE_CATALOG";

/** Grupos de domínio para futura taxonomia (sem eventos). */
export const S7_NOTIFICATION_CATALOG_DOMAIN_GROUP = Object.freeze({
  FINANCEIRO: "financeiro",
  MARKETPLACE: "marketplace",
  OPERACIONAL: "operacional",
  COMERCIAL: "comercial",
  SISTEMA: "sistema",
  SEGURANCA: "seguranca",
});

/** Prioridades suportadas no catálogo (compatível com severity + contrato S5.1). */
export const S7_NOTIFICATION_CATALOG_PRIORITY = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  HIGH: "high",
  CRITICAL: "critical",
});

/** Obrigatoriedade (compatível S5.9). */
export const S7_NOTIFICATION_CATALOG_MANDATORY = Object.freeze({
  MANDATORY: "mandatory",
  OPTIONAL: "optional",
});

/** Canais reconhecidos pelo catálogo (Registro S5.3). */
export const S7_NOTIFICATION_CATALOG_CHANNEL = Object.freeze({
  EMAIL: "email",
  WHATSAPP: "whatsapp",
  IN_APP: "in_app",
  POPUP: "popup",
  BANNER: "banner",
  PUSH: "push",
});
