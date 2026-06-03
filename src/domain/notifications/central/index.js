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

// Canal Pop-up Oficial (Fase S5.7) — metadados + persistência/rastreio (sem provider ativo)
export {
  S7_POPUP_CHANNEL_CODE,
  S7_POPUP_DISPLAY_TYPE,
  S7_POPUP_DISPLAY_MODE,
  S7_POPUP_DELIVERY_STATUS,
  S7_POPUP_PRIORITY,
  S7_POPUP_UI_SURFACE,
  S7_POPUP_DELIVERIES_TABLE,
  S7_POPUP_OFFICIAL_PROVIDER,
  isValidPopupDisplayType,
  isValidPopupDisplayMode,
  isValidPopupPriority,
  planPopupDisplay,
  S7_POPUP_TRACE_FIELDS,
  buildPopupDeliveryTraceSummary,
  logPopupNotification,
  getOfficialPopupChannelSnapshot,
  evaluateOfficialPopupDisplay,
  previewPopupTemplate,
  describePopupMultiSurfaceReuse,
} from "./popup/index.js";

// Central Sininho Oficial (Fase S5.8) — metadados + histórico in_app (sem alterar inbox legado)
export {
  S7_SININHO_CHANNEL_CODE,
  S7_SININHO_CHANNEL_ALIASES,
  S7_SININHO_SEVERITY,
  S7_SININHO_INBOX_STATUS,
  S7_SININHO_READ_STATE,
  S7_SININHO_ARCHIVE_STATE,
  S7_SININHO_FUTURE_CATEGORY,
  S7_SININHO_INBOX_TABLE,
  S7_SININHO_OFFICIAL_PROVIDER,
  S7_SININHO_INBOX_API,
  isValidSininhoSeverity,
  resolveSininhoReadState,
  resolveSininhoArchiveState,
  buildSininhoTimelineEntry,
  S7_SININHO_TRACE_FIELDS,
  buildSininhoDeliveryTraceSummary,
  logSininhoNotification,
  getOfficialSininhoChannelSnapshot,
  evaluateOfficialSininhoTimeline,
  previewSininhoTemplate,
  describeSininhoUiReuse,
} from "./sininho/index.js";

// Preferências de Comunicação Oficial (Fase S5.9) — governança sem segunda fonte de verdade
export {
  resolveNotificationPreferences,
  S7_COMMUNICATION_PREF_SCOPE,
  S7_COMMUNICATION_PREFERENCES_TABLE,
  S7_COMMUNICATION_RECIPIENTS_TABLE,
  S7_COMMUNICATION_RECIPIENT_SCOPES_TABLE,
  S7_COMMUNICATION_EVENT_RULES_TABLE,
  S7_COMMUNICATION_EVENT_TYPES_TABLE,
  S7_COMMUNICATION_RECIPIENT_ROLE,
  S7_COMMUNICATION_MANDATORY_TIER,
  S7_COMMUNICATION_FREQUENCY,
  S7_COMMUNICATION_QUIET_HOURS_MODE,
  S7_COMMUNICATION_SELLER_API,
  S7_COMMUNICATION_PREF_RESOLVER,
  S7_COMMUNICATION_RECIPIENT_RESOLVER,
  resolveCommunicationMandatoryTier,
  isValidCommunicationFrequency,
  isValidQuietHoursMode,
  planCommunicationDeliveryPolicy,
  describePreferenceDimensions,
  describeCommunicationRecipientsGovernance,
  describeCommunicationDispatcherPipeline,
  S7_COMMUNICATION_PREF_TRACE_FIELDS,
  buildCommunicationPreferencesTraceSummary,
  logCommunicationPreferences,
  getOfficialCommunicationPreferencesSnapshot,
  evaluateOfficialMandatoryTier,
} from "./preferences/index.js";

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
