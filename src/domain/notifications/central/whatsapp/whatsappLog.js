// =============================================================================
// Logs estruturados — [S7_WHATSAPP]_* (Fase 3.5A)
// =============================================================================

import { maskPhoneForLog } from "../../notificationLog.js";

const PREFIX = "[S7_WHATSAPP]";

/**
 * @param {string} eventSuffix
 * @param {Record<string, unknown>} [payload]
 */
export function logWhatsAppNotification(eventSuffix, payload = {}) {
  const safe = { ...payload };
  if (safe.recipient_phone != null) {
    safe.recipient_phone_masked = maskPhoneForLog(String(safe.recipient_phone));
    delete safe.recipient_phone;
  }
  if (safe.to != null) {
    safe.to_masked = maskPhoneForLog(String(safe.to));
    delete safe.to;
  }
  if (safe.message_text != null) {
    safe.message_preview = String(safe.message_text).replace(/\s+/g, " ").trim().slice(0, 120);
    delete safe.message_text;
  }
  console.info(`${PREFIX}_${eventSuffix}`, safe);
}
