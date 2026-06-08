// ======================================================================
// Ciclo mensal seller-centric — ancorado na ativação da assinatura
// ======================================================================

import { logBilling } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { listUserBillingSubscriptions, pickActiveSubscription, pickLatestSubscription } from "./billingSubscriptionQueryService.js";

/** @typedef {"subscription_cycle"} BillingUsageWindowKind */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
 * @param {Record<string, unknown> | null | undefined} subscription
 * @param {Date} [now]
 */
export function resolveSubscriptionBillingCycle(subscription, now = new Date()) {
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
  return pickActiveSubscription(list) ?? pickLatestSubscription(list);
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

  const cycle = resolveSubscriptionBillingCycle(subscription, now);
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
