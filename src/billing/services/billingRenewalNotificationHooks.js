// ======================================================================
// Hooks internos de notificação — renovação (entrega em missão futura)
// ======================================================================

import { logBilling } from "../billingLog.js";
import { RENEWAL_NOTIFICATION_EVENT } from "../billingConstants.js";

/**
 * @param {string} eventType
 * @param {Record<string, unknown>} payload
 */
export function emitRenewalNotificationHook(eventType, payload) {
  logBilling("billing", "S7_RENEWAL_NOTIFICATION_HOOK", {
    event_type: eventType,
    ...payload,
  });
}

/**
 * @param {number | null} daysUntilDue
 * @param {Record<string, unknown>} ctx
 */
export function emitRenewalPreAlertHooks(daysUntilDue, ctx) {
  if (daysUntilDue == null) return;
  if (daysUntilDue === 3) {
    emitRenewalNotificationHook(RENEWAL_NOTIFICATION_EVENT.RENEWAL_3_DAYS_BEFORE, ctx);
  } else if (daysUntilDue === 2) {
    emitRenewalNotificationHook(RENEWAL_NOTIFICATION_EVENT.RENEWAL_2_DAYS_BEFORE, ctx);
  } else if (daysUntilDue === 1) {
    emitRenewalNotificationHook(RENEWAL_NOTIFICATION_EVENT.RENEWAL_1_DAY_BEFORE, ctx);
  } else if (daysUntilDue === 0) {
    emitRenewalNotificationHook(RENEWAL_NOTIFICATION_EVENT.RENEWAL_DUE_TODAY, ctx);
  }
}

export { RENEWAL_NOTIFICATION_EVENT };
