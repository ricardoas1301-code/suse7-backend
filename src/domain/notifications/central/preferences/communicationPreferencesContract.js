// =============================================================================
// S7 — Preferências de Comunicação (Fase S5.9)
// Contrato oficial — reutiliza tabelas e serviços existentes (fonte única).
// =============================================================================

/** Escopos de preferência (seller × categoria × tipo × canal). */
export const S7_COMMUNICATION_PREF_SCOPE = Object.freeze({
  CATEGORY: "category",
  TYPE: "type",
  CHANNEL: "channel",
});

/** Tabela fonte de verdade — preferências por canal. */
export const S7_COMMUNICATION_PREFERENCES_TABLE = "s7_notification_preferences";

/** Tabela — destinatários externos (e-mail / WhatsApp). */
export const S7_COMMUNICATION_RECIPIENTS_TABLE = "s7_notification_recipients";

/** Tabela — escopo categoria/tipo por destinatário. */
export const S7_COMMUNICATION_RECIPIENT_SCOPES_TABLE = "s7_notification_recipient_scopes";

/** Tabela — regras por evento × grupo × canal. */
export const S7_COMMUNICATION_EVENT_RULES_TABLE = "s7_notification_event_delivery_rules";

/** Catálogo de tipos (DB + espelho em código). */
export const S7_COMMUNICATION_EVENT_TYPES_TABLE = "s7_notification_event_types";

/** Papéis de destinatário (formalização). */
export const S7_COMMUNICATION_RECIPIENT_ROLE = Object.freeze({
  OWNER_IN_APP: "owner_in_app",
  PRIMARY: "primary",
  ADDITIONAL: "additional",
  PROFILE_FALLBACK: "profile_fallback",
  MANUAL_OVERRIDE: "manual_override",
});

/** Comunicação obrigatória vs opcional (catálogo is_mandatory). */
export const S7_COMMUNICATION_MANDATORY_TIER = Object.freeze({
  MANDATORY: "mandatory",
  OPTIONAL: "optional",
});

/** Frequência de entrega — preparado (sem aplicação nesta fase). */
export const S7_COMMUNICATION_FREQUENCY = Object.freeze({
  IMMEDIATE: "immediate",
  BATCHED: "batched",
  DAILY: "daily",
  WEEKLY: "weekly",
});

/** Horários / silenciamento — preparado (sem aplicação nesta fase). */
export const S7_COMMUNICATION_QUIET_HOURS_MODE = Object.freeze({
  NONE: "none",
  OPERATIONAL_WINDOW: "operational_window",
  TEMPORARY_MUTE: "temporary_mute",
});

/** APIs seller preservadas (Central de Notificações). */
export const S7_COMMUNICATION_SELLER_API = Object.freeze({
  CATEGORIES: "/api/notifications/categories",
  PREFERENCES_GET: "/api/notifications/preferences",
  PREFERENCES_PATCH: "/api/notifications/preferences",
  RECIPIENTS: "/api/notifications/recipients",
  EVENT_DELIVERY_RULES: "/api/notifications/event-delivery-rules",
  INBOX: "/api/notifications/inbox",
});

/** Resolvers oficiais do motor (já em produção). */
export const S7_COMMUNICATION_PREF_RESOLVER = "resolveNotificationPreferences";
export const S7_COMMUNICATION_RECIPIENT_RESOLVER = "resolveCentralRecipients";
