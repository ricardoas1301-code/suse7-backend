// ======================================================================
// Relógio civil do ciclo pago — America/Sao_Paulo (S1.HF.6.9A.12)
// Semiaberto [current_period_start, current_period_end_exclusive).
// Reutiliza âncora/mês do billingCycleService (sem regra concorrente).
// ======================================================================

import {
  BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT,
  BILLING_RENEWAL_PRE_RENEWAL_DAYS_DEFAULT,
} from "../billingConstants.js";
import {
  addBillingCivilDays,
  addUtcMonthsKeepingAnchorDay,
  diffBillingCivilDays,
  formatBillingCivilDateInSaoPaulo,
  formatUtcDateOnly,
  parseBillingCivilDate,
  resolveBillingCycleAnchor,
  startOfUtcDay,
} from "./billingCycleService.js";
import { civilDateStartInstantSaoPaulo } from "./billingCivilCycleWindowService.js";
import { resolveBillingFinancialStateFromDueDate } from "./billingSubscriptionFinancialStateService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function resolvePaidRenewalGraceDays() {
  const raw = Number(process.env.BILLING_RENEWAL_GRACE_PERIOD_DAYS ?? BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT;
}

/**
 * Chave estável de competência: subscription + período civil.
 *
 * @param {string} subscriptionId
 * @param {string} periodStartCivil
 * @param {string} periodEndExclusiveCivil
 */
export function buildCompetenceKey(subscriptionId, periodStartCivil, periodEndExclusiveCivil) {
  return `${String(subscriptionId)}:${String(periodStartCivil).slice(0, 10)}:${String(periodEndExclusiveCivil).slice(0, 10)}`;
}

/**
 * Âncora civil + períodos a partir da assinatura (política existente de âncora dia 28–31).
 *
 * @param {Record<string, unknown> | null | undefined} subscription
 * @param {Date} [now]
 */
export function resolvePaidCivilCycleClock(subscription, now = new Date()) {
  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const anchor = resolveBillingCycleAnchor(subscription, now);
  const anchorCivil = formatUtcDateOnly(anchor);
  const periodStartCivil =
    parseBillingCivilDate(subscription?.current_period_start) ??
    formatBillingCivilDateInSaoPaulo(subscription?.current_period_start) ??
    anchorCivil;

  const nextDueCivil =
    parseBillingCivilDate(subscription?.next_due_date) ??
    parseBillingCivilDate(subscription?.next_billing_at) ??
    null;

  // end_exclusive = início do próximo período (= due civil quando alinhado).
  let periodEndExclusiveCivil = nextDueCivil;
  if (!periodEndExclusiveCivil && periodStartCivil) {
    const startUtc = startOfUtcDay(periodStartCivil);
    if (startUtc) {
      const next = addUtcMonthsKeepingAnchorDay(startUtc, 1, anchor.getUTCDate());
      periodEndExclusiveCivil = formatUtcDateOnly(next);
    }
  }

  const periodEndInclusiveCivil =
    periodEndExclusiveCivil != null ? addBillingCivilDays(periodEndExclusiveCivil, -1) : null;

  const renewalDueCivil = nextDueCivil ?? periodEndExclusiveCivil;
  const graceDays = resolvePaidRenewalGraceDays();
  const timeline = resolveBillingFinancialStateFromDueDate(renewalDueCivil, civilNow, graceDays);

  const graceEndsExclusiveCivil = timeline.suspension_start;
  const graceEndsExclusiveInstant = graceEndsExclusiveCivil
    ? civilDateStartInstantSaoPaulo(graceEndsExclusiveCivil)
    : null;

  const nextPeriodStartCivil = periodEndExclusiveCivil;
  let nextPeriodEndExclusiveCivil = null;
  if (nextPeriodStartCivil) {
    const startUtc = startOfUtcDay(nextPeriodStartCivil);
    if (startUtc) {
      const next = addUtcMonthsKeepingAnchorDay(startUtc, 1, anchor.getUTCDate());
      nextPeriodEndExclusiveCivil = formatUtcDateOnly(next);
    }
  }

  const competenceKey =
    subscription?.id && periodStartCivil && periodEndExclusiveCivil
      ? buildCompetenceKey(String(subscription.id), periodStartCivil, periodEndExclusiveCivil)
      : null;

  const nextCompetenceKey =
    subscription?.id && nextPeriodStartCivil && nextPeriodEndExclusiveCivil
      ? buildCompetenceKey(String(subscription.id), nextPeriodStartCivil, nextPeriodEndExclusiveCivil)
      : null;

  const preRenewalDays = BILLING_RENEWAL_PRE_RENEWAL_DAYS_DEFAULT;
  const daysUntilDue =
    civilNow && renewalDueCivil ? diffBillingCivilDays(civilNow, renewalDueCivil) : null;

  return {
    timezone: "America/Sao_Paulo",
    civil_now: civilNow,
    billing_cycle_anchor_civil: anchorCivil,
    billing_cycle_anchor_day: anchor.getUTCDate(),
    current_period_start_civil: periodStartCivil,
    current_period_end_inclusive_civil: periodEndInclusiveCivil,
    current_period_end_exclusive: periodEndExclusiveCivil,
    current_period_end_exclusive_instant: periodEndExclusiveCivil
      ? civilDateStartInstantSaoPaulo(periodEndExclusiveCivil)
      : null,
    renewal_due_civil: renewalDueCivil,
    financial_grace_days: graceDays,
    financial_grace_starts_civil: timeline.grace_period_start,
    financial_grace_ends_inclusive_civil: timeline.grace_period_end,
    financial_grace_ends_at_exclusive: graceEndsExclusiveInstant
      ? graceEndsExclusiveInstant.toISOString()
      : null,
    financial_grace_ends_exclusive_civil: graceEndsExclusiveCivil,
    suspension_start_civil: timeline.suspension_start,
    next_period_start_civil: nextPeriodStartCivil,
    next_period_end_exclusive: nextPeriodEndExclusiveCivil,
    competence_key: competenceKey,
    next_competence_key: nextCompetenceKey,
    days_until_due: daysUntilDue,
    days_past_due: timeline.days_past_due,
    billing_financial_state: timeline.billing_financial_state,
    pre_renewal_window: daysUntilDue != null && daysUntilDue >= 0 && daysUntilDue <= preRenewalDays,
    interval: "[current_period_start_civil, current_period_end_exclusive)",
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
export function readScheduledRenewalCompetence(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const raw = meta.scheduled_renewal;
  if (!raw || typeof raw !== "object") return null;
  const scheduled = /** @type {Record<string, unknown>} */ (raw);
  if (asTrimmedString(scheduled.activated_at)) return { ...scheduled, activated: true };
  return {
    payment_id: asTrimmedString(scheduled.payment_id),
    period_start: parseBillingCivilDate(scheduled.period_start),
    period_end: parseBillingCivilDate(scheduled.period_end),
    next_due_date: parseBillingCivilDate(scheduled.next_due_date),
    paid_at: asTrimmedString(scheduled.paid_at),
    activated: false,
  };
}
