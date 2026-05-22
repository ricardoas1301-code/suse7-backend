// =============================================================================
// Validação mandatory — backend (Fase 3.1.1)
// =============================================================================

import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { logNotificationPref } from "./sellerNotificationObservability.js";

/**
 * @param {boolean} mandatory
 * @param {Record<string, boolean>} channels
 */
export function validateMandatoryChannelState(mandatory, channels) {
  if (!mandatory) return { ok: true };

  const inApp = channels[S7_NOTIFICATION_CHANNEL.IN_APP] !== false;

  if (!inApp) {
    return {
      ok: false,
      code: "MANDATORY_CHANNELS_REQUIRED",
      message:
        "Notificações obrigatórias devem permanecer ativas no app. E-mail e WhatsApp são definidos por destinatário.",
    };
  }

  return { ok: true };
}

/**
 * @param {Array<{ category_code: string, type_key: string | null, channel: string, enabled: boolean, is_mandatory?: boolean }>} rows
 * @param {Array<{ category_code: string, type_key: string | null, channel: string, enabled: boolean }>} patches
 */
export function validatePreferencePatches(rows, patches) {
  /** @type {Map<string, { mandatory: boolean, channels: Record<string, boolean> }>} */
  const stateByScope = new Map();

  for (const row of rows) {
    const scopeKey = `${row.category_code}:${row.type_key ?? "*"}`;
    const entry = stateByScope.get(scopeKey) ?? {
      mandatory: Boolean(row.is_mandatory),
      channels: {},
    };
    entry.channels[row.channel] = Boolean(row.enabled);
    if (row.is_mandatory) entry.mandatory = true;
    stateByScope.set(scopeKey, entry);
  }

  for (const p of patches) {
    const scopeKey =
      p.type_key != null && String(p.type_key).trim() !== ""
        ? `${p.category_code}:${p.type_key}`
        : `${p.category_code}:*`;
    const entry = stateByScope.get(scopeKey) ?? {
      mandatory: Boolean(p.is_mandatory),
      channels: {},
    };
    if (p.is_mandatory) entry.mandatory = true;
    entry.channels[p.channel] = Boolean(p.enabled);
    stateByScope.set(scopeKey, entry);
  }

  for (const [scopeKey, entry] of stateByScope) {
    if (!entry.mandatory) continue;
    const check = validateMandatoryChannelState(true, entry.channels);
    if (!check.ok) {
      logNotificationPref("MANDATORY_VALIDATION_FAILED", { scope: scopeKey });
      return check;
    }
  }

  return { ok: true };
}
