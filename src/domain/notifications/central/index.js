// =============================================================================
// S7 Central Notification Engine — API pública do domínio (Fase 3.1)
// =============================================================================

export { S7_NOTIFICATION_CATEGORY, isValidNotificationCategory } from "./constants/categories.js";
export { S7_NOTIFICATION_CHANNEL, isValidNotificationChannel } from "./constants/channels.js";

// Registro Oficial de Canais (Fase S5.3) — fonte única de verdade dos canais
export {
  S7_CHANNEL_REGISTRY,
  S7_CHANNEL_TYPE,
  S7_CHANNEL_STATUS,
  S7_CHANNEL_DELIVERY_MODE,
  resolveCanonicalChannelCode,
  getChannelDefinition,
  isRegisteredChannel,
  isChannelSupported,
  isChannelAvailable,
  getChannelCapabilities,
  listRegisteredChannels,
  listAvailableChannels,
  listChannelsByStatus,
  filterRegisteredAvailableChannels,
} from "./channels/index.js";
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

// Central de Templates (Fase S5.4)
export {
  renderNotificationTemplate,
  resolveNotificationTemplate,
  extractTemplatePlaceholders,
  renderTemplateString,
  renderTemplate,
  S7_TEMPLATE_STATUS,
  S7_TEMPLATE_TYPE,
  S7_TEMPLATE_INITIAL_VERSION,
  isValidTemplateStatus,
  isValidTemplateType,
  toTemplateContract,
  validateTemplateContract,
  S7_TEMPLATE_VARIABLE_SCOPE,
  defineTemplateVariable,
  buildTemplateVariableContext,
  buildSampleVariables,
  normalizeVariablesSchema,
  listTemplates,
  getTemplate,
  getTemplateVersionHistory,
  groupTemplatesByChannel,
  isTemplateChannelRegistered,
  previewTemplate,
} from "./templates/index.js";

// Canal E-mail Oficial (Fase S5.5) — metadados + integração dispatcher/outbox
export {
  S7_EMAIL_OFFICIAL_PROVIDER,
  S7_EMAIL_OFFICIAL_MODE,
  S7_EMAIL_OFFICIAL_SENDING_DOMAIN,
  S7_EMAIL_OFFICIAL_DEFAULT_FROM,
  S7_EMAIL_DELIVERABILITY_DNS_HINTS,
  S7_EMAIL_OUTBOX_WORKER_PATH,
  parseEmailFromDomain,
  getOfficialEmailChannelSnapshot,
  evaluateOfficialEmailPolicy,
  sendS7Email,
  isRealEmailProviderConfigured,
  canSendRealEmailNow,
  processEmailOutbox,
  createEmailOutboxEntry,
  renderNotificationEmailTemplate,
  S7_EMAIL_OUTBOX_STATUS,
  S7_EMAIL_MAX_ATTEMPTS,
  logEmailNotification,
} from "./email/index.js";

// Canal WhatsApp Oficial (Fase S5.6) — metadados + integração dispatcher/outbox/Raio-X
export {
  S7_WHATSAPP_OFFICIAL_PROVIDER,
  S7_WHATSAPP_OFFICIAL_PROVIDER_DEFAULT,
  S7_WHATSAPP_OFFICIAL_MODE,
  S7_WHATSAPP_OUTBOX_WORKER_PATH,
  S7_WHATSAPP_MANUAL_RAYX_API_PATH,
  S7_WHATSAPP_MANUAL_RAYX_FLOW,
  S7_WHATSAPP_PROVIDER_REGISTRY_ORDER,
  getOfficialWhatsAppChannelSnapshot,
  evaluateOfficialWhatsAppPolicy,
  S7_WHATSAPP_MULTI_RECIPIENT_DEDUPE,
  describeWhatsAppMultiRecipientPolicy,
  dedupeOfficialWhatsAppRecipients,
  normalizeBrazilWhatsAppPhone,
  S7_WHATSAPP_TRACE_FIELDS,
  buildWhatsAppDeliveryTraceSummary,
  sendWhatsAppMessage,
  isRealWhatsAppProviderConfigured,
  isWhatsAppLiveDeliveryActive,
  processWhatsAppOutbox,
  processWhatsAppOutboxDispatch,
  createWhatsAppOutboxEntry,
  renderNotificationWhatsAppTemplate,
  S7_WHATSAPP_OUTBOX_STATUS,
  S7_WHATSAPP_MAX_ATTEMPTS,
  logWhatsAppNotification,
} from "./whatsapp/index.js";

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
