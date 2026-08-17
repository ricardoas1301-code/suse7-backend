// ======================================================================
// Capabilities declarativas — gate frontend/backend (S1.HF.6.8)
// ======================================================================

import {
  BILLING_ACCESS_PROFILE,
  BILLING_ENTITLEMENT_CAPABILITY,
  BILLING_ENTITLEMENT_CAPABILITY_LEGACY_ALIAS,
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_TRIAL_STATE,
  BILLING_USAGE_STATE,
} from "../billingConstants.js";
import {
  resolveBillingAccessCapabilities,
  resolveBillingAccessProfile,
} from "./billingAccessProfileService.js";

/**
 * @param {Record<string, unknown> | null | undefined} entitlement
 */
export function resolveBillingEntitlementCapabilities(entitlement) {
  if (!entitlement || typeof entitlement !== "object") {
    return resolveBillingAccessCapabilities(null);
  }

  const profile = resolveBillingAccessProfile(entitlement);
  const capabilities = resolveBillingAccessCapabilities(entitlement);

  if (
    profile === BILLING_ACCESS_PROFILE.FULL_ACCESS &&
    (entitlement.trial_state === BILLING_TRIAL_STATE.ACTIVE ||
      entitlement.effective_entitlement === BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_FULL_ACCESS)
  ) {
    if (entitlement.usage_state === BILLING_USAGE_STATE.TRIAL_LIMIT_REACHED) {
      return withLegacyAliases(capabilities);
    }
  }

  return withLegacyAliases(capabilities);
}

/**
 * @param {Record<string, boolean>} canonical
 */
function withLegacyAliases(canonical) {
  /** @type {Record<string, boolean>} */
  const merged = { ...canonical };
  for (const [legacyKey, canonicalKey] of Object.entries(BILLING_ENTITLEMENT_CAPABILITY_LEGACY_ALIAS)) {
    merged[legacyKey] = Boolean(canonical[canonicalKey]);
  }
  return merged;
}

/**
 * @param {Record<string, boolean> | null | undefined} capabilities
 * @param {string} capability
 */
export function hasEntitlementCapability(capabilities, capability) {
  if (!capabilities) return false;
  if (Object.prototype.hasOwnProperty.call(capabilities, capability)) {
    return Boolean(capabilities[capability]);
  }
  const alias = BILLING_ENTITLEMENT_CAPABILITY_LEGACY_ALIAS[capability];
  if (alias) return Boolean(capabilities[alias]);
  return false;
}

/**
 * @param {Record<string, boolean> | null | undefined} capabilities
 * @param {string} capability
 */
export function assertEntitlementCapability(capabilities, capability) {
  return hasEntitlementCapability(capabilities, capability);
}
