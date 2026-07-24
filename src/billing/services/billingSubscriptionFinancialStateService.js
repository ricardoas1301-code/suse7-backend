// ======================================================================
// Estado financeiro canônico — tolerância, suspensão e acesso (S1.HF.6.5)
// ======================================================================

import {
  BILLING_ACCESS_STATE,
  BILLING_FINANCIAL_STATE,
  BILLING_PAYMENT_CONTEXT,
  BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT,
  BILLING_SUBSCRIPTION_LIFECYCLE_STATUS,
  DELINQUENCY_STATUS,
  RENEWAL_EXPERIENCE_ACTION,
  RENEWAL_EXPERIENCE_STATE,
  RENEWAL_STATUS,
  SUBSCRIPTION_STATUS,
} from "../billingConstants.js";
import {
  addBillingCivilDays,
  diffBillingCivilDays,
  formatBillingCivilDateInSaoPaulo,
  parseBillingCivilDate,
} from "./billingCycleService.js";

/** Retenção de dados durante suspensão (dias) — regra de domínio, sem expurgo nesta missão. */
export const BILLING_SUSPENSION_DATA_RETENTION_DAYS = 90;

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function resolveRenewalGracePeriodDays() {
  const raw = Number(process.env.BILLING_RENEWAL_GRACE_PERIOD_DAYS ?? BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT;
}

/**
 * Regra civil D0 / D+1..D+10 / D+11 (DATE_ONLY, America/Sao_Paulo via civilNow).
 *
 * @param {string | null | undefined} dueDateCivil
 * @param {string | null | undefined} civilNow
 * @param {number} [graceDays]
 */
export function resolveBillingFinancialStateFromDueDate(dueDateCivil, civilNow, graceDays = resolveRenewalGracePeriodDays()) {
  const dueDate = parseBillingCivilDate(dueDateCivil);
  const nowCivil = parseBillingCivilDate(civilNow);

  if (!dueDate || !nowCivil) {
    return {
      billing_financial_state: BILLING_FINANCIAL_STATE.CURRENT,
      days_past_due: null,
      grace_period_start: null,
      grace_period_end: null,
      suspension_start: null,
    };
  }

  const daysPastDue = diffBillingCivilDays(dueDate, nowCivil);
  const graceStart = addBillingCivilDays(dueDate, 1);
  const graceEnd = addBillingCivilDays(dueDate, graceDays);
  const suspensionStart = addBillingCivilDays(dueDate, graceDays + 1);

  if (daysPastDue == null) {
    return {
      billing_financial_state: BILLING_FINANCIAL_STATE.CURRENT,
      days_past_due: null,
      grace_period_start: graceStart,
      grace_period_end: graceEnd,
      suspension_start: suspensionStart,
    };
  }

  if (daysPastDue < 0) {
    return {
      billing_financial_state: BILLING_FINANCIAL_STATE.CURRENT,
      days_past_due: daysPastDue,
      grace_period_start: graceStart,
      grace_period_end: graceEnd,
      suspension_start: suspensionStart,
    };
  }

  if (daysPastDue === 0) {
    return {
      billing_financial_state: BILLING_FINANCIAL_STATE.DUE_TODAY,
      days_past_due: 0,
      grace_period_start: graceStart,
      grace_period_end: graceEnd,
      suspension_start: suspensionStart,
    };
  }

  if (daysPastDue >= 1 && daysPastDue <= graceDays) {
    return {
      billing_financial_state: BILLING_FINANCIAL_STATE.GRACE_PERIOD,
      days_past_due: daysPastDue,
      grace_period_start: graceStart,
      grace_period_end: graceEnd,
      suspension_start: suspensionStart,
    };
  }

  return {
    billing_financial_state: BILLING_FINANCIAL_STATE.SUSPENDED,
    days_past_due: daysPastDue,
    grace_period_start: graceStart,
    grace_period_end: graceEnd,
    suspension_start: suspensionStart,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} subscription
 */
function resolveSubscriptionLifecycleStatus(subscription) {
  const status = String(subscription?.status ?? "").toLowerCase();
  if (status === SUBSCRIPTION_STATUS.CANCELED) return BILLING_SUBSCRIPTION_LIFECYCLE_STATUS.CANCELED;
  if (status === SUBSCRIPTION_STATUS.REFUNDED) return BILLING_SUBSCRIPTION_LIFECYCLE_STATUS.SUPERSEDED;
  return BILLING_SUBSCRIPTION_LIFECYCLE_STATUS.ACTIVE;
}

/**
 * @param {Record<string, unknown> | null | undefined} subscription
 */
function readDelinquencyStatus(subscription) {
  const meta =
    subscription?.metadata && typeof subscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (subscription.metadata)
      : {};
  return String(meta.delinquency_status ?? subscription?.delinquency_status ?? DELINQUENCY_STATUS.NONE).toLowerCase();
}

/**
 * @param {BILLING_FINANCIAL_STATE[keyof BILLING_FINANCIAL_STATE]} billingFinancialState
 */
function resolveAccessStateFromFinancialState(billingFinancialState) {
  if (billingFinancialState === BILLING_FINANCIAL_STATE.SUSPENDED) {
    return BILLING_ACCESS_STATE.BLOCKED;
  }
  if (billingFinancialState === BILLING_FINANCIAL_STATE.GRACE_PERIOD) {
    return BILLING_ACCESS_STATE.LIBERATED;
  }
  if (billingFinancialState === BILLING_FINANCIAL_STATE.DUE_TODAY) {
    return BILLING_ACCESS_STATE.LIBERATED;
  }
  return BILLING_ACCESS_STATE.LIBERATED;
}

/**
 * Resolver central — estados financeiros, acesso e contexto de checkout.
 *
 * @param {{
 *   subscription?: Record<string, unknown> | null;
 *   openCycle?: Record<string, unknown> | null;
 *   civilNow?: string | null;
 *   now?: Date;
 *   graceDays?: number;
 * }} ctx
 */
export function resolveBillingSubscriptionFinancialState(ctx = {}) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const civilNow = parseBillingCivilDate(ctx.civilNow) ?? formatBillingCivilDateInSaoPaulo(now);
  const graceDays = ctx.graceDays ?? resolveRenewalGracePeriodDays();

  const subscription = ctx.subscription ?? null;
  const openCycle = ctx.openCycle ?? null;

  const dueDate =
    parseBillingCivilDate(openCycle?.renewal_due_date) ??
    parseBillingCivilDate(subscription?.next_due_date ?? subscription?.next_billing_at);

  const timeline = resolveBillingFinancialStateFromDueDate(dueDate, civilNow, graceDays);
  let billingFinancialState = timeline.billing_financial_state;

  const delinquency = readDelinquencyStatus(subscription);
  const cycleStatus = String(openCycle?.renewal_status ?? "");

  if (cycleStatus === RENEWAL_STATUS.SUSPENDED || delinquency === DELINQUENCY_STATUS.SUSPENDED) {
    billingFinancialState = BILLING_FINANCIAL_STATE.SUSPENDED;
  } else if (
    (cycleStatus === RENEWAL_STATUS.GRACE_PERIOD || delinquency === DELINQUENCY_STATUS.GRACE) &&
    billingFinancialState !== BILLING_FINANCIAL_STATE.SUSPENDED
  ) {
    billingFinancialState = BILLING_FINANCIAL_STATE.GRACE_PERIOD;
  }

  const accessState = resolveAccessStateFromFinancialState(billingFinancialState);
  const subscriptionLifecycleStatus = resolveSubscriptionLifecycleStatus(subscription);

  /** @type {string | null} */
  let renewalState = null;
  /** @type {string | null} */
  let paymentContext = null;
  /** @type {{ action: string; label: string } | null} */
  let financialPrimaryAction = null;

  const hasOpenPayableCycle = Boolean(openCycle?.id);

  if (
    hasOpenPayableCycle &&
    (billingFinancialState === BILLING_FINANCIAL_STATE.GRACE_PERIOD ||
      billingFinancialState === BILLING_FINANCIAL_STATE.DUE_TODAY)
  ) {
    renewalState = RENEWAL_EXPERIENCE_STATE.RENEWAL_AWAITING_GENERATION;
    paymentContext = BILLING_PAYMENT_CONTEXT.MONTHLY_RENEWAL_GRACE;
    financialPrimaryAction = {
      action: RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION,
      label: "Renovar assinatura",
    };
  } else if (hasOpenPayableCycle && billingFinancialState === BILLING_FINANCIAL_STATE.SUSPENDED) {
    renewalState = RENEWAL_EXPERIENCE_STATE.REACTIVATION_AWAITING_GENERATION;
    paymentContext = BILLING_PAYMENT_CONTEXT.SUBSCRIPTION_REACTIVATION;
    financialPrimaryAction = {
      action: RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION,
      label: "Regularizar assinatura",
    };
  }

  return {
    subscription_lifecycle_status: subscriptionLifecycleStatus,
    billing_financial_state: billingFinancialState,
    access_state: accessState,
    renewal_state: renewalState,
    payment_context: paymentContext,
    financial_primary_action: financialPrimaryAction,
    due_date: dueDate,
    days_past_due: timeline.days_past_due,
    grace_period_start: timeline.grace_period_start,
    grace_period_end: timeline.grace_period_end,
    suspension_start: timeline.suspension_start,
    data_retention_days: BILLING_SUSPENSION_DATA_RETENTION_DAYS,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} raw
 */
export function normalizeBillingFinancialStateDto(raw) {
  if (!raw || typeof raw !== "object") return null;
  const primaryRaw = raw.financial_primary_action;
  return {
    subscription_lifecycle_status:
      raw.subscription_lifecycle_status != null ? String(raw.subscription_lifecycle_status) : null,
    billing_financial_state: raw.billing_financial_state != null ? String(raw.billing_financial_state) : null,
    access_state: raw.access_state != null ? String(raw.access_state) : null,
    renewal_state: raw.renewal_state != null ? String(raw.renewal_state) : null,
    payment_context: raw.payment_context != null ? String(raw.payment_context) : null,
    financial_primary_action:
      primaryRaw && typeof primaryRaw === "object"
        ? {
            action: primaryRaw.action != null ? String(primaryRaw.action) : null,
            label: primaryRaw.label != null ? String(primaryRaw.label) : null,
          }
        : null,
    due_date: raw.due_date != null ? String(raw.due_date).slice(0, 10) : null,
    days_past_due: raw.days_past_due != null ? Number(raw.days_past_due) : null,
    grace_period_start: asTrimmedString(raw.grace_period_start),
    grace_period_end: asTrimmedString(raw.grace_period_end),
    suspension_start: asTrimmedString(raw.suspension_start),
    data_retention_days: BILLING_SUSPENSION_DATA_RETENTION_DAYS,
  };
}

/**
 * Mescla estado financeiro canônico na experiência de renovação.
 *
 * @param {Record<string, unknown> | null | undefined} experience
 * @param {ReturnType<typeof resolveBillingSubscriptionFinancialState>} financialState
 */
export function applyFinancialStateToRenewalExperience(experience, financialState) {
  if (!experience || !financialState) return experience;

  const next = { ...experience, ...normalizeBillingFinancialStateDto(financialState) };

  if (financialState.renewal_state) {
    next.renewal_state = financialState.renewal_state;
  }

  if (financialState.financial_primary_action) {
    next.primary_action = financialState.financial_primary_action;
  }

  if (financialState.payment_context) {
    next.payment_context = financialState.payment_context;
  }

  return next;
}
