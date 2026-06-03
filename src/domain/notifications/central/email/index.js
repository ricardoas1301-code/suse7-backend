// =============================================================================
// S7 — Canal E-mail — superfície pública (Motor Central)
// =============================================================================

export {
  S7_EMAIL_OFFICIAL_PROVIDER,
  S7_EMAIL_OFFICIAL_MODE,
  S7_EMAIL_OFFICIAL_SENDING_DOMAIN,
  S7_EMAIL_OFFICIAL_DEFAULT_FROM,
  S7_EMAIL_DELIVERABILITY_DNS_HINTS,
  S7_EMAIL_OUTBOX_WORKER_PATH,
} from "./emailChannelContract.js";

export {
  parseEmailFromDomain,
  getOfficialEmailChannelSnapshot,
  evaluateOfficialEmailPolicy,
} from "./emailChannelOfficial.js";

export { sendS7Email, isRealEmailProviderConfigured, canSendRealEmailNow } from "./S7EmailProvider.js";
export { processEmailOutbox } from "./processEmailOutbox.js";
export { createEmailOutboxEntry } from "./createEmailOutboxEntry.js";
export { renderNotificationEmailTemplate } from "./renderNotificationEmailTemplate.js";
export { S7_EMAIL_OUTBOX_STATUS, S7_EMAIL_MAX_ATTEMPTS } from "./emailOutboxStatus.js";
export { logEmailNotification } from "./emailLog.js";
