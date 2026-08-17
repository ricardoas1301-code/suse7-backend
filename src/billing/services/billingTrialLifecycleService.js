// ======================================================================
// Trial lifecycle SSOT — 15 dias civis America/Sao_Paulo (S1.HF.6.9A.11)
// Relógio canônico + máquina de estados pura (sem I/O).
// ======================================================================

import {
  BILLING_ACCESS_PROFILE,
  BILLING_ACCESS_RESTRICTION_REASON,
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_ENTITLEMENT_SOURCE,
  BILLING_HARD_PAUSE_OWNER,
  BILLING_SYNC_STATE,
  BILLING_TRIAL_LIFECYCLE_STATE,
  BILLING_TRIAL_METADATA_KEYS,
  BILLING_TRIAL_STATE,
} from "../billingConstants.js";
import {
  diffBillingCivilDays,
  formatBillingCivilDateInSaoPaulo,
} from "./billingCycleService.js";
import { readSellerTrialState, resolveTrialTemporalState } from "./billingSellerTrialService.js";
import { resolveCanonicalAccessPrecedence } from "./billingAccessPrecedenceService.js";
import { resolveTrialDurationDays } from "./billingTrialConfigService.js";
import {
  exclusiveInstantFromEndCivil,
  normalizeTrialEndsAtExclusive,
} from "./billingTrialEndsAtNormalizationService.js";

/** @deprecated use exclusiveInstantFromEndCivil / normalizeTrialEndsAtExclusive */
export function resolveTrialEndsAtExclusive(trialEndCivilInclusive) {
  return exclusiveInstantFromEndCivil(trialEndCivilInclusive);
}

export const BILLING_TRIAL_ACCESS_OWNER = Object.freeze({
  TRIAL_LIFECYCLE_ENGINE: "TRIAL_LIFECYCLE_ENGINE",
});

export const BILLING_TRIAL_ALERT_KIND = Object.freeze({
  D3: "D3",
  D2: "D2",
  D1: "D1",
  EXPIRED: "EXPIRED",
});

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * SSOT: 15 dias civis inclusivos (ativação 22/07 → fim 05/08).
 * Documentado em computeTrialEndDateInclusive — não é 15×24h.
 */
export function resolveTrialCivilDurationDays() {
  return resolveTrialDurationDays();
}

/**
 * @param {string} userId
 * @param {string} trialEndsAtIsoOrCivil
 * @param {string} kind
 */
export function buildTrialAlertIdempotencyKey(userId, trialEndsAtIsoOrCivil, kind) {
  const anchor = String(trialEndsAtIsoOrCivil ?? "").trim().slice(0, 10);
  return `trial:${userId}:${anchor}:${kind}`;
}

/**
 * Resolver puro do ciclo de vida do trial.
 *
 * @param {{
 *   metadata?: Record<string, unknown> | null;
 *   now?: Date;
 *   paid_confirmed?: boolean;
 *   canonical_subscription_active?: boolean;
 *   admin_override_active?: boolean;
 * }} input
 */
export function resolveTrialLifecycleState(input) {
  const now = input.now instanceof Date ? input.now : new Date();
  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const meta = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const trial = readSellerTrialState(meta);
  const precedence = resolveCanonicalAccessPrecedence(meta);

  const startCivil = trial.trial_start_date;
  const clock = normalizeTrialEndsAtExclusive({
    trial_end_date: trial.trial_end_date,
    trial_extended_end_date: trial.trial_extended_end_date,
    trial_ends_at: trial.trial_ends_at,
    trial_start_date: trial.trial_start_date,
    trial_started_at: trial.trial_started_at,
  });
  // Domínio consome APENAS trial_ends_at_exclusive — legado nunca entra como SSOT.
  const endCivil = clock.ok ? clock.trial_end_date : null;
  const endsAtExclusive = clock.ok ? clock.trial_ends_at_exclusive : null;
  const endsAtExclusiveIso = clock.ok ? clock.trial_ends_at_exclusive_iso : null;
  const daysRemaining =
    civilNow && endCivil ? diffBillingCivilDays(civilNow, endCivil) : null;

  if (!clock.ok && trial.trial_state !== BILLING_TRIAL_STATE.NOT_STARTED) {
    return {
      lifecycle_state: null,
      trial_state_compat: trial.trial_state,
      trial_days_remaining: null,
      trial_end_date: null,
      trial_ends_at: null,
      trial_ends_at_exclusive: null,
      warning_key: null,
      alert_kind: null,
      allow_trial_alerts: false,
      access_profile: null,
      access_reason: null,
      access_owner: null,
      sync_state: null,
      civil_now: civilNow,
      timezone: "America/Sao_Paulo",
      clock_error: clock.error,
      fail_closed: true,
    };
  }

  const paidActive =
    Boolean(input.paid_confirmed) ||
    Boolean(input.canonical_subscription_active) ||
    trial.trial_state === BILLING_TRIAL_STATE.CONVERTED ||
    String(meta.effective_entitlement ?? "") === BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN;

  // Pagamento confirmado / assinatura canônica ativa sempre vence o ciclo de trial.
  if (paidActive) {
    return {
      lifecycle_state: BILLING_TRIAL_LIFECYCLE_STATE.PAID_ACTIVE,
      trial_state_compat: BILLING_TRIAL_STATE.CONVERTED,
      trial_days_remaining: null,
      trial_end_date: endCivil,
      trial_ends_at: endsAtExclusiveIso,
      trial_ends_at_exclusive: endsAtExclusiveIso,
      warning_key: null,
      alert_kind: null,
      allow_trial_alerts: false,
      access_profile: BILLING_ACCESS_PROFILE.FULL_ACCESS,
      access_reason: null,
      access_owner: null,
      sync_state: BILLING_SYNC_STATE.FULL,
      effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN,
      civil_now: civilNow,
      timezone: "America/Sao_Paulo",
      precedence_rank: precedence.precedence_rank,
    };
  }

  // Precedência superior (segurança → recovery → admin): não emitir alertas de trial.
  // Baby quota (rank 4) não compete com trial ativo ilimitado.
  if (precedence.precedence_rank <= 3) {
    return {
      lifecycle_state: null,
      trial_state_compat: trial.trial_state,
      trial_days_remaining: daysRemaining,
      trial_end_date: endCivil,
      trial_ends_at: endsAtExclusiveIso,
      trial_ends_at_exclusive: endsAtExclusiveIso,
      warning_key: null,
      alert_kind: null,
      allow_trial_alerts: false,
      access_profile: precedence.access_profile,
      access_reason: precedence.reason,
      access_owner: null,
      sync_state: String(meta.sync_state ?? BILLING_SYNC_STATE.FULL),
      effective_entitlement: String(meta.effective_entitlement ?? ""),
      civil_now: civilNow,
      timezone: "America/Sao_Paulo",
      precedence_rank: precedence.precedence_rank,
      blocked_by_precedence: true,
    };
  }

  const temporal = resolveTrialTemporalState(trial, civilNow);
  if (
    temporal === BILLING_TRIAL_STATE.NOT_STARTED ||
    temporal === BILLING_TRIAL_STATE.REVOKED ||
    !startCivil ||
    !endCivil ||
    !civilNow
  ) {
    return {
      lifecycle_state: null,
      trial_state_compat: temporal,
      trial_days_remaining: null,
      trial_end_date: endCivil,
      trial_ends_at: endsAtExclusiveIso,
      warning_key: null,
      alert_kind: null,
      allow_trial_alerts: false,
      access_profile: null,
      access_reason: null,
      access_owner: null,
      sync_state: null,
      civil_now: civilNow,
      timezone: "America/Sao_Paulo",
    };
  }

  const expiredByCivil = civilNow > endCivil;
  const expiredByInstant =
    endsAtExclusive instanceof Date ? now.getTime() >= endsAtExclusive.getTime() : expiredByCivil;

  if (expiredByCivil || expiredByInstant || temporal === BILLING_TRIAL_STATE.EXPIRED) {
    return {
      lifecycle_state: BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED,
      trial_state_compat: BILLING_TRIAL_STATE.EXPIRED,
      trial_days_remaining: 0,
      trial_end_date: endCivil,
      trial_ends_at: endsAtExclusiveIso,
      trial_ends_at_exclusive: endsAtExclusiveIso,
      warning_key: "TRIAL_EXPIRED",
      alert_kind: BILLING_TRIAL_ALERT_KIND.EXPIRED,
      allow_trial_alerts: true,
      access_profile: BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY,
      access_reason: BILLING_ACCESS_RESTRICTION_REASON.TRIAL_EXPIRED,
      access_owner: BILLING_TRIAL_ACCESS_OWNER.TRIAL_LIFECYCLE_ENGINE,
      sync_state: BILLING_SYNC_STATE.FULL,
      effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED,
      civil_now: civilNow,
      timezone: "America/Sao_Paulo",
      duration_days: resolveTrialCivilDurationDays(),
    };
  }

  let lifecycle = BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ACTIVE;
  /** @type {string | null} */
  let warningKey = null;
  /** @type {string | null} */
  let alertKind = null;
  let trialCompat = BILLING_TRIAL_STATE.ACTIVE;

  if (daysRemaining === 3) {
    lifecycle = BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D3;
    warningKey = "TRIAL_ENDING_D3";
    alertKind = BILLING_TRIAL_ALERT_KIND.D3;
    trialCompat = BILLING_TRIAL_STATE.ENDING_SOON;
  } else if (daysRemaining === 2) {
    lifecycle = BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D2;
    warningKey = "TRIAL_ENDING_D2";
    alertKind = BILLING_TRIAL_ALERT_KIND.D2;
    trialCompat = BILLING_TRIAL_STATE.ENDING_SOON;
  } else if (daysRemaining === 1) {
    lifecycle = BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D1;
    warningKey = "TRIAL_ENDING_D1";
    alertKind = BILLING_TRIAL_ALERT_KIND.D1;
    trialCompat = BILLING_TRIAL_STATE.ENDING_SOON;
  } else if (daysRemaining === 0) {
    // Último dia civil inclusivo — ainda trial; alerta D1 já deve ter sido emitido.
    lifecycle = BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_ENDING_D1;
    warningKey = "TRIAL_ENDING_D1";
    alertKind = null;
    trialCompat = BILLING_TRIAL_STATE.ENDS_TODAY;
  } else if (daysRemaining != null && daysRemaining > 3 && daysRemaining <= 5) {
    trialCompat = BILLING_TRIAL_STATE.ENDING_SOON;
  }

  return {
    lifecycle_state: lifecycle,
    trial_state_compat: trialCompat,
    trial_days_remaining: daysRemaining,
    trial_start_date: startCivil,
    trial_end_date: endCivil,
    trial_ends_at: endsAtExclusiveIso,
    trial_ends_at_exclusive: endsAtExclusiveIso,
    warning_key: warningKey,
    alert_kind: alertKind,
    allow_trial_alerts: Boolean(alertKind),
    access_profile: BILLING_ACCESS_PROFILE.FULL_ACCESS,
    access_reason: null,
    access_owner: null,
    sync_state: BILLING_SYNC_STATE.FULL,
    effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_FULL_ACCESS,
    civil_now: civilNow,
    timezone: "America/Sao_Paulo",
    duration_days: resolveTrialCivilDurationDays(),
  };
}

/**
 * Patch metadata para restrição pós-trial (sem Baby).
 *
 * @param {Record<string, unknown>} metadata
 * @param {Date} now
 */
export function buildTrialExpiredRestrictionPatch(metadata, now = new Date()) {
  const iso = now.toISOString();
  return {
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_STATE]: BILLING_TRIAL_STATE.EXPIRED,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_CONSUMED]: true,
    trial_expired_at: iso,
    effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED,
    effective_entitlement_source: BILLING_ENTITLEMENT_SOURCE.TRIAL_LIFECYCLE_EXPIRATION,
    // NÃO ativar Baby
    suspension_fallback_active: false,
    access_profile: BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY,
    access_restriction_reason: BILLING_ACCESS_RESTRICTION_REASON.TRIAL_EXPIRED,
    access_owner: BILLING_TRIAL_ACCESS_OWNER.TRIAL_LIFECYCLE_ENGINE,
    sync_state: BILLING_SYNC_STATE.FULL,
    // Não iniciar franquia Baby
    [BILLING_TRIAL_METADATA_KEYS.QUOTA_COUNTING_STARTED_AT]:
      asTrimmedString(metadata?.[BILLING_TRIAL_METADATA_KEYS.QUOTA_COUNTING_STARTED_AT]) ?? null,
  };
}

/**
 * Remove somente bloqueio do TRIAL_LIFECYCLE_ENGINE.
 *
 * @param {Record<string, unknown>} metadata
 */
export function clearTrialLifecycleRestrictionFromMetadata(metadata) {
  const meta = { ...(metadata && typeof metadata === "object" ? metadata : {}) };
  if (String(meta.access_owner ?? "") !== BILLING_TRIAL_ACCESS_OWNER.TRIAL_LIFECYCLE_ENGINE) {
    return { metadata: meta, cleared: false };
  }
  if (String(meta.access_restriction_reason ?? "") !== BILLING_ACCESS_RESTRICTION_REASON.TRIAL_EXPIRED) {
    return { metadata: meta, cleared: false };
  }
  delete meta.access_owner;
  delete meta.access_restriction_reason;
  if (String(meta.access_profile ?? "") === BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY) {
    meta.access_profile = BILLING_ACCESS_PROFILE.FULL_ACCESS;
  }
  // Nunca tocar hard_pause_owner Baby / security / recovery
  if (String(meta.hard_pause_owner ?? "") === BILLING_HARD_PAUSE_OWNER.BABY_QUOTA_ENGINE) {
    /* preserve */
  }
  return { metadata: meta, cleared: true };
}

/**
 * Cópias canônicas UX (backend SSOT — frontend só apresenta).
 *
 * @param {string | null | undefined} warningKey
 */
export function resolveTrialLifecyclePresentation(warningKey) {
  const key = String(warningKey ?? "");
  const map = {
    TRIAL_ENDING_D3: {
      title: "Seu teste gratuito termina em 3 dias",
      message: "Escolha um plano para continuar usando todos os recursos da SUSE7 sem interrupções.",
      ctaLabel: "Ver planos",
      ctaPath: "/perfil/assinatura",
    },
    TRIAL_ENDING_D2: {
      title: "Faltam 2 dias para o fim do seu teste",
      message: "Seus dados continuarão salvos. Contrate um plano para manter o acesso completo.",
      ctaLabel: "Ver planos",
      ctaPath: "/perfil/assinatura",
    },
    TRIAL_ENDING_D1: {
      title: "Seu teste gratuito termina amanhã",
      message: "Contrate um plano para continuar com acesso completo à SUSE7.",
      ctaLabel: "Escolher plano",
      ctaPath: "/perfil/assinatura",
    },
    TRIAL_EXPIRED: {
      title: "Seu período de teste terminou",
      message:
        "Seus dados e seu histórico continuam salvos. Escolha um plano para recuperar o acesso completo.",
      ctaLabel: "Escolher plano",
      ctaPath: "/perfil/assinatura",
    },
  };
  return map[key] ?? null;
}
