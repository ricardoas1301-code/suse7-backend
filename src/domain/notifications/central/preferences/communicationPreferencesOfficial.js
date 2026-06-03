// =============================================================================
// S7 — Preferências de Comunicação Oficial (Fase S5.9)
// Fonte única de metadados — NÃO duplica Central de Notificações nem APIs seller.
// =============================================================================

import { S7_NOTIFICATION_CHANNEL_ORDER } from "../constants/channels.js";
import {
  S7_COMMUNICATION_EVENT_RULES_TABLE,
  S7_COMMUNICATION_EVENT_TYPES_TABLE,
  S7_COMMUNICATION_MANDATORY_TIER,
  S7_COMMUNICATION_PREFERENCES_TABLE,
  S7_COMMUNICATION_PREF_RESOLVER,
  S7_COMMUNICATION_RECIPIENT_RESOLVER,
  S7_COMMUNICATION_RECIPIENT_SCOPES_TABLE,
  S7_COMMUNICATION_RECIPIENTS_TABLE,
  S7_COMMUNICATION_SELLER_API,
} from "./communicationPreferencesContract.js";
import { describeCommunicationDispatcherPipeline } from "./communicationDispatcherBridge.js";
import { describeCommunicationRecipientsGovernance } from "./communicationRecipientsGovernance.js";
import {
  planCommunicationDeliveryPolicy,
  resolveCommunicationMandatoryTier,
} from "./communicationPreferencesPolicy.js";
import { describeSininhoUiReuse } from "../sininho/sininhoUiReuse.js";

/**
 * Snapshot oficial das Preferências de Comunicação (sem secrets).
 */
export function getOfficialCommunicationPreferencesSnapshot() {
  return {
    phase: "S5.9",
    single_source_of_truth: true,
    parallel_motor: false,
    preferences: {
      table: S7_COMMUNICATION_PREFERENCES_TABLE,
      dimensions: ["seller_id", "category_code", "type_key", "channel", "enabled"],
      scope_precedence: "type_key específico sobrescreve category-wide (type_key null)",
      resolver: S7_COMMUNICATION_PREF_RESOLVER,
      action_wrapper: "resolveNotificationActionPreferences",
      ui_service: "getSellerNotificationPreferences / patchSellerNotificationPreferences",
      validation: "validateMandatoryPreferences",
      channels_order: [...S7_NOTIFICATION_CHANNEL_ORDER],
    },
    recipients: describeCommunicationRecipientsGovernance(),
    event_rules: {
      table: S7_COMMUNICATION_EVENT_RULES_TABLE,
      dimensions: ["seller_id", "category_code", "type_key", "recipient_group_id", "channel", "enabled"],
      ui_service: "listSellerEventDeliveryRules / patchSellerEventDeliveryRules",
      precedence: "Quando existem regras para o evento, filtram grupos; senão recipient_scopes.",
    },
    event_catalog: {
      table: S7_COMMUNICATION_EVENT_TYPES_TABLE,
      code_mirror: "S7_NOTIFICATION_TYPE_CATALOG",
      mandatory_field: "is_mandatory",
    },
    mandatory_communication: {
      tiers: Object.values(S7_COMMUNICATION_MANDATORY_TIER),
      resolver_enforcement: "resolveNotificationPreferences força in_app e fallback email se mandatory",
      patch_validation: "validateMandatoryChannelState",
      future_examples: [
        "subscription_suspended",
        "payment_declined",
        "security_issue",
      ],
      implemented_in_catalog: true,
    },
    delivery_policy_prepared: {
      planner: "planCommunicationDeliveryPolicy",
      frequency: ["immediate", "batched", "daily", "weekly"],
      quiet_hours: ["none", "operational_window", "temporary_mute"],
      applied_in_dispatcher: false,
    },
    dispatcher_integration: describeCommunicationDispatcherPipeline(),
    seller_api: S7_COMMUNICATION_SELLER_API,
    recipient_resolver: S7_COMMUNICATION_RECIPIENT_RESOLVER,
    recipient_action_wrapper: "resolveNotificationActionRecipients",
    tables: {
      preferences: S7_COMMUNICATION_PREFERENCES_TABLE,
      recipients: S7_COMMUNICATION_RECIPIENTS_TABLE,
      recipient_scopes: S7_COMMUNICATION_RECIPIENT_SCOPES_TABLE,
      event_rules: S7_COMMUNICATION_EVENT_RULES_TABLE,
      event_types: S7_COMMUNICATION_EVENT_TYPES_TABLE,
    },
    frontend: {
      hub: "CentralNotificacoesHub.jsx",
      settings_hook: "useCentralNotificationSettings.js",
      api: "centralNotificationsApi.js",
      sininho: describeSininhoUiReuse().sininho_dropdown,
      preserved_ux: true,
    },
    legacy_systems: {
      user_preferences_domain: {
        path: "UserPreferencesDomainService.js",
        note: "Preferências gerais do usuário — separado do motor central de notificações.",
      },
      notify_dot_prefs: {
        note: "notify.{type}.in_app legado em Notificacoes.jsx — coexistência documentada.",
      },
    },
    future_compat: {
      new_channels: "Registro Oficial de Canais S5.3",
      new_marketplaces: "marketplace_account_id em recipients",
      new_modules: "category_code / type_key extensíveis via catálogo",
      new_categories: "s7_notification_categories",
    },
  };
}

/**
 * @param {boolean} isMandatory
 */
export function evaluateOfficialMandatoryTier(isMandatory) {
  return {
    tier: resolveCommunicationMandatoryTier(isMandatory),
    policy: planCommunicationDeliveryPolicy({ frequency: "immediate" }),
  };
}
