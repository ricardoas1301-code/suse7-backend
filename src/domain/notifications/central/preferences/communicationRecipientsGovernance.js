// =============================================================================
// S7 — Preferências de Comunicação (Fase S5.9) — governança de destinatários
// Documentação estrutural — delega resolução a resolveCentralRecipients.
// =============================================================================

import { S7_COMMUNICATION_RECIPIENT_ROLE } from "./communicationPreferencesContract.js";

/**
 * Descreve o modelo oficial de destinatários (sem alterar resolução).
 */
export function describeCommunicationRecipientsGovernance() {
  return {
    primary_table: "s7_notification_recipients",
    scopes_table: "s7_notification_recipient_scopes",
    event_rules_table: "s7_notification_event_delivery_rules",
    groups_column: "recipient_group_id",
    channels_supported: ["email", "whatsapp"],
    in_app_owner: {
      role: S7_COMMUNICATION_RECIPIENT_ROLE.OWNER_IN_APP,
      note: "Sininho — sem destinatário externo; seller_id implícito.",
    },
    primary_flag: "is_primary",
    additional: "destinatários ativos no mesmo canal",
    fallback: {
      email: "profiles.email",
      whatsapp: "profiles.phone",
      role: S7_COMMUNICATION_RECIPIENT_ROLE.PROFILE_FALLBACK,
    },
    manual_override: {
      role: S7_COMMUNICATION_RECIPIENT_ROLE.MANUAL_OVERRIDE,
      entry: "manual_recipients_by_channel no Actions Engine (ex.: Raio-X)",
    },
    future_channels: ["popup", "push", "banner"],
  };
}
