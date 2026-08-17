// =============================================================================
// S7 — Preferências de Comunicação — superfície pública (Motor Central)
// =============================================================================

export { resolveNotificationPreferences } from "./resolveNotificationPreferences.js";

export {
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
} from "./communicationPreferencesContract.js";

export {
  resolveCommunicationMandatoryTier,
  isValidCommunicationFrequency,
  isValidQuietHoursMode,
  planCommunicationDeliveryPolicy,
  describePreferenceDimensions,
} from "./communicationPreferencesPolicy.js";

export { describeCommunicationRecipientsGovernance } from "./communicationRecipientsGovernance.js";
export { describeCommunicationDispatcherPipeline } from "./communicationDispatcherBridge.js";

export {
  S7_COMMUNICATION_PREF_TRACE_FIELDS,
  buildCommunicationPreferencesTraceSummary,
} from "./communicationPreferencesTrace.js";

export { logCommunicationPreferences } from "./communicationPreferencesLog.js";

export {
  getOfficialCommunicationPreferencesSnapshot,
  evaluateOfficialMandatoryTier,
} from "./communicationPreferencesOfficial.js";
