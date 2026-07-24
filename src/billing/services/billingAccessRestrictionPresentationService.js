// ======================================================================
// Isolamento semântico de restrições (S1.HF.6.9A.11A)
// Nunca inferir causa só por access_profile === EXECUTIVE_ONLY.
// ======================================================================

import {
  BILLING_ACCESS_PROFILE,
  BILLING_ACCESS_RESTRICTION_REASON,
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_USAGE_STATE,
} from "../billingConstants.js";
import {
  resolveTrialLifecyclePresentation,
} from "./billingTrialLifecycleService.js";

export const BILLING_RESTRICTION_CAUSE = Object.freeze({
  TRIAL_EXPIRED: "TRIAL_EXPIRED",
  PAID_USAGE_LIMIT: "PAID_USAGE_LIMIT",
  BABY_QUOTA: "BABY_QUOTA",
  FINANCIAL_DELINQUENCY: "FINANCIAL_DELINQUENCY",
  SECURITY: "SECURITY",
  ADMIN: "ADMIN",
  UNKNOWN: "UNKNOWN",
});

/**
 * @param {Record<string, unknown> | null | undefined} entitlement
 */
export function resolveAccessRestrictionCause(entitlement) {
  const row = entitlement && typeof entitlement === "object" ? entitlement : {};
  const reason = String(row.access_restriction_reason ?? row.access_reason ?? "").trim();
  const owner = String(row.access_owner ?? "").trim();
  const profile = String(row.access_profile ?? "");
  const entitlementKey = String(row.effective_entitlement ?? "");
  const usageState = String(row.usage_state ?? "");
  const syncState = String(row.sync_state ?? "");

  if (
    reason === BILLING_ACCESS_RESTRICTION_REASON.TRIAL_EXPIRED ||
    owner === "TRIAL_LIFECYCLE_ENGINE" ||
    entitlementKey === BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED
  ) {
    return {
      cause: BILLING_RESTRICTION_CAUSE.TRIAL_EXPIRED,
      access_profile: profile || BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY,
      access_reason: BILLING_ACCESS_RESTRICTION_REASON.TRIAL_EXPIRED,
      access_owner: "TRIAL_LIFECYCLE_ENGINE",
    };
  }

  if (
    owner === "BABY_QUOTA_ENGINE" ||
    entitlementKey === BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE ||
    (syncState === "HARD_PAUSED" && String(row.hard_pause_owner ?? "") === "BABY_QUOTA_ENGINE")
  ) {
    return {
      cause: BILLING_RESTRICTION_CAUSE.BABY_QUOTA,
      access_profile: profile,
      access_reason: reason || null,
      access_owner: "BABY_QUOTA_ENGINE",
    };
  }

  if (
    reason === BILLING_ACCESS_RESTRICTION_REASON.PAYMENT_DELINQUENCY ||
    owner === "PAYMENT_DELINQUENCY_ENGINE" ||
    String(row.paid_subscription_status ?? "") === "SUSPENDED"
  ) {
    return {
      cause: BILLING_RESTRICTION_CAUSE.FINANCIAL_DELINQUENCY,
      access_profile: profile,
      access_reason: BILLING_ACCESS_RESTRICTION_REASON.PAYMENT_DELINQUENCY,
      access_owner: "PAYMENT_DELINQUENCY_ENGINE",
    };
  }

  if (
    reason === BILLING_ACCESS_RESTRICTION_REASON.FINANCIAL_STATE_WITHOUT_FALLBACK ||
    profile === BILLING_ACCESS_PROFILE.FINANCIAL_RECOVERY_ONLY
  ) {
    return {
      cause: BILLING_RESTRICTION_CAUSE.FINANCIAL_DELINQUENCY,
      access_profile: profile,
      access_reason: reason || BILLING_ACCESS_RESTRICTION_REASON.FINANCIAL_STATE_WITHOUT_FALLBACK,
      access_owner: owner || "PAYMENT_DELINQUENCY_ENGINE",
    };
  }

  if (
    usageState === BILLING_USAGE_STATE.LIMIT_RESTRICTED ||
    reason === "paid_plan_usage_limit_restricted"
  ) {
    return {
      cause: BILLING_RESTRICTION_CAUSE.PAID_USAGE_LIMIT,
      access_profile: profile || BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY,
      access_reason: reason || "paid_plan_usage_limit_restricted",
      access_owner: owner || null,
    };
  }

  if (
    reason === BILLING_ACCESS_RESTRICTION_REASON.SECURITY_REVOKED ||
    reason === BILLING_ACCESS_RESTRICTION_REASON.INTEGRATION_REVOKED ||
    reason === BILLING_ACCESS_RESTRICTION_REASON.TENANT_DISABLED
  ) {
    return {
      cause: BILLING_RESTRICTION_CAUSE.SECURITY,
      access_profile: profile,
      access_reason: reason,
      access_owner: owner || null,
    };
  }

  if (
    reason === BILLING_ACCESS_RESTRICTION_REASON.ADMINISTRATIVE_HOLD ||
    reason === BILLING_ACCESS_RESTRICTION_REASON.DATA_INTEGRITY_HOLD
  ) {
    return {
      cause: BILLING_RESTRICTION_CAUSE.ADMIN,
      access_profile: profile,
      access_reason: reason,
      access_owner: owner || null,
    };
  }

  return {
    cause: BILLING_RESTRICTION_CAUSE.UNKNOWN,
    access_profile: profile || null,
    access_reason: reason || null,
    access_owner: owner || null,
  };
}

/**
 * CTA/copy por causa — proibido inferir só pelo profile.
 *
 * @param {Record<string, unknown> | null | undefined} entitlement
 * @param {string} [profileFallback]
 */
export function resolveRecommendedUpgradeCtaFromEntitlement(entitlement, profileFallback) {
  const causeInfo = resolveAccessRestrictionCause({
    ...(entitlement && typeof entitlement === "object" ? entitlement : {}),
    access_profile:
      (entitlement && entitlement.access_profile) ||
      profileFallback ||
      null,
  });

  if (causeInfo.cause === BILLING_RESTRICTION_CAUSE.TRIAL_EXPIRED) {
    const presentation = resolveTrialLifecyclePresentation("TRIAL_EXPIRED");
    return {
      action: "CHANGE_PLAN",
      label: presentation?.ctaLabel ?? "Escolher plano",
      path: presentation?.ctaPath ?? "/perfil/assinatura",
      cause: causeInfo.cause,
      title: presentation?.title ?? null,
      message: presentation?.message ?? null,
    };
  }

  if (causeInfo.cause === BILLING_RESTRICTION_CAUSE.PAID_USAGE_LIMIT) {
    return {
      action: "CHANGE_PLAN",
      label: "Ver planos",
      path: "/perfil/assinatura",
      cause: causeInfo.cause,
      title: "Limite do plano atingido",
      message: "Você atingiu o limite de uso do plano. Faça upgrade para continuar com acesso completo.",
    };
  }

  if (causeInfo.cause === BILLING_RESTRICTION_CAUSE.BABY_QUOTA) {
    return {
      action: "CHANGE_PLAN",
      label: "Reativar plano",
      path: "/perfil/assinatura",
      cause: causeInfo.cause,
      title: "Limite do plano Baby atingido",
      message: "A sincronização foi pausada para esta conta. Reative um plano pago ou aguarde o próximo ciclo.",
    };
  }

  if (causeInfo.cause === BILLING_RESTRICTION_CAUSE.FINANCIAL_DELINQUENCY) {
    return {
      action: "MANAGE_BILLING",
      label: "Reativar assinatura",
      path: "/perfil/assinatura",
      cause: causeInfo.cause,
      title: "Assinatura suspensa",
      message:
        "Sua assinatura foi suspensa e a SUSE7 migrou sua conta para o Baby gratuito.",
    };
  }

  const profile = String(profileFallback ?? causeInfo.access_profile ?? "");
  if (profile === BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY) {
    // Fail-closed: profile compartilhado sem causa → CTA neutro de billing.
    return {
      action: "MANAGE_BILLING",
      label: "Ver assinatura",
      path: "/perfil/assinatura",
      cause: BILLING_RESTRICTION_CAUSE.UNKNOWN,
      title: null,
      message: null,
    };
  }

  return null;
}
