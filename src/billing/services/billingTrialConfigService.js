// ======================================================================
// Configuração canônica do trial — sem hard-code comercial espalhado
// ======================================================================

import {
  BILLING_TRIAL_DURATION_DAYS_DEFAULT,
  BILLING_TRIAL_USAGE_LIMIT_RECOMMENDED_DEFAULT,
} from "../billingConstants.js";

export function resolveTrialDurationDays() {
  const raw = Number(process.env.BILLING_TRIAL_DURATION_DAYS ?? BILLING_TRIAL_DURATION_DAYS_DEFAULT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : BILLING_TRIAL_DURATION_DAYS_DEFAULT;
}

export function resolveTrialUsageLimit() {
  const raw = Number(
    process.env.BILLING_TRIAL_USAGE_LIMIT ?? BILLING_TRIAL_USAGE_LIMIT_RECOMMENDED_DEFAULT
  );
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : BILLING_TRIAL_USAGE_LIMIT_RECOMMENDED_DEFAULT;
}

export function resolveTrialEligibilityExpiryDays() {
  const raw = Number(process.env.BILLING_TRIAL_ELIGIBILITY_EXPIRY_DAYS ?? 90);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 90;
}

/** Recomendação técnica documentada para homologação comercial. */
export function buildTrialUsageLimitRecommendation() {
  return {
    recommended_default: BILLING_TRIAL_USAGE_LIMIT_RECOMMENDED_DEFAULT,
    configured: resolveTrialUsageLimit(),
    source: process.env.BILLING_TRIAL_USAGE_LIMIT ? "env" : "default_recommendation",
  };
}
