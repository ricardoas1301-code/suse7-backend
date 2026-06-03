// =============================================================================
// S7 — Canal WhatsApp — superfície pública (Motor Central)
// =============================================================================

export {
  S7_WHATSAPP_OFFICIAL_PROVIDER,
  S7_WHATSAPP_OFFICIAL_PROVIDER_DEFAULT,
  S7_WHATSAPP_OFFICIAL_MODE,
  S7_WHATSAPP_OUTBOX_WORKER_PATH,
  S7_WHATSAPP_MANUAL_RAYX_API_PATH,
  S7_WHATSAPP_MANUAL_RAYX_FLOW,
  S7_WHATSAPP_PROVIDER_REGISTRY_ORDER,
} from "./whatsappChannelContract.js";

export {
  getOfficialWhatsAppChannelSnapshot,
  evaluateOfficialWhatsAppPolicy,
} from "./whatsappChannelOfficial.js";

export {
  S7_WHATSAPP_MULTI_RECIPIENT_DEDUPE,
  describeWhatsAppMultiRecipientPolicy,
  dedupeOfficialWhatsAppRecipients,
  normalizeBrazilWhatsAppPhone,
  dedupeManualRayxRecipientTargets,
} from "./whatsappMultiRecipient.js";

export {
  S7_WHATSAPP_TRACE_FIELDS,
  buildWhatsAppDeliveryTraceSummary,
} from "./whatsappDeliveryTrace.js";

export {
  sendWhatsAppMessage,
  isRealWhatsAppProviderConfigured,
  isWhatsAppLiveDeliveryActive,
} from "./sendWhatsAppMessage.js";
export { processWhatsAppOutbox } from "./processWhatsAppOutbox.js";
export { processWhatsAppOutboxDispatch } from "./processWhatsAppOutboxDispatch.js";
export { createWhatsAppOutboxEntry } from "./createWhatsAppOutboxEntry.js";
export { renderNotificationWhatsAppTemplate } from "./renderNotificationWhatsAppTemplate.js";
export { renderNotificationWhatsAppSandboxTemplate } from "./renderNotificationWhatsAppSandboxTemplate.js";
export { S7_WHATSAPP_OUTBOX_STATUS, S7_WHATSAPP_MAX_ATTEMPTS } from "./whatsappOutboxStatus.js";
export {
  getWhatsAppSandboxWhitelist,
  isDevSandboxWhatsAppMode,
  evaluateWhatsAppSendPolicy,
} from "./whatsappSandboxPolicy.js";
export { logWhatsAppNotification } from "./whatsappLog.js";
