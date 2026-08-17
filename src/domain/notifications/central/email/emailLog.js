// =============================================================================
// Logs estruturados — [S7_EMAIL]_* (Fase 3.4)
// =============================================================================

import { maskEmailForLog } from "../../notificationLog.js";

const PREFIX = "[S7_EMAIL]";

/**
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} [payload]
 */
export function logEmailNotification(eventSuffix, payload = {}) {
  const safe = { ...payload };
  if (safe.recipient_email != null) {
    safe.recipient_email_masked = maskEmailForLog(String(safe.recipient_email));
    delete safe.recipient_email;
  }
  if (safe.to != null) {
    safe.to_masked = maskEmailForLog(String(safe.to));
    delete safe.to;
  }
  console.info(`${PREFIX}_${eventSuffix}`, safe);
}
