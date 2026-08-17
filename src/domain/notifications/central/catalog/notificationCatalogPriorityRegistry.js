// =============================================================================
// S7 — Catálogo (S5.11) — registro de prioridades / severity
// =============================================================================

import { S7_COMMUNICATION_PRIORITY } from "../constants/communicationContract.js";
import { S7_NOTIFICATION_CATALOG_PRIORITY } from "./notificationCatalogContract.js";

/**
 * Compatibilidade severity (eventos) ↔ prioridade catálogo ↔ contrato S5.1.
 * @type {Readonly<Record<string, { severity: string; communication_priority: string }>>}
 */
export const S7_CATALOG_PRIORITY_COMPAT = Object.freeze({
  [S7_NOTIFICATION_CATALOG_PRIORITY.INFO]: {
    severity: "info",
    communication_priority: S7_COMMUNICATION_PRIORITY.NORMAL,
  },
  [S7_NOTIFICATION_CATALOG_PRIORITY.WARNING]: {
    severity: "warning",
    communication_priority: S7_COMMUNICATION_PRIORITY.NORMAL,
  },
  [S7_NOTIFICATION_CATALOG_PRIORITY.HIGH]: {
    severity: "warning",
    communication_priority: S7_COMMUNICATION_PRIORITY.HIGH,
  },
  [S7_NOTIFICATION_CATALOG_PRIORITY.CRITICAL]: {
    severity: "critical",
    communication_priority: S7_COMMUNICATION_PRIORITY.CRITICAL,
  },
});

const PRIORITY_SET = new Set(Object.values(S7_NOTIFICATION_CATALOG_PRIORITY));

/**
 * @param {string} priority
 */
export function isValidCatalogPriority(priority) {
  return PRIORITY_SET.has(String(priority ?? "").trim().toLowerCase());
}

/**
 * @returns {Array<{ code: string; severity: string; communication_priority: string }>}
 */
export function listCatalogSupportedPriorities() {
  return Object.values(S7_NOTIFICATION_CATALOG_PRIORITY).map((code) => ({
    code,
    ...S7_CATALOG_PRIORITY_COMPAT[code],
  }));
}
