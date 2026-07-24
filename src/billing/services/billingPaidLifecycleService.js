// ======================================================================
// Máquina de estados financeira paga — resolver puro (S1.HF.6.9A.12)
// ======================================================================

import {
  BILLING_ACCESS_PROFILE,
  BILLING_ACCESS_RESTRICTION_REASON,
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_ENTITLEMENT_SOURCE,
  BILLING_PAID_LIFECYCLE_STATE,
  BILLING_PAYMENT_DELINQUENCY_OWNER,
  BILLING_SYNC_STATE,
  DELINQUENCY_STATUS,
  RENEWAL_STATUS,
  SUBSCRIPTION_STATUS,
} from "../billingConstants.js";
import {
  readScheduledRenewalCompetence,
  resolvePaidCivilCycleClock,
} from "./billingPaidCivilCycleService.js";
import { resolveCanonicalAccessPrecedence } from "./billingAccessPrecedenceService.js";
import { readSuspensionFallbackEntitlement } from "./billingSuspensionFallbackEntitlementService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} openCycle
 */
function cycleIsPendingPayment(openCycle) {
  const s = String(openCycle?.renewal_status ?? "");
  return (
    s === RENEWAL_STATUS.PENDING_PAYMENT ||
    s === RENEWAL_STATUS.AUTO_CHARGE_PROCESSING ||
    s === RENEWAL_STATUS.PAYMENT_FAILED ||
    s === RENEWAL_STATUS.PRE_RENEWAL
  );
}

/**
 * Resolver puro do ciclo pago.
 *
 * @param {{
 *   subscription?: Record<string, unknown> | null;
 *   openCycle?: Record<string, unknown> | null;
 *   now?: Date;
 *   payment_confirmed_for_competence?: boolean;
 *   payment_pending?: boolean;
 *   reactivation_checkout_open?: boolean;
 *   usage_restricted?: boolean;
 * }} input
 */
export function resolvePaidLifecycleState(input) {
  const now = input.now instanceof Date ? input.now : new Date();
  const subscription = input.subscription && typeof input.subscription === "object" ? input.subscription : null;
  if (!subscription?.id) {
    return {
      lifecycle_state: null,
      error: "missing_canonical_subscription",
      fail_closed: true,
    };
  }

  const meta =
    subscription.metadata && typeof subscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (subscription.metadata)
      : {};
  const clock = resolvePaidCivilCycleClock(subscription, now);
  const scheduled = readScheduledRenewalCompetence(meta);
  const fallback = readSuspensionFallbackEntitlement(meta);
  const delinquency = String(meta.delinquency_status ?? DELINQUENCY_STATUS.NONE).toLowerCase();
  const status = String(subscription.status ?? "").toLowerCase();
  const precedence = resolveCanonicalAccessPrecedence(meta);
  const usageRestricted = Boolean(input.usage_restricted);

  const presentationFor = (state) => resolvePaidLifecyclePresentation(state);

  // Baby fallback ativo (suspensão financeira)
  if (fallback.active || delinquency === DELINQUENCY_STATUS.SUSPENDED || status === SUBSCRIPTION_STATUS.PAST_DUE) {
    if (input.reactivation_checkout_open && !input.payment_confirmed_for_competence) {
      return {
        lifecycle_state: BILLING_PAID_LIFECYCLE_STATE.REACTIVATION_PENDING,
        subscription_status: status,
        paid_subscription_status: "SUSPENDED",
        entitlement: BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE,
        entitlement_source: BILLING_ENTITLEMENT_SOURCE.BABY_FALLBACK,
        access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
        access_reason: BILLING_ACCESS_RESTRICTION_REASON.PAYMENT_DELINQUENCY,
        access_owner: BILLING_PAYMENT_DELINQUENCY_OWNER.PAYMENT_DELINQUENCY_ENGINE,
        sync_state: BILLING_SYNC_STATE.FULL,
        clock,
        presentation: presentationFor(BILLING_PAID_LIFECYCLE_STATE.REACTIVATION_PENDING),
        precedence_rank: precedence.precedence_rank,
        usage_restricted_preserved: usageRestricted,
      };
    }

    if (input.payment_confirmed_for_competence) {
      return {
        lifecycle_state: BILLING_PAID_LIFECYCLE_STATE.PAID_REACTIVATED,
        subscription_status: SUBSCRIPTION_STATUS.ACTIVE,
        paid_subscription_status: "ACTIVE",
        entitlement: BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN,
        entitlement_source: BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE,
        access_profile: usageRestricted
          ? BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY
          : BILLING_ACCESS_PROFILE.FULL_ACCESS,
        access_reason: usageRestricted ? null : null,
        access_owner: null,
        clear_owner: BILLING_PAYMENT_DELINQUENCY_OWNER.PAYMENT_DELINQUENCY_ENGINE,
        sync_state: BILLING_SYNC_STATE.FULL,
        clock,
        presentation: presentationFor(BILLING_PAID_LIFECYCLE_STATE.PAID_REACTIVATED),
        precedence_rank: precedence.precedence_rank,
        usage_restricted_preserved: usageRestricted,
      };
    }

    return {
      lifecycle_state: BILLING_PAID_LIFECYCLE_STATE.BABY_FALLBACK_ACTIVE,
      subscription_status: SUBSCRIPTION_STATUS.PAST_DUE,
      paid_subscription_status: "SUSPENDED",
      entitlement: BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE,
      entitlement_source: BILLING_ENTITLEMENT_SOURCE.BABY_FALLBACK,
      access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
      access_reason: BILLING_ACCESS_RESTRICTION_REASON.PAYMENT_DELINQUENCY,
      access_owner: BILLING_PAYMENT_DELINQUENCY_OWNER.PAYMENT_DELINQUENCY_ENGINE,
      sync_state: BILLING_SYNC_STATE.FULL,
      baby_usage_limit: 60,
      baby_grace_days: 0,
      clock,
      presentation: presentationFor(BILLING_PAID_LIFECYCLE_STATE.BABY_FALLBACK_ACTIVE),
      precedence_rank: precedence.precedence_rank,
      usage_restricted_preserved: usageRestricted,
    };
  }

  // Pagamento antecipado agendado (período atual preservado)
  if (scheduled && !scheduled.activated) {
    return {
      lifecycle_state: BILLING_PAID_LIFECYCLE_STATE.RENEWAL_PAID_SCHEDULED,
      subscription_status: SUBSCRIPTION_STATUS.ACTIVE,
      paid_subscription_status: "ACTIVE",
      entitlement: BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN,
      entitlement_source: BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE,
      access_profile: usageRestricted
        ? BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY
        : BILLING_ACCESS_PROFILE.FULL_ACCESS,
      access_reason: null,
      access_owner: null,
      sync_state: BILLING_SYNC_STATE.FULL,
      clock,
      scheduled_renewal: scheduled,
      presentation: presentationFor(BILLING_PAID_LIFECYCLE_STATE.RENEWAL_PAID_SCHEDULED),
      period_advance_blocked: true,
      usage_restricted_preserved: usageRestricted,
    };
  }

  const financial = String(clock.billing_financial_state ?? "");
  const pending = Boolean(input.payment_pending) || cycleIsPendingPayment(input.openCycle);

  if (financial === "SUSPENDED") {
    return {
      lifecycle_state: BILLING_PAID_LIFECYCLE_STATE.PAID_SUSPENDED,
      subscription_status: SUBSCRIPTION_STATUS.PAST_DUE,
      paid_subscription_status: "SUSPENDED",
      entitlement: BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE,
      entitlement_source: BILLING_ENTITLEMENT_SOURCE.BABY_FALLBACK,
      access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
      access_reason: BILLING_ACCESS_RESTRICTION_REASON.PAYMENT_DELINQUENCY,
      access_owner: BILLING_PAYMENT_DELINQUENCY_OWNER.PAYMENT_DELINQUENCY_ENGINE,
      sync_state: BILLING_SYNC_STATE.FULL,
      clock,
      presentation: presentationFor(BILLING_PAID_LIFECYCLE_STATE.PAID_SUSPENDED),
      usage_restricted_preserved: usageRestricted,
    };
  }

  if (financial === "GRACE_PERIOD" || delinquency === DELINQUENCY_STATUS.GRACE) {
    return {
      lifecycle_state: BILLING_PAID_LIFECYCLE_STATE.FINANCIAL_GRACE,
      subscription_status: SUBSCRIPTION_STATUS.ACTIVE,
      paid_subscription_status: "ACTIVE",
      entitlement: BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN,
      entitlement_source: BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE,
      access_profile: usageRestricted
        ? BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY
        : BILLING_ACCESS_PROFILE.FULL_ACCESS,
      access_reason: usageRestricted ? null : null,
      access_owner: null,
      sync_state: BILLING_SYNC_STATE.FULL,
      clock,
      presentation: presentationFor(BILLING_PAID_LIFECYCLE_STATE.FINANCIAL_GRACE),
      // Carência NÃO promove FULL_ACCESS se consumo restringiu.
      usage_restricted_preserved: usageRestricted,
      baby_migration: false,
    };
  }

  if (financial === "DUE_TODAY") {
    return {
      lifecycle_state: BILLING_PAID_LIFECYCLE_STATE.PAYMENT_DUE,
      subscription_status: SUBSCRIPTION_STATUS.ACTIVE,
      paid_subscription_status: "ACTIVE",
      entitlement: BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN,
      entitlement_source: BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE,
      access_profile: usageRestricted
        ? BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY
        : BILLING_ACCESS_PROFILE.FULL_ACCESS,
      access_reason: null,
      access_owner: null,
      sync_state: BILLING_SYNC_STATE.FULL,
      clock,
      presentation: presentationFor(BILLING_PAID_LIFECYCLE_STATE.PAYMENT_DUE),
      usage_restricted_preserved: usageRestricted,
    };
  }

  if (pending) {
    return {
      lifecycle_state: BILLING_PAID_LIFECYCLE_STATE.PAYMENT_PENDING,
      subscription_status: SUBSCRIPTION_STATUS.ACTIVE,
      paid_subscription_status: "ACTIVE",
      entitlement: BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN,
      entitlement_source: BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE,
      access_profile: usageRestricted
        ? BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY
        : BILLING_ACCESS_PROFILE.FULL_ACCESS,
      access_reason: null,
      access_owner: null,
      sync_state: BILLING_SYNC_STATE.FULL,
      clock,
      presentation: presentationFor(BILLING_PAID_LIFECYCLE_STATE.PAYMENT_PENDING),
      payment_does_not_unlock_until_confirmed: true,
      usage_restricted_preserved: usageRestricted,
    };
  }

  if (clock.pre_renewal_window) {
    return {
      lifecycle_state: BILLING_PAID_LIFECYCLE_STATE.RENEWAL_AVAILABLE,
      subscription_status: SUBSCRIPTION_STATUS.ACTIVE,
      paid_subscription_status: "ACTIVE",
      entitlement: BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN,
      entitlement_source: BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE,
      access_profile: usageRestricted
        ? BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY
        : BILLING_ACCESS_PROFILE.FULL_ACCESS,
      access_reason: null,
      access_owner: null,
      sync_state: BILLING_SYNC_STATE.FULL,
      clock,
      presentation: presentationFor(BILLING_PAID_LIFECYCLE_STATE.RENEWAL_AVAILABLE),
      usage_restricted_preserved: usageRestricted,
    };
  }

  return {
    lifecycle_state: BILLING_PAID_LIFECYCLE_STATE.PAID_ACTIVE,
    subscription_status: SUBSCRIPTION_STATUS.ACTIVE,
    paid_subscription_status: "ACTIVE",
    entitlement: BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN,
    entitlement_source: BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE,
    access_profile: usageRestricted
      ? BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY
      : BILLING_ACCESS_PROFILE.FULL_ACCESS,
    access_reason: null,
    access_owner: null,
    sync_state: BILLING_SYNC_STATE.FULL,
    clock,
    presentation: presentationFor(BILLING_PAID_LIFECYCLE_STATE.PAID_ACTIVE),
    usage_restricted_preserved: usageRestricted,
  };
}

/**
 * @param {string | null | undefined} state
 */
export function resolvePaidLifecyclePresentation(state) {
  const map = {
    [BILLING_PAID_LIFECYCLE_STATE.RENEWAL_AVAILABLE]: {
      title: "Renovação disponível",
      message: "Sua próxima mensalidade já pode ser paga. O período atual continua válido.",
      ctaLabel: "Pagar mensalidade",
      ctaPath: "/perfil/assinatura",
    },
    [BILLING_PAID_LIFECYCLE_STATE.PAYMENT_PENDING]: {
      title: "Pagamento pendente",
      message: "Estamos aguardando a confirmação oficial do pagamento. Cobrança criada ainda não libera o ciclo.",
      ctaLabel: "Ver pagamento",
      ctaPath: "/perfil/assinatura",
    },
    [BILLING_PAID_LIFECYCLE_STATE.RENEWAL_PAID_SCHEDULED]: {
      title: "Próxima mensalidade paga",
      message: "Pagamento confirmado. O novo período só entra na virada civil.",
      ctaLabel: "Ver assinatura",
      ctaPath: "/perfil/assinatura",
    },
    [BILLING_PAID_LIFECYCLE_STATE.PAYMENT_DUE]: {
      title: "Mensalidade vence hoje",
      message: "Pague hoje para manter sua assinatura em dia.",
      ctaLabel: "Pagar agora",
      ctaPath: "/perfil/assinatura",
    },
    [BILLING_PAID_LIFECYCLE_STATE.FINANCIAL_GRACE]: {
      title: "Período de tolerância",
      message: "Sua assinatura segue ativa por até 10 dias civis. Regularize o pagamento para evitar suspensão.",
      ctaLabel: "Regularizar pagamento",
      ctaPath: "/perfil/assinatura",
    },
    [BILLING_PAID_LIFECYCLE_STATE.PAID_SUSPENDED]: {
      title: "Assinatura suspensa",
      message:
        "Sua assinatura foi suspensa e a SUSE7 migrou sua conta para o Baby gratuito.",
      ctaLabel: "Reativar assinatura",
      ctaPath: "/perfil/assinatura",
    },
    [BILLING_PAID_LIFECYCLE_STATE.BABY_FALLBACK_ACTIVE]: {
      title: "Assinatura suspensa",
      message:
        "Sua assinatura foi suspensa e a SUSE7 migrou sua conta para o Baby gratuito.",
      ctaLabel: "Reativar assinatura",
      ctaPath: "/perfil/assinatura",
    },
    [BILLING_PAID_LIFECYCLE_STATE.REACTIVATION_PENDING]: {
      title: "Reativação em andamento",
      message: "Conclua o pagamento para reativar sua assinatura paga.",
      ctaLabel: "Concluir pagamento",
      ctaPath: "/perfil/assinatura",
    },
    [BILLING_PAID_LIFECYCLE_STATE.PAID_REACTIVATED]: {
      title: "Assinatura reativada",
      message: "Pagamento confirmado. Sua assinatura paga foi reativada.",
      ctaLabel: "Ver assinatura",
      ctaPath: "/perfil/assinatura",
    },
    [BILLING_PAID_LIFECYCLE_STATE.PAID_ACTIVE]: {
      title: "Assinatura ativa",
      message: "Sua assinatura está em dia.",
      ctaLabel: "Ver assinatura",
      ctaPath: "/perfil/assinatura",
    },
  };
  return map[String(state ?? "")] ?? null;
}

/** Eventos IN_APP do ciclo pago (S1.HF.6.9A.12) — categoria BILLING. */
export const BILLING_PAID_ALERT_KIND = Object.freeze({
  RENEWAL_AVAILABLE: "RENEWAL_AVAILABLE",
  PAYMENT_PENDING: "PAYMENT_PENDING",
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  PAYMENT_DUE: "PAYMENT_DUE",
  ENTERED_GRACE: "ENTERED_GRACE",
  GRACE_LAST_DAY: "GRACE_LAST_DAY",
  SUSPENDED: "SUSPENDED",
  BABY_FALLBACK_ACTIVATED: "BABY_FALLBACK_ACTIVATED",
  REACTIVATED: "REACTIVATED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
});

/**
 * Idempotency: user + canonical_subscription + competence + event_type
 *
 * @param {string} userId
 * @param {string} canonicalSubscriptionId
 * @param {string} competenceKey
 * @param {string} eventType
 */
export function buildPaidLifecycleAlertIdempotencyKey(
  userId,
  canonicalSubscriptionId,
  competenceKey,
  eventType,
) {
  return `paid:${String(userId)}:${String(canonicalSubscriptionId)}:${String(competenceKey)}:${String(eventType)}`;
}

/**
 * @param {string | null | undefined} lifecycleState
 * @param {{ days_past_due?: number | null; financial_grace_days?: number }} [clock]
 */
export function resolvePaidAlertKindForLifecycle(lifecycleState, clock = {}) {
  const state = String(lifecycleState ?? "");
  if (state === BILLING_PAID_LIFECYCLE_STATE.RENEWAL_AVAILABLE) {
    return BILLING_PAID_ALERT_KIND.RENEWAL_AVAILABLE;
  }
  if (state === BILLING_PAID_LIFECYCLE_STATE.PAYMENT_PENDING) {
    return BILLING_PAID_ALERT_KIND.PAYMENT_PENDING;
  }
  if (state === BILLING_PAID_LIFECYCLE_STATE.RENEWAL_PAID_SCHEDULED) {
    return BILLING_PAID_ALERT_KIND.PAYMENT_CONFIRMED;
  }
  if (state === BILLING_PAID_LIFECYCLE_STATE.PAYMENT_DUE) {
    return BILLING_PAID_ALERT_KIND.PAYMENT_DUE;
  }
  if (state === BILLING_PAID_LIFECYCLE_STATE.FINANCIAL_GRACE) {
    const daysPast = Number(clock.days_past_due);
    const graceDays = Number(clock.financial_grace_days ?? 10);
    if (Number.isFinite(daysPast) && daysPast === graceDays) {
      return BILLING_PAID_ALERT_KIND.GRACE_LAST_DAY;
    }
    return BILLING_PAID_ALERT_KIND.ENTERED_GRACE;
  }
  if (
    state === BILLING_PAID_LIFECYCLE_STATE.PAID_SUSPENDED ||
    state === BILLING_PAID_LIFECYCLE_STATE.BABY_FALLBACK_ACTIVE
  ) {
    return BILLING_PAID_ALERT_KIND.SUSPENDED;
  }
  if (state === BILLING_PAID_LIFECYCLE_STATE.PAID_REACTIVATED) {
    return BILLING_PAID_ALERT_KIND.REACTIVATED;
  }
  return null;
}

/**
 * Patch metadata na suspensão — preserva contrato pago; marca owner financeiro.
 *
 * @param {Record<string, unknown>} metadata
 * @param {Date} [now]
 */
export function buildPaymentDelinquencySuspensionPatch(metadata, now = new Date()) {
  return {
    delinquency_status: DELINQUENCY_STATUS.SUSPENDED,
    access_suspended_at: now.toISOString(),
    paid_subscription_status: "SUSPENDED",
    access_restriction_reason: BILLING_ACCESS_RESTRICTION_REASON.PAYMENT_DELINQUENCY,
    access_owner: BILLING_PAYMENT_DELINQUENCY_OWNER.PAYMENT_DELINQUENCY_ENGINE,
    sync_state: BILLING_SYNC_STATE.FULL,
    // Não sobrescrever plan_id / preço / anchor — ficam no registro da assinatura.
    contracted_plan_key_preserved: asTrimmedString(metadata.contracted_plan_key) ?? true,
  };
}

/**
 * Remove somente PAYMENT_DELINQUENCY_ENGINE.
 *
 * @param {Record<string, unknown>} metadata
 */
export function clearPaymentDelinquencyOwnerFromMetadata(metadata) {
  const meta = { ...(metadata && typeof metadata === "object" ? metadata : {}) };
  if (String(meta.access_owner ?? "") !== BILLING_PAYMENT_DELINQUENCY_OWNER.PAYMENT_DELINQUENCY_ENGINE) {
    return { metadata: meta, cleared: false };
  }
  delete meta.access_owner;
  if (String(meta.access_restriction_reason ?? "") === BILLING_ACCESS_RESTRICTION_REASON.PAYMENT_DELINQUENCY) {
    delete meta.access_restriction_reason;
  }
  meta.delinquency_status = DELINQUENCY_STATUS.NONE;
  delete meta.access_suspended_at;
  meta.paid_subscription_status = "ACTIVE";
  // Nunca tocar trial / baby quota hard pause
  return { metadata: meta, cleared: true };
}
