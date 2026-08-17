// =============================================================================
// S7 — Catálogo de Notificações — superfície pública (Motor Central)
// =============================================================================

export {
  S7_NOTIFICATION_CATALOG_TABLES,
  S7_NOTIFICATION_CATALOG_DOMAIN_GROUP,
  S7_NOTIFICATION_CATALOG_PRIORITY,
  S7_NOTIFICATION_CATALOG_MANDATORY,
  S7_NOTIFICATION_CATALOG_CHANNEL,
  S7_NOTIFICATION_CATALOG_CODE_MIRROR,
} from "./notificationCatalogContract.js";

export {
  S7_CATALOG_CATEGORY_DOMAIN_MAP,
  listCatalogSupportedCategories,
  getCatalogCategoryMeta,
} from "./notificationCatalogCategoryRegistry.js";

export {
  S7_CATALOG_PRIORITY_COMPAT,
  isValidCatalogPriority,
  listCatalogSupportedPriorities,
} from "./notificationCatalogPriorityRegistry.js";

export { listCatalogSupportedChannels } from "./notificationCatalogChannelRegistry.js";

export {
  S7_CATALOG_MANDATORY_TO_COMMUNICATION,
  listCatalogMandatoryTiers,
  mapMandatoryFlagToCatalogTier,
} from "./notificationCatalogMandatoryRegistry.js";

export {
  S7_CATALOG_EVENT_TYPE_GROUPS,
  validateFutureNotificationDefinitionShape,
  countRuntimeCatalogTypeEntries,
  listRuntimeCatalogTypeKeys,
} from "./notificationCatalogTypeRegistry.js";

export { describeFutureNotificationDefinitionSchema } from "./notificationCatalogFutureModel.js";

export {
  getOfficialNotificationCatalogSnapshot,
  getNotificationCatalogPublicContract,
} from "./notificationCatalogOfficial.js";

export { logNotificationCatalog } from "./notificationCatalogLog.js";
