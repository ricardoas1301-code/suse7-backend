// ======================================================================
// Ativação do período reservado — virada civil após pagamento antecipado
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { RENEWAL_STATUS, SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { formatBillingCivilDateInSaoPaulo, formatUtcDateOnly, startOfUtcDay } from "./billingCycleService.js";
import { updateRenewalCycle } from "./billingRenewalCycleRepository.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} metadata
 */
export function readScheduledRenewalFromMetadata(metadata) {
  const meta = metadata && typeof metadata === "object" ? /** @type {Record<string, unknown>} */ (metadata) : null;
  const raw = meta?.scheduled_renewal;
  if (!raw || typeof raw !== "object") return null;

  const scheduled = /** @type {Record<string, unknown>} */ (raw);
  const periodStartIso = asTrimmedString(scheduled.period_start_iso);
  const periodEndIso = asTrimmedString(scheduled.period_end_iso);
  const nextDueDate = asTrimmedString(scheduled.next_due_date);
  const paymentId = asTrimmedString(scheduled.payment_id);

  if (!periodStartIso || !periodEndIso || !nextDueDate || !paymentId) return null;

  return {
    payment_id: paymentId,
    paid_at: asTrimmedString(scheduled.paid_at),
    renewal_cycle_id: asTrimmedString(scheduled.renewal_cycle_id),
    renewal_mode: asTrimmedString(scheduled.renewal_mode),
    period_start:
      asTrimmedString(scheduled.period_start) ??
      formatUtcDateOnly(startOfUtcDay(periodStartIso) ?? new Date(periodStartIso)),
    period_end:
      asTrimmedString(scheduled.period_end) ??
      formatUtcDateOnly(startOfUtcDay(periodEndIso) ?? new Date(periodEndIso)),
    period_start_iso: periodStartIso,
    period_end_iso: periodEndIso,
    next_due_date: nextDueDate,
    billing_cycle_anchor: asTrimmedString(scheduled.billing_cycle_anchor),
    activated_at: asTrimmedString(scheduled.activated_at),
  };
}

/**
 * @param {Record<string, unknown>} subscription
 * @param {Date} now
 */
export function isScheduledRenewalDueForActivation(subscription, now) {
  const scheduled = readScheduledRenewalFromMetadata(subscription.metadata);
  if (!scheduled || scheduled.activated_at) return false;

  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  if (!civilNow || !scheduled.period_start) return false;

  return civilNow >= scheduled.period_start;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Date} now
 */
async function listSubscriptionsWithPendingScheduledRenewal(supabase, now) {
  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select(
      "id, user_id, plan_id, status, current_period_start, current_period_end, next_due_date, metadata, billing_cycle_anchor, amount"
    )
    .eq("status", SUBSCRIPTION_STATUS.ACTIVE)
    .not("metadata", "is", null)
    .order("current_period_end", { ascending: true })
    .limit(500);
  if (error) throw error;

  return (Array.isArray(data) ? data : []).filter((row) => {
    const scheduled = readScheduledRenewalFromMetadata(row.metadata);
    if (!scheduled || scheduled.activated_at) return false;
    if (!civilNow || !scheduled.period_start) return false;
    return civilNow >= scheduled.period_start;
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 * @param {{ now?: Date; source?: string }} [options]
 */
export async function applyScheduledSubscriptionPeriodRollover(supabase, subscription, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const source = options.source ?? "scheduled_renewal_activation";
  const subscriptionId = String(subscription.id);
  const scheduled = readScheduledRenewalFromMetadata(subscription.metadata);

  if (!scheduled) {
    return { activated: false, reason: "no_scheduled_renewal" };
  }

  if (scheduled.activated_at) {
    logBilling("billing", "SUBSCRIPTION_RENEWAL_ACTIVATION_IDEMPOTENCY_HIT", {
      user_id: subscription.user_id,
      subscription_id: subscriptionId,
      payment_id: scheduled.payment_id,
      source,
    });
    return { activated: false, idempotent: true, reason: "already_activated" };
  }

  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  if (!civilNow || civilNow < scheduled.period_start) {
    return { activated: false, reason: "activation_date_not_reached" };
  }

  const currentStartDay = formatUtcDateOnly(
    startOfUtcDay(subscription.current_period_start) ?? new Date(String(subscription.current_period_start))
  );
  if (currentStartDay === scheduled.period_start) {
    const meta =
      subscription.metadata && typeof subscription.metadata === "object"
        ? { .../** @type {Record<string, unknown>} */ (subscription.metadata) }
        : {};

    if (!scheduled.activated_at) {
      await supabase
        .from("billing_subscriptions")
        .update({
          metadata: {
            ...meta,
            scheduled_renewal: {
              ...scheduled,
              activated_at: now.toISOString(),
            },
          },
          updated_at: now.toISOString(),
        })
        .eq("id", subscriptionId);
    }

    return { activated: false, idempotent: true, reason: "period_already_active" };
  }

  const meta =
    subscription.metadata && typeof subscription.metadata === "object"
      ? { .../** @type {Record<string, unknown>} */ (subscription.metadata) }
      : {};

  const activatedScheduled = {
    ...scheduled,
    activated_at: now.toISOString(),
  };

  const { error: subErr } = await supabase
    .from("billing_subscriptions")
    .update({
      status: SUBSCRIPTION_STATUS.ACTIVE,
      current_period_start: scheduled.period_start_iso,
      current_period_end: scheduled.period_end_iso,
      next_due_date: scheduled.next_due_date,
      metadata: {
        ...meta,
        scheduled_renewal: activatedScheduled,
        delinquency_status: "none",
        ...(scheduled.billing_cycle_anchor ? { billing_cycle_anchor: scheduled.billing_cycle_anchor } : {}),
      },
      updated_at: now.toISOString(),
    })
    .eq("id", subscriptionId);

  if (subErr) {
    logBillingError("billing", "SUBSCRIPTION_RENEWAL_ACTIVATION_FAILED", subErr, {
      user_id: subscription.user_id,
      subscription_id: subscriptionId,
      payment_id: scheduled.payment_id,
      source,
    });
    throw subErr;
  }

  if (scheduled.renewal_cycle_id) {
    await updateRenewalCycle(supabase, scheduled.renewal_cycle_id, {
      renewal_status: RENEWAL_STATUS.CLOSED,
    });
  }

  logBilling("billing", "SUBSCRIPTION_RENEWAL_ACTIVATED", {
    user_id: subscription.user_id,
    subscription_id: subscriptionId,
    payment_id: scheduled.payment_id,
    renewal_cycle_id: scheduled.renewal_cycle_id,
    renewal_mode: scheduled.renewal_mode,
    current_period_start: scheduled.period_start_iso,
    current_period_end: scheduled.period_end_iso,
    next_due_date: scheduled.next_due_date,
    source,
  });

  return {
    activated: true,
    idempotent: false,
    payment_id: scheduled.payment_id,
    renewal_cycle_id: scheduled.renewal_cycle_id,
    period: {
      current_period_start: scheduled.period_start_iso,
      current_period_end: scheduled.period_end_iso,
      next_due_date: scheduled.next_due_date,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ now?: Date; limit?: number; source?: string }} [options]
 */
export async function processScheduledSubscriptionRenewalActivations(supabase, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const dueRows = await listSubscriptionsWithPendingScheduledRenewal(supabase, now);
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : dueRows.length;
  const selected = dueRows.slice(0, limit);

  /** @type {Array<Record<string, unknown>>} */
  const processed = [];
  /** @type {Array<{ subscription_id: string; message: string }>} */
  const failures = [];

  for (const row of selected) {
    try {
      const result = await applyScheduledSubscriptionPeriodRollover(supabase, row, {
        now,
        source: options.source ?? "scheduled_renewal_activation_job",
      });
      processed.push({
        subscription_id: String(row.id),
        user_id: row.user_id,
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ subscription_id: String(row.id), message });
      logBillingError("billing", "scheduled_renewal_activation_failed", error, {
        subscription_id: row.id,
        user_id: row.user_id,
      });
    }
  }

  return {
    scanned: dueRows.length,
    selected: selected.length,
    processed_count: processed.filter((item) => item.activated).length,
    idempotent_count: processed.filter((item) => item.idempotent).length,
    failed_count: failures.length,
    processed,
    failures,
  };
}
