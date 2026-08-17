// =============================================================================
// S7 — Preferências de Comunicação (Fase S5.9) — políticas (infra, puro)
// Horários, frequência e obrigatoriedade — sem alterar entregas atuais.
// =============================================================================

import {
  S7_COMMUNICATION_FREQUENCY,
  S7_COMMUNICATION_MANDATORY_TIER,
  S7_COMMUNICATION_QUIET_HOURS_MODE,
} from "./communicationPreferencesContract.js";

const FREQUENCIES = new Set(Object.values(S7_COMMUNICATION_FREQUENCY));
const QUIET_MODES = new Set(Object.values(S7_COMMUNICATION_QUIET_HOURS_MODE));

/**
 * @param {boolean | undefined} isMandatory
 */
export function resolveCommunicationMandatoryTier(isMandatory) {
  return isMandatory === true
    ? S7_COMMUNICATION_MANDATORY_TIER.MANDATORY
    : S7_COMMUNICATION_MANDATORY_TIER.OPTIONAL;
}

/**
 * @param {string} frequency
 */
export function isValidCommunicationFrequency(frequency) {
  return FREQUENCIES.has(String(frequency ?? "").trim().toLowerCase());
}

/**
 * @param {string} mode
 */
export function isValidQuietHoursMode(mode) {
  return QUIET_MODES.has(String(mode ?? "").trim().toLowerCase());
}

/**
 * Planeja política de entrega futura (sem I/O, não aplicada pelo dispatcher hoje).
 * @param {{
 *   frequency?: string;
 *   quiet_hours_mode?: string;
 *   operational_window?: { start?: string; end?: string; timezone?: string };
 *   mute_until?: string | null;
 * }} [input]
 */
export function planCommunicationDeliveryPolicy(input = {}) {
  const frequency = isValidCommunicationFrequency(input.frequency)
    ? String(input.frequency).toLowerCase()
    : S7_COMMUNICATION_FREQUENCY.IMMEDIATE;
  const quiet_hours_mode = isValidQuietHoursMode(input.quiet_hours_mode)
    ? String(input.quiet_hours_mode).toLowerCase()
    : S7_COMMUNICATION_QUIET_HOURS_MODE.NONE;

  return {
    frequency,
    quiet_hours_mode,
    operational_window: input.operational_window ?? null,
    mute_until: input.mute_until ?? null,
    applied: false,
    note: "Estrutura S5.9 — política ainda não bloqueia envio no Dispatcher.",
  };
}

/**
 * Formaliza dimensões de preferência para auditoria/UI.
 * @param {{
 *   category_code?: string;
 *   type_key?: string | null;
 *   channel?: string;
 *   enabled?: boolean;
 * }} row
 */
export function describePreferenceDimensions(row = {}) {
  return {
    by_category: Boolean(row.category_code),
    by_type: row.type_key != null && String(row.type_key).trim() !== "",
    by_channel: Boolean(row.channel),
    scope_key: `${row.category_code ?? "*"}:${row.type_key ?? "*"}`,
    enabled: row.enabled !== false,
  };
}
