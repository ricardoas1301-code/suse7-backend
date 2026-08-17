// =============================================================================
// Logs estruturados — S7_NOTIFICATION_* (Fase 3.1)
// =============================================================================

import { maskEmailForLog, maskPhoneForLog } from "../../notificationLog.js";

const PREFIX = "[S7_NOTIFICATION]";

/**
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} [payload]
 */
export function logCentralNotification(eventSuffix, payload = {}) {
  const safe = { ...payload };
  if (safe.destination_masked == null && typeof safe.destination === "string") {
    const ch = safe.channel != null ? String(safe.channel) : "";
    safe.destination_masked =
      ch === "email" ? maskEmailForLog(safe.destination) : maskPhoneForLog(safe.destination);
    delete safe.destination;
  }
  console.info(`${PREFIX}_${eventSuffix}`, safe);
}
