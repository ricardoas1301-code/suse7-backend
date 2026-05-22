// ============================================================
// Sanitização de payloads para histórico / detalhe API (Fase 3)
// ============================================================

import { maskEmailForLog, maskPhoneForLog } from "./notificationLog.js";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "access_token",
  "refresh_token",
  "client_secret",
  "password",
  "secret",
  "api_key",
]);

/**
 * @param {unknown} raw
 * @param {number} [depth]
 * @returns {unknown}
 */
export function sanitizeJsonForApi(raw, depth = 0) {
  if (depth > 6) return "[max_depth]";
  if (raw == null) return raw;
  if (typeof raw !== "object") return raw;
  if (Array.isArray(raw)) {
    return raw.slice(0, 50).map((x) => sanitizeJsonForApi(x, depth + 1));
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const lk = k.toLowerCase();
    if (SENSITIVE_KEYS.has(lk)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = sanitizeJsonForApi(v, depth + 1);
  }
  return out;
}

/**
 * @param {string | null | undefined} destination
 * @param {string | null | undefined} channel
 */
export function maskDeliveryDestination(destination, channel) {
  const ch = channel != null ? String(channel).trim().toLowerCase() : "";
  const d = destination != null ? String(destination) : "";
  if (!d) return null;
  if (ch === "email") return maskEmailForLog(d);
  if (ch === "whatsapp") return maskPhoneForLog(d.replace(/\D/g, ""));
  return "[destinatário]";
}
