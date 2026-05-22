// =============================================================================
// Observabilidade seller UI / prefs / recipients (Fase 3.1.1)
// =============================================================================

export function logNotificationPref(eventSuffix, payload = {}) {
  console.info(`[S7_NOTIFICATION_PREF]_${eventSuffix}`, payload);
}

export function logNotificationRecipient(eventSuffix, payload = {}) {
  console.info(`[S7_NOTIFICATION_RECIPIENT]_${eventSuffix}`, payload);
}

export function logNotificationUi(eventSuffix, payload = {}) {
  console.info(`[S7_NOTIFICATION_UI]_${eventSuffix}`, payload);
}
