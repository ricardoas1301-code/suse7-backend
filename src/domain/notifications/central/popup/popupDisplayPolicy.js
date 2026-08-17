// =============================================================================
// S7 — Canal Pop-up (Fase S5.7) — política de exibição (infra)
// Controle: imediato, sob demanda, expiração, persistência, prioridade.
// Sem regras de negócio específicas.
// =============================================================================

import {
  S7_POPUP_DISPLAY_MODE,
  S7_POPUP_DISPLAY_TYPE,
  S7_POPUP_PRIORITY,
} from "./popupChannelContract.js";

const DISPLAY_TYPES = new Set(Object.values(S7_POPUP_DISPLAY_TYPE));
const DISPLAY_MODES = new Set(Object.values(S7_POPUP_DISPLAY_MODE));
const PRIORITIES = new Set(Object.values(S7_POPUP_PRIORITY));

/**
 * @param {string} type
 */
export function isValidPopupDisplayType(type) {
  return DISPLAY_TYPES.has(String(type ?? "").trim().toLowerCase());
}

/**
 * @param {string} mode
 */
export function isValidPopupDisplayMode(mode) {
  return DISPLAY_MODES.has(String(mode ?? "").trim().toLowerCase());
}

/**
 * @param {string} priority
 */
export function isValidPopupPriority(priority) {
  return PRIORITIES.has(String(priority ?? "").trim().toLowerCase());
}

/**
 * Planeja metadados de exibição (puro, sem I/O).
 * @param {{
 *   display_type?: string;
 *   display_mode?: string;
 *   priority?: string;
 *   persist_seconds?: number | null;
 *   expires_at?: string | null;
 * }} input
 */
export function planPopupDisplay(input = {}) {
  const display_type = isValidPopupDisplayType(input.display_type)
    ? String(input.display_type).toLowerCase()
    : S7_POPUP_DISPLAY_TYPE.INFO;
  const display_mode = isValidPopupDisplayMode(input.display_mode)
    ? String(input.display_mode).toLowerCase()
    : S7_POPUP_DISPLAY_MODE.IMMEDIATE;
  const priority = isValidPopupPriority(input.priority)
    ? String(input.priority).toLowerCase()
    : S7_POPUP_PRIORITY.NORMAL;

  let expires_at = input.expires_at != null ? String(input.expires_at) : null;
  let persist_until = null;

  const persistSeconds = Number(input.persist_seconds);
  if (Number.isFinite(persistSeconds) && persistSeconds > 0) {
    const until = new Date(Date.now() + persistSeconds * 1000);
    persist_until = until.toISOString();
    if (!expires_at) expires_at = persist_until;
  }

  return {
    display_type,
    display_mode,
    priority,
    persist_until,
    expires_at,
    show_immediately: display_mode === S7_POPUP_DISPLAY_MODE.IMMEDIATE,
  };
}
