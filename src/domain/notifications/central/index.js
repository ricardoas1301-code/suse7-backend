// =============================================================================
// S7 Central Notification Engine — API pública do domínio (Fase 3.1)
// =============================================================================

export { S7_NOTIFICATION_CATEGORY, isValidNotificationCategory } from "./constants/categories.js";
export { S7_NOTIFICATION_CHANNEL, isValidNotificationChannel } from "./constants/channels.js";
export {
  S7_NOTIFICATION_DISPATCH_STATUS,
  S7_DISPATCH_TERMINAL_STATUS,
  S7_DISPATCH_IN_FLIGHT_STATUS,
  isTerminalDispatchStatus,
  isValidDispatchStatus,
} from "./constants/dispatchStatus.js";
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

// Dispatcher Central (Fase S5.2)
export {
  runCentralDispatcher,
  S7_DISPATCH_CHANNEL_CATALOG,
  S7_DISPATCH_DELIVERY_MODE,
  resolveCanonicalChannel,
  getChannelCatalogEntry,
  isChannelSupportedNow,
  listSupportedChannels,
  routeChannels,
  S7_DISPATCH_FINAL_RESULT,
  resolveFinalResult,
  summarizeChannelStatusFromDispatches,
  summarizeEventChannelStatus,
  S7_DISPATCH_RETRY_DEFAULTS,
  resolveDispatchRetryPolicy,
  planDispatchRetry,
  resolveChannelFallbackChain,
  resolveNextFallbackChannel,
} from "./dispatcherCentral/index.js";
export {
  runNotificationActionsEngine,
  planNotificationActions,
} from "./actions/notificationActionsEngine.js";
export { NOTIFICATION_ACTION_STATUS } from "./actions/notificationActionTypes.js";
export { logCentralNotification } from "./observability/centralNotificationLog.js";
export { getCentralNotificationEngineSummary } from "./analytics/notificationEngineAnalytics.js";
