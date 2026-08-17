// ======================================================================
// Ciclo mensal seller-centric — ancorado na ativação da assinatura
// ======================================================================

import { logBilling } from "../billingLog.js";
import { RENEWAL_CYCLE_OPEN_STATUSES, RENEWAL_STATUS, SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { resolveCanonicalBillableSubscription } from "./billingCanonicalSubscriptionService.js";
import { findOpenRenewalCycleForSubscription } from "./billingRenewalCycleRepository.js";
import { listUserBillingSubscriptions, pickActiveSubscription, pickLatestSubscription } from "./billingSubscriptionQueryService.js";

/** @typedef {"subscription_cycle"} BillingUsageWindowKind */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Fuso civil canônico para virada de ciclo e pagamento antecipado. */
export const BILLING_CANONICAL_TIMEZONE = "America/Sao_Paulo";

const billingCivilDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BILLING_CANONICAL_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Data civil YYYY-MM-DD no fuso canônico (America/Sao_Paulo).
 * Usar para instantes reais (paid_at, now). Não usar para campos DATE_ONLY de assinatura.
 *
 * @param {unknown} value
 */
export function formatBillingCivilDateInSaoPaulo(value) {
  const date = parseUtcDateTime(value);
  if (!date) return null;
  return billingCivilDateFormatter.format(date);
}

/**
 * Extrai a data civil canônica (YYYY-MM-DD) de campos persistidos como DATE_ONLY em UTC.
 * Preserva o componente UTC YYYY-MM-DD sem reinterpretar em America/Sao_Paulo.
 *
 * @param {unknown} value
 */
export function parseBillingCivilDate(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  return match[1];
}

/**
 * Diferença em dias civis entre duas datas DATE_ONLY (to − from).
 *
 * @param {string | null | undefined} fromCivil
 * @param {string | null | undefined} toCivil
 */
export function diffBillingCivilDays(fromCivil, toCivil) {
  const from = parseBillingCivilDate(fromCivil);
  const to = parseBillingCivilDate(toCivil);
  if (!from || !to) return null;
  const fromMs = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const toMs = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.floor((toMs - fromMs) / MS_PER_DAY);
}

/**
 * Soma dias civis a uma data DATE_ONLY.
 *
 * @param {string | null | undefined} civilDate
 * @param {number} days
 */
export function addBillingCivilDays(civilDate, days) {
  const parsed = parseBillingCivilDate(civilDate);
  if (!parsed) return null;
  const baseMs = Date.UTC(
    Number(parsed.slice(0, 4)),
    Number(parsed.slice(5, 7)) - 1,
    Number(parsed.slice(8, 10))
  );
  return formatUtcDateOnly(new Date(baseMs + days * MS_PER_DAY));
}

/**
 * @param {unknown} civilDate
 */
export function formatBillingCivilDate(civilDate) {
  return parseBillingCivilDate(civilDate);
}

/**
 * @param {Record<string, unknown> | null | undefined} subscription
 */
export function resolveSubscriptionCivilPeriod(subscription) {
  const meta =
    subscription?.metadata && typeof subscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (subscription.metadata)
      : {};
  return {
    current_period_start: parseBillingCivilDate(subscription?.current_period_start),
    current_period_end: parseBillingCivilDate(subscription?.current_period_end),
    next_due_date: parseBillingCivilDate(subscription?.next_due_date ?? subscription?.next_billing_at),
    billing_cycle_anchor: parseBillingCivilDate(
      subscription?.billing_cycle_anchor ?? meta.billing_cycle_anchor ?? subscription?.current_period_start
    ),
  };
}

/**
 * Dia civil de início/vencimento (ex.: 21). Derivado por DATE_ONLY, sem drift de fuso.
 *
 * @param {Record<string, unknown> | null | undefined} subscription
 */
export function resolveSubscriptionAnchorStartDay(subscription) {
  const period = resolveSubscriptionCivilPeriod(subscription);
  const anchorCivil = period.billing_cycle_anchor ?? period.current_period_start;
  if (!anchorCivil) return 21;
  const day = Number(anchorCivil.split("-")[2]);
  return Number.isFinite(day) && day >= 1 && day <= 31 ? day : 21;
}

/**
 * Dia civil de encerramento inclusivo (ex.: 20 quando início é 21).
 *
 * @param {number} startDay
 */
export function resolveSubscriptionAnchorEndDay(startDay) {
  return startDay > 1 ? startDay - 1 : 31;
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 */
export function detectBillingCivilDateDrift(value, fieldName) {
  const dateOnly = parseBillingCivilDate(value);
  const timezoneView = formatBillingCivilDateInSaoPaulo(value);
  if (!dateOnly || !timezoneView || dateOnly === timezoneView) {
    return { field: fieldName, drift: false, date_only: dateOnly, timezone_view: timezoneView };
  }
  return { field: fieldName, drift: true, date_only: dateOnly, timezone_view: timezoneView };
}

/**
 * Valida coerência civil DATE_ONLY (âncora vs início do período).
 * Não aborta por drift timezone_view — meia-noite UTC é persistência canônica.
 *
 * @param {Record<string, unknown> | null | undefined} subscription
 */
export function assertSubscriptionCivilDatesCanonical(subscription) {
  const period = resolveSubscriptionCivilPeriod(subscription);
  const anchorDay = resolveSubscriptionAnchorStartDay(subscription);
  const startDayFromPeriod = period.current_period_start
    ? Number(period.current_period_start.split("-")[2])
    : null;

  if (startDayFromPeriod != null && startDayFromPeriod !== anchorDay) {
    const err = new Error(
      `BILLING_CIVIL_DATE_DRIFT: anchor_day ${anchorDay} diverge do period_start ${period.current_period_start}`
    );
    /** @type {any} */ (err).code = "BILLING_CIVIL_DATE_DRIFT";
    throw err;
  }

  return { period, anchor_day: anchorDay };
}

/**
 * Persistência canônica DATE_ONLY — início de período (meia-noite UTC).
 *
 * @param {string} civilDate YYYY-MM-DD
 */
export function isoBillingPeriodStartFromCivil(civilDate) {
  const parsed = parseBillingCivilDate(civilDate);
  if (!parsed) throw new Error("isoBillingPeriodStartFromCivil: data civil inválida");
  return `${parsed}T00:00:00.000Z`;
}

/**
 * Persistência canônica DATE_ONLY — fim inclusivo de período.
 *
 * @param {string} civilDate YYYY-MM-DD
 */
export function isoBillingPeriodEndFromCivil(civilDate) {
  const parsed = parseBillingCivilDate(civilDate);
  if (!parsed) throw new Error("isoBillingPeriodEndFromCivil: data civil inválida");
  return `${parsed}T23:59:59.999Z`;
}

/**
 * Pagamento confirmado ainda dentro do período vigente (inclusive no último dia).
 *
 * @param {Record<string, unknown> | null | undefined} subscription
 * @param {unknown} paidAtIso
 */
export function isEarlyRenewalPaymentWithinCurrentPeriod(subscription, paidAtIso) {
  const periodEnd = subscription?.current_period_end;
  if (!periodEnd || paidAtIso == null || paidAtIso === "") return false;

  const paidCivil = formatBillingCivilDateInSaoPaulo(paidAtIso);
  const endCivil = parseBillingCivilDate(periodEnd) ?? formatBillingCivilDateInSaoPaulo(periodEnd);
  if (!paidCivil || !endCivil) return false;

  return paidCivil <= endCivil;
}

/**
 * @param {unknown} value
 * @returns {Date | null}
 */
export function parseUtcDateTime(value) {
  if (value == null || value === "") return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {Date} date
 * @returns {string}
 */
export function formatUtcDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {unknown} value
 * @returns {Date | null}
 */
export function startOfUtcDay(value) {
  const d = parseUtcDateTime(value);
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * @param {Date} date
 * @returns {Date}
 */
export function endOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

/**
 * @param {Date} date
 * @param {number} months
 * @param {number} anchorDay
 * @returns {Date}
 */
export function addUtcMonthsKeepingAnchorDay(date, months, anchorDay) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchorDay, lastDay));
  return target;
}

/**
 * @param {Date} nextPeriodStart
 * @returns {Date}
 */
export function deriveInclusivePeriodEndBeforeNextBilling(nextPeriodStart) {
  const endDay = new Date(nextPeriodStart.getTime() - MS_PER_DAY);
  return endOfUtcDay(endDay);
}

/**
 * @param {unknown} nextBillingValue
 * @returns {Date | null}
 */
export function derivePeriodEndFromNextBilling(nextBillingValue) {
  const nextStart = startOfUtcDay(nextBillingValue);
  if (!nextStart) return null;
  return deriveInclusivePeriodEndBeforeNextBilling(nextStart);
}

/**
 * @param {Record<string, unknown> | null | undefined} subscription
 * @param {Date} [now]
 */
export function resolveBillingCycleAnchor(subscription, now = new Date()) {
  const explicit = parseUtcDateTime(subscription?.billing_cycle_anchor);
  if (explicit) return startOfUtcDay(explicit);

  const periodStart = startOfUtcDay(subscription?.current_period_start);
  if (periodStart) return periodStart;

  const createdAt = startOfUtcDay(subscription?.created_at);
  if (createdAt) return createdAt;

  return startOfUtcDay(now);
}

/**
 * @typedef {{
 *   openRenewalCycle?: Record<string, unknown> | null;
 *   allowCalendarRollForward?: boolean;
 * }} BillingCycleResolverContext
 */

/**
 * Reserva de período pago (scheduled_renewal) ainda não ativada na virada civil.
 *
 * @param {unknown} metadata
 */
function hasPendingScheduledRenewalActivation(metadata) {
  const meta = metadata && typeof metadata === "object" ? /** @type {Record<string, unknown>} */ (metadata) : null;
  const raw = meta?.scheduled_renewal;
  if (!raw || typeof raw !== "object") return false;
  return !/** @type {Record<string, unknown>} */ (raw).activated_at;
}

/**
 * Período persistido prevalece sobre roll-forward calendárico quando não há pagamento confirmado.
 *
 * @param {Record<string, unknown> | null | undefined} subscription
 * @param {Date} now
 * @param {BillingCycleResolverContext} [context]
 */
export function shouldHoldPersistedBillingPeriodWithoutPayment(subscription, now, context = {}) {
  const openCycle = context.openRenewalCycle;
  if (openCycle?.renewal_status && RENEWAL_CYCLE_OPEN_STATUSES.includes(String(openCycle.renewal_status))) {
    if (String(openCycle.renewal_status) !== RENEWAL_STATUS.PAID) {
      return true;
    }
  }

  if (hasPendingScheduledRenewalActivation(subscription?.metadata)) {
    return true;
  }

  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const periodEnd = parseBillingCivilDate(subscription?.current_period_end);
  const nextDue = parseBillingCivilDate(subscription?.next_due_date ?? subscription?.next_billing_at);

  if (periodEnd && civilNow && civilNow > periodEnd) return true;
  if (nextDue && civilNow && civilNow >= nextDue) return true;

  return false;
}

/**
 * @param {Date} anchor
 * @param {number} anchorDay
 * @param {number} nowMs
 */
function resolveCalendarRollForwardCycle(anchor, anchorDay, nowMs) {
  let periodStart = anchor;
  while (true) {
    const nextBillingAt = addUtcMonthsKeepingAnchorDay(periodStart, 1, anchorDay);
    const periodEnd = deriveInclusivePeriodEndBeforeNextBilling(nextBillingAt);
    if (nowMs < nextBillingAt.getTime()) {
      return buildCyclePayload(anchor, periodStart, periodEnd, nextBillingAt);
    }
    periodStart = nextBillingAt;
  }
}

/**
 * @param {Record<string, unknown> | null | undefined} subscription
 * @param {Date} now
 * @param {BillingCycleResolverContext} [context]
 */
export function resolveSubscriptionBillingCycle(subscription, now = new Date(), context = {}) {
  const anchor = resolveBillingCycleAnchor(subscription, now);
  const anchorDay = anchor.getUTCDate();
  const nowMs = now.getTime();

  const persistedStart = startOfUtcDay(subscription?.current_period_start);
  const persistedEnd = endOfUtcDay(parseUtcDateTime(subscription?.current_period_end) ?? persistedStart ?? anchor);
  const persistedNext = startOfUtcDay(subscription?.next_billing_at ?? subscription?.next_due_date);

  if (persistedStart && persistedEnd && nowMs >= persistedStart.getTime() && nowMs <= persistedEnd.getTime()) {
    const nextBillingAt = persistedNext ?? addUtcMonthsKeepingAnchorDay(persistedStart, 1, anchorDay);
    return buildCyclePayload(anchor, persistedStart, persistedEnd, nextBillingAt);
  }

  if (persistedStart && persistedEnd && shouldHoldPersistedBillingPeriodWithoutPayment(subscription, now, context)) {
    const nextBillingAt = persistedNext ?? addUtcMonthsKeepingAnchorDay(persistedStart, 1, anchorDay);
    return buildCyclePayload(anchor, persistedStart, persistedEnd, nextBillingAt);
  }

  if (context.allowCalendarRollForward === true) {
    return resolveCalendarRollForwardCycle(anchor, anchorDay, nowMs);
  }

  if (persistedStart && persistedEnd) {
    const nextBillingAt = persistedNext ?? addUtcMonthsKeepingAnchorDay(persistedStart, 1, anchorDay);
    return buildCyclePayload(anchor, persistedStart, persistedEnd, nextBillingAt);
  }

  return resolveCalendarRollForwardCycle(anchor, anchorDay, nowMs);
}

/**
 * @param {Date} anchor
 * @param {Date} periodStart
 * @param {Date} periodEnd
 * @param {Date} nextBillingAt
 */
function buildCyclePayload(anchor, periodStart, periodEnd, nextBillingAt) {
  return {
    billing_cycle_anchor: anchor.toISOString(),
    current_period_start: periodStart.toISOString(),
    current_period_end: periodEnd.toISOString(),
    next_billing_at: nextBillingAt.toISOString(),
    period_start: formatUtcDateOnly(periodStart),
    period_end: formatUtcDateOnly(periodEnd),
    window_kind: /** @type {BillingUsageWindowKind} */ ("subscription_cycle"),
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Date} now
 */
function subscriptionCyclePriority(row, now) {
  const status = String(row.status || "").toLowerCase();
  const provider = String(row.provider || "").toLowerCase();
  if (status === SUBSCRIPTION_STATUS.PENDING) return 99;

  const cycle = resolveSubscriptionBillingCycle(row, now);
  const periodStart = startOfUtcDay(cycle.current_period_start);
  const periodEnd = endOfUtcDay(parseUtcDateTime(cycle.current_period_end) ?? periodStart ?? now);
  const inWindow =
    periodStart != null && periodEnd != null && now.getTime() >= periodStart.getTime() && now.getTime() <= periodEnd.getTime();
  if (!inWindow) return 98;

  if (provider === "internal" && status === SUBSCRIPTION_STATUS.INTERNAL_FREE) return 0;
  if (status === SUBSCRIPTION_STATUS.ACTIVE) return 1;
  if (status === SUBSCRIPTION_STATUS.PAST_DUE) return 2;
  return 3;
}

/**
 * Herda ciclo de cobrança de assinaturas que serão substituídas (upgrade/downgrade no mesmo ciclo).
 *
 * @param {Array<Record<string, unknown>>} subscriptions
 * @param {string} keepSubscriptionId
 * @param {Date} [now]
 */
export function inheritBillingCycleFromSupersededSubscriptions(subscriptions, keepSubscriptionId, now = new Date()) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  /** @type {{ row: Record<string, unknown>; priority: number } | null} */
  let best = null;

  for (const row of list) {
    if (String(row.id) === String(keepSubscriptionId)) continue;
    const status = String(row.status || "").toLowerCase();
    if (status === SUBSCRIPTION_STATUS.CANCELED || status === SUBSCRIPTION_STATUS.REFUNDED) continue;
    if (status === SUBSCRIPTION_STATUS.PENDING) continue;

    const priority = subscriptionCyclePriority(row, now);
    if (priority >= 98) continue;
    if (!best || priority < best.priority) {
      best = { row, priority };
    }
  }

  if (!best) return null;

  const cycle = resolveSubscriptionBillingCycle(best.row, now);
  const meta = best.row.metadata && typeof best.row.metadata === "object" ? best.row.metadata : {};
  const anchor =
    parseUtcDateTime(meta.billing_cycle_anchor) ??
    parseUtcDateTime(cycle.billing_cycle_anchor) ??
    startOfUtcDay(cycle.current_period_start);

  return {
    source_subscription_id: best.row.id != null ? String(best.row.id) : null,
    source_status: best.row.status != null ? String(best.row.status) : null,
    source_provider: best.row.provider != null ? String(best.row.provider) : null,
    billing_cycle_anchor: anchor?.toISOString() ?? cycle.billing_cycle_anchor,
    current_period_start: cycle.current_period_start,
    current_period_end: cycle.current_period_end,
    next_billing_at: cycle.next_billing_at,
    next_due_date: cycle.next_billing_at.slice(0, 10),
    period_start: cycle.period_start,
    period_end: cycle.period_end,
    window_kind: cycle.window_kind,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} keepSubscriptionId
 * @param {Date} [now]
 */
export async function loadInheritedBillingCycleForActivation(supabase, userId, keepSubscriptionId, now = new Date()) {
  const list = await listUserBillingSubscriptions(supabase, userId);
  const inherited = inheritBillingCycleFromSupersededSubscriptions(list, keepSubscriptionId, now);
  if (inherited) {
    logBilling("billing", "[S7_BILLING_CYCLE_INHERITED_ON_UPGRADE]", {
      user_id: userId,
      keep_subscription_id: keepSubscriptionId,
      source_subscription_id: inherited.source_subscription_id,
      period_start: inherited.period_start,
      period_end: inherited.period_end,
    });
  }
  return inherited;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 */
export async function loadPrimaryBillingSubscription(supabase, userId) {
  const list = await listUserBillingSubscriptions(supabase, userId);
  return (
    resolveCanonicalBillableSubscription(list) ?? pickActiveSubscription(list) ?? pickLatestSubscription(list)
  );
}

/**
 * @param {Record<string, unknown>} subscription
 * @param {ReturnType<typeof resolveSubscriptionBillingCycle>} cycle
 */
export function enrichSubscriptionWithBillingCycle(subscription, cycle) {
  return {
    ...subscription,
    billing_cycle_anchor: cycle.billing_cycle_anchor,
    current_period_start: cycle.current_period_start,
    current_period_end: cycle.current_period_end,
    next_billing_at: cycle.next_billing_at,
    next_due_date: cycle.next_billing_at.slice(0, 10),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {ReturnType<typeof resolveSubscriptionBillingCycle>} cycle
 */
export async function persistComputedBillingCycle(supabase, subscriptionId, cycle) {
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({
      current_period_start: cycle.current_period_start,
      current_period_end: cycle.current_period_end,
      next_due_date: cycle.next_billing_at.slice(0, 10),
      updated_at: new Date().toISOString(),
    })
    .eq("id", subscriptionId);
  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Date} [now]
 */
export async function resolveSellerBillingCycle(supabase, userId, now = new Date()) {
  const subscription = await loadPrimaryBillingSubscription(supabase, userId);
  if (!subscription) {
    const anchor = startOfUtcDay(now);
    const nextBillingAt = addUtcMonthsKeepingAnchorDay(anchor, 1, anchor.getUTCDate());
    const periodEnd = deriveInclusivePeriodEndBeforeNextBilling(nextBillingAt);
    return {
      subscription: null,
      cycle: buildCyclePayload(anchor, anchor, periodEnd, nextBillingAt),
    };
  }

  let openRenewalCycle = null;
  try {
    openRenewalCycle = await findOpenRenewalCycleForSubscription(supabase, String(subscription.id), { userId });
  } catch {
    /* não bloquear status */
  }

  const resolverContext = {
    openRenewalCycle,
    allowCalendarRollForward: String(subscription.provider || "").toLowerCase() === "internal",
  };

  const cycle = resolveSubscriptionBillingCycle(subscription, now, resolverContext);
  if (String(subscription.provider || "").toLowerCase() === "internal") {
    const needsPersist =
      !subscription.current_period_start ||
      !subscription.current_period_end ||
      !subscription.next_due_date ||
      String(subscription.current_period_start) !== cycle.current_period_start ||
      String(subscription.current_period_end) !== cycle.current_period_end ||
      String(subscription.next_due_date) !== cycle.next_billing_at.slice(0, 10);
    if (needsPersist) {
      try {
        await persistComputedBillingCycle(supabase, String(subscription.id), cycle);
      } catch {
        /* não bloquear status */
      }
    }
  }

  return { subscription, cycle };
}
