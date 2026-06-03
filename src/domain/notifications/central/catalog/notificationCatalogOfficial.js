// =============================================================================
// S7 — Catálogo de Notificações Oficial (Fase S5.11)
// Contrato público — esqueleto; sem notificações/eventos/templates de negócio novos.
// =============================================================================

import {
  S7_NOTIFICATION_CATALOG_CHANNEL,
  S7_NOTIFICATION_CATALOG_CODE_MIRROR,
  S7_NOTIFICATION_CATALOG_DOMAIN_GROUP,
  S7_NOTIFICATION_CATALOG_MANDATORY,
  S7_NOTIFICATION_CATALOG_PRIORITY,
  S7_NOTIFICATION_CATALOG_TABLES,
} from "./notificationCatalogContract.js";
import { listCatalogSupportedCategories } from "./notificationCatalogCategoryRegistry.js";
import { listCatalogSupportedPriorities } from "./notificationCatalogPriorityRegistry.js";
import { listCatalogSupportedChannels } from "./notificationCatalogChannelRegistry.js";
import { listCatalogMandatoryTiers } from "./notificationCatalogMandatoryRegistry.js";
import {
  S7_CATALOG_EVENT_TYPE_GROUPS,
  countRuntimeCatalogTypeEntries,
  listRuntimeCatalogTypeKeys,
} from "./notificationCatalogTypeRegistry.js";
import { describeFutureNotificationDefinitionSchema } from "./notificationCatalogFutureModel.js";
import { describeCommunicationDispatcherPipeline } from "../preferences/communicationDispatcherBridge.js";

/**
 * Snapshot oficial do catálogo (sem cadastro de notificações).
 */
export function getOfficialNotificationCatalogSnapshot() {
  return {
    phase: "S5.11",
    skeleton_only: true,
    notifications_registered: 0,
    parallel_catalog: false,
    tables: S7_NOTIFICATION_CATALOG_TABLES,
    runtime_mirror: S7_NOTIFICATION_CATALOG_CODE_MIRROR,
    runtime_type_entries_count: countRuntimeCatalogTypeEntries(),
    domain_groups: Object.values(S7_NOTIFICATION_CATALOG_DOMAIN_GROUP),
    categories: listCatalogSupportedCategories(),
    priorities: listCatalogSupportedPriorities(),
    channels: listCatalogSupportedChannels(),
    mandatory_tiers: listCatalogMandatoryTiers(),
    event_type_groups: S7_CATALOG_EVENT_TYPE_GROUPS,
    future_definition_schema: describeFutureNotificationDefinitionSchema(),
    integrations: {
      dispatcher: describeCommunicationDispatcherPipeline(),
      templates_table: S7_NOTIFICATION_CATALOG_TABLES.TEMPLATES,
      preferences_table: "s7_notification_preferences",
      observability_events: "s7_notification_events",
    },
    rules: {
      no_business_events_this_phase: true,
      no_business_templates_this_phase: true,
      no_dispatch_rules_this_phase: true,
      future_trail: "trilha exclusiva de notificações",
    },
  };
}

/**
 * Contrato público — respostas agregadas (sem notificações reais).
 */
export function getNotificationCatalogPublicContract() {
  return {
    categories: listCatalogSupportedCategories().map((c) => c.code),
    priorities: listCatalogSupportedPriorities().map((p) => p.code),
    channels: listCatalogSupportedChannels().map((c) => c.code),
    mandatory_tiers: listCatalogMandatoryTiers(),
    domain_groups: Object.values(S7_NOTIFICATION_CATALOG_DOMAIN_GROUP),
    type_groups: S7_CATALOG_EVENT_TYPE_GROUPS.map((g) => g.group_code),
    runtime_type_keys_sample: listRuntimeCatalogTypeKeys().slice(0, 5),
    catalog_channel_codes: Object.values(S7_NOTIFICATION_CATALOG_CHANNEL),
    catalog_priority_codes: Object.values(S7_NOTIFICATION_CATALOG_PRIORITY),
    catalog_mandatory_codes: Object.values(S7_NOTIFICATION_CATALOG_MANDATORY),
  };
}
