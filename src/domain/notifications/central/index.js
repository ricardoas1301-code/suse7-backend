// =============================================================================
// S7 Central Notification Engine — API pública do domínio (Fase 3.1)
// =============================================================================

export { S7_NOTIFICATION_CATEGORY, isValidNotificationCategory } from "./constants/categories.js";
export { S7_NOTIFICATION_CHANNEL, isValidNotificationChannel } from "./constants/channels.js";
export { S7_NOTIFICATION_DISPATCH_STATUS } from "./constants/dispatchStatus.js";
export {
  S7_NOTIFICATION_TYPE_CATALOG,
  lookupNotificationTypeCatalog,
  isValidCentralNotificationType,
} from "./constants/eventTypes.js";

// Contrato Global de Comunicação (Fase S5.1) — Communication Event Model
export {
  S7_COMMUNICATION_CONTRACT_VERSION,
  S7_COMMUNICATION_SUPPORTED_CONTRACT_VERSIONS,
  S7_COMMUNICATION_PRIORITY,
  S7_COMMUNICATION_DEDUPE,
  isSupportedContractVersion,
  isValidCommunicationPriority,
  resolveDefaultPriority,
  normalizeDedupeWindowSeconds,
  buildStandardCommunicationMetadata,
  mergeCommunicationMetadata,
  S7_COMMUNICATION_METADATA_RESERVED_KEYS,
  buildCommunicationEventEnvelope,
  validateCommunicationEvent,
} from "./contract/index.js";

export { publishNotificationEvent } from "./events/publishNotificationEvent.js";
export { runNotificationDispatchEngine } from "./dispatches/notificationDispatchEngine.js";
export { logCentralNotification } from "./observability/centralNotificationLog.js";
export { getCentralNotificationEngineSummary } from "./analytics/notificationEngineAnalytics.js";
