// ======================================================================
// resolveBillingAccessProfile — precedência + sync + reason (S1.HF.6.9)
// ======================================================================

import {
  BILLING_ACCESS_PROFILE,
  BILLING_ACCESS_RESTRICTION_REASON,
  BILLING_ACCESS_STATE,
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_ENTITLEMENT_CAPABILITY,
  BILLING_FINANCIAL_STATE,
  BILLING_SYNC_STATE,
  BILLING_TRIAL_STATE,
  BILLING_USAGE_STATE,
} from "../billingConstants.js";
import { resolveRecommendedUpgradeCtaFromEntitlement } from "./billingAccessRestrictionPresentationService.js";

const ALL_CAPABILITIES = Object.values(BILLING_ENTITLEMENT_CAPABILITY);

/**
 * @param {Record<string, unknown> | null | undefined} entitlement
 * @returns {string | null}
 */
export function resolveAccessRestrictionReason(entitlement) {
  if (!entitlement || typeof entitlement !== "object") return null;

  const explicit = entitlement.access_restriction_reason;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return explicit.trim();
  }

  if (Boolean(entitlement.security_access_revoked)) {
    return BILLING_ACCESS_RESTRICTION_REASON.SECURITY_REVOKED;
  }
  if (Boolean(entitlement.integration_access_revoked)) {
    return BILLING_ACCESS_RESTRICTION_REASON.INTEGRATION_REVOKED;
  }
  if (Boolean(entitlement.tenant_disabled)) {
    return BILLING_ACCESS_RESTRICTION_REASON.TENANT_DISABLED;
  }
  if (Boolean(entitlement.data_integrity_hold)) {
    return BILLING_ACCESS_RESTRICTION_REASON.DATA_INTEGRITY_HOLD;
  }
  if (Boolean(entitlement.administrative_hold)) {
    return BILLING_ACCESS_RESTRICTION_REASON.ADMINISTRATIVE_HOLD;
  }

  const trialState = String(entitlement.trial_state ?? "");
  const billingFinancialState = String(entitlement.billing_financial_state ?? "");
  const accessState = String(entitlement.access_state ?? "");
  const suspensionFallbackActive = Boolean(entitlement.suspension_fallback_active);

  if (trialState === BILLING_TRIAL_STATE.REVOKED) {
    return BILLING_ACCESS_RESTRICTION_REASON.SECURITY_REVOKED;
  }

  if (
    trialState === BILLING_TRIAL_STATE.EXPIRED ||
    String(entitlement.effective_entitlement ?? "") ===
      BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED ||
    String(entitlement.access_owner ?? "") === "TRIAL_LIFECYCLE_ENGINE"
  ) {
    return BILLING_ACCESS_RESTRICTION_REASON.TRIAL_EXPIRED;
  }

  if (
    billingFinancialState === BILLING_FINANCIAL_STATE.SUSPENDED &&
    !suspensionFallbackActive
  ) {
    return BILLING_ACCESS_RESTRICTION_REASON.FINANCIAL_STATE_WITHOUT_FALLBACK;
  }

  if (accessState === BILLING_ACCESS_STATE.BLOCKED && !suspensionFallbackActive) {
    return BILLING_ACCESS_RESTRICTION_REASON.FINANCIAL_STATE_WITHOUT_FALLBACK;
  }

  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} entitlement
 */
export function resolveBillingAccessProfile(entitlement) {
  return resolveBillingAccessContext(entitlement).access_profile;
}

/**
 * @param {Record<string, unknown> | null | undefined} entitlement
 */
export function resolveBillingAccessContext(entitlement) {
  if (!entitlement || typeof entitlement !== "object") {
    return {
      access_profile: BILLING_ACCESS_PROFILE.FULL_ACCESS,
      sync_state: BILLING_SYNC_STATE.FULL,
      access_restriction_reason: null,
    };
  }

  const usageState = String(entitlement.usage_state ?? "");
  const syncState = String(entitlement.sync_state ?? "");
  const effectiveEntitlement = String(entitlement.effective_entitlement ?? "");
  const billingFinancialState = String(entitlement.billing_financial_state ?? "");
  const suspensionFallbackActive = Boolean(entitlement.suspension_fallback_active);
  const isBaby =
    effectiveEntitlement === BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE || Boolean(entitlement.is_baby);

  const restrictionReason = resolveAccessRestrictionReason(entitlement);
  // Pós-trial (S1.HF.6.9A.11): restrição de capabilities com sync FULL — não misturar com recovery.
  if (
    restrictionReason === BILLING_ACCESS_RESTRICTION_REASON.TRIAL_EXPIRED ||
    effectiveEntitlement === BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED ||
    String(entitlement.access_owner ?? "") === "TRIAL_LIFECYCLE_ENGINE"
  ) {
    return {
      access_profile: BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY,
      sync_state: BILLING_SYNC_STATE.FULL,
      access_restriction_reason: BILLING_ACCESS_RESTRICTION_REASON.TRIAL_EXPIRED,
      access_owner: "TRIAL_LIFECYCLE_ENGINE",
    };
  }

  if (restrictionReason) {
    if (
      suspensionFallbackActive &&
      billingFinancialState === BILLING_FINANCIAL_STATE.SUSPENDED &&
      usageState !== BILLING_USAGE_STATE.HARD_LIMIT_REACHED
    ) {
      // Baby fallback ativo — não tratar como recovery total.
    } else {
      return {
        access_profile: BILLING_ACCESS_PROFILE.FINANCIAL_RECOVERY_ONLY,
        sync_state: BILLING_SYNC_STATE.HARD_PAUSED,
        access_restriction_reason: restrictionReason,
      };
    }
  }

  if (
    usageState === BILLING_USAGE_STATE.HARD_LIMIT_REACHED &&
    (isBaby || effectiveEntitlement === BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE)
  ) {
    return {
      access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
      sync_state: BILLING_SYNC_STATE.HARD_PAUSED,
      access_restriction_reason: null,
    };
  }

  if (syncState === BILLING_SYNC_STATE.HARD_PAUSED && isBaby) {
    return {
      access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
      sync_state: BILLING_SYNC_STATE.HARD_PAUSED,
      access_restriction_reason: null,
    };
  }

  if (
    usageState === BILLING_USAGE_STATE.LIMIT_RESTRICTED &&
    effectiveEntitlement !== BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE
  ) {
    return {
      access_profile: BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY,
      sync_state: BILLING_SYNC_STATE.FULL,
      access_restriction_reason: null,
    };
  }

  const accessState = String(entitlement.access_state ?? "");
  if (
    accessState === BILLING_ACCESS_STATE.DETAILED_ACCESS_RESTRICTED ||
    accessState === BILLING_ACCESS_STATE.LIMITED
  ) {
    return {
      access_profile: BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY,
      sync_state: BILLING_SYNC_STATE.FULL,
      access_restriction_reason: null,
    };
  }

  if (accessState === BILLING_ACCESS_STATE.ARCHIVE_READ_ONLY) {
    return {
      access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
      sync_state: BILLING_SYNC_STATE.HARD_PAUSED,
      access_restriction_reason: null,
    };
  }

  if (
    syncState === BILLING_SYNC_STATE.HARD_PAUSED ||
    accessState === BILLING_ACCESS_STATE.HARD_PAUSED
  ) {
    return {
      access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
      sync_state: BILLING_SYNC_STATE.HARD_PAUSED,
      access_restriction_reason: null,
    };
  }

  return {
    access_profile: BILLING_ACCESS_PROFILE.FULL_ACCESS,
    sync_state: BILLING_SYNC_STATE.FULL,
    access_restriction_reason: null,
  };
}

/**
 * Mapa declarativo por perfil — SSOT capabilities.
 *
 * @param {string} profile
 */
export function resolveCapabilitiesByAccessProfile(profile) {
  /** @type {Record<string, boolean>} */
  const map = {};
  for (const key of ALL_CAPABILITIES) {
    map[key] = false;
  }

  map[BILLING_ENTITLEMENT_CAPABILITY.MANAGE_BILLING] = true;
  map[BILLING_ENTITLEMENT_CAPABILITY.CHANGE_PLAN] = true;

  if (profile === BILLING_ACCESS_PROFILE.FULL_ACCESS) {
    for (const key of ALL_CAPABILITIES) {
      map[key] = true;
    }
    return map;
  }

  if (profile === BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY) {
    map[BILLING_ENTITLEMENT_CAPABILITY.VIEW_EXECUTIVE_CARDS] = true;
    map[BILLING_ENTITLEMENT_CAPABILITY.RECEIVE_AND_PROCESS_WEBHOOKS] = true;
    map[BILLING_ENTITLEMENT_CAPABILITY.CALL_MARKETPLACE_APIS] = true;
    return map;
  }

  if (profile === BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY) {
    map[BILLING_ENTITLEMENT_CAPABILITY.VIEW_EXECUTIVE_CARDS] = true;
    map[BILLING_ENTITLEMENT_CAPABILITY.VIEW_STORED_LISTS] = true;
    map[BILLING_ENTITLEMENT_CAPABILITY.USE_LIST_FILTERS] = true;
    map[BILLING_ENTITLEMENT_CAPABILITY.VIEW_STORED_DETAILS] = true;
    return map;
  }

  return map;
}

/**
 * @param {Record<string, unknown> | null | undefined} entitlement
 */
export function resolveBillingAccessCapabilities(entitlement) {
  const context = resolveBillingAccessContext(entitlement);
  const capabilities = resolveCapabilitiesByAccessProfile(context.access_profile);

  if (context.access_profile === BILLING_ACCESS_PROFILE.FULL_ACCESS) {
    const trialState = String(entitlement?.trial_state ?? "");
    if (trialState === BILLING_TRIAL_STATE.ACTIVE) {
      return capabilities;
    }
  }

  return capabilities;
}

/**
 * @param {string | Record<string, unknown> | null | undefined} profileOrEntitlement
 * @param {Record<string, unknown> | null | undefined} [entitlement]
 */
export function resolveRecommendedUpgradeCta(profileOrEntitlement, entitlement = null) {
  if (profileOrEntitlement && typeof profileOrEntitlement === "object") {
    return resolveRecommendedUpgradeCtaFromEntitlement(profileOrEntitlement);
  }
  const profile = String(profileOrEntitlement ?? "");
  if (entitlement && typeof entitlement === "object") {
    return resolveRecommendedUpgradeCtaFromEntitlement({ ...entitlement, access_profile: profile });
  }
  // Compat: profile isolado sem causa — não assumir consumo/trial/inadimplência.
  if (profile === BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY) {
    return {
      action: "MANAGE_BILLING",
      label: "Ver assinatura",
      path: "/perfil/assinatura",
      cause: "UNKNOWN",
    };
  }
  if (profile === BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY) {
    return { action: "CHANGE_PLAN", label: "Reativar plano", path: "/perfil/assinatura", cause: "BABY_QUOTA" };
  }
  if (profile === BILLING_ACCESS_PROFILE.FINANCIAL_RECOVERY_ONLY) {
    return {
      action: "MANAGE_BILLING",
      label: "Regularizar assinatura",
      path: "/perfil/assinatura",
      cause: "FINANCIAL_DELINQUENCY",
    };
  }
  return null;
}
