// =============================================================================
// S7 — Catálogo (S5.11) — obrigatoriedade (compatível preferências + dispatcher)
// =============================================================================

import { S7_COMMUNICATION_MANDATORY_TIER } from "../preferences/communicationPreferencesContract.js";
import { S7_NOTIFICATION_CATALOG_MANDATORY } from "./notificationCatalogContract.js";

/** @type {Readonly<Record<string, string>>} */
export const S7_CATALOG_MANDATORY_TO_COMMUNICATION = Object.freeze({
  [S7_NOTIFICATION_CATALOG_MANDATORY.MANDATORY]: S7_COMMUNICATION_MANDATORY_TIER.MANDATORY,
  [S7_NOTIFICATION_CATALOG_MANDATORY.OPTIONAL]: S7_COMMUNICATION_MANDATORY_TIER.OPTIONAL,
});

/**
 * @returns {string[]}
 */
export function listCatalogMandatoryTiers() {
  return Object.values(S7_NOTIFICATION_CATALOG_MANDATORY);
}

/**
 * @param {boolean} isMandatory
 */
export function mapMandatoryFlagToCatalogTier(isMandatory) {
  return isMandatory === true
    ? S7_NOTIFICATION_CATALOG_MANDATORY.MANDATORY
    : S7_NOTIFICATION_CATALOG_MANDATORY.OPTIONAL;
}
