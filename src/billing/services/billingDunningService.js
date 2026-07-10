// ======================================================================
// Inadimplência — grace period, suspensão e recuperação
// ======================================================================

import {
  BILLING_DUNNING_GRACE_PERIOD_DAYS_DEFAULT,
  DELINQUENCY_STATUS,
  SUBSCRIPTION_STATUS,
} from "../billingConstants.js";
import { logBilling, logBillingError } from "../billingLog.js";
import { activateSubscriptionFromPaidPayment } from "./billingSubscriptionActivationService.js";
import { recordBillingEvent } from "../billingEventService.js";
import { derivePeriodEndFromNextBilling, startOfUtcDay } from "./billingCycleService.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} value
 */
function parseDate(value) {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function resolveBillingDunningGracePeriodDays() {
  const raw = Number(process.env.BILLING_DUNNING_GRACE_PERIOD_DAYS ?? BILLING_DUNNING_GRACE_PERIOD_DAYS_DEFAULT);
  if (!Number.isFinite(raw) || raw < 0) return BILLING_DUNNING_GRACE_PERIOD_DAYS_DEFAULT;
  return Math.floor(raw);
}

/**
 * @param {Date} from
 * @param {number} days
 */
function addUtcDays(from, days) {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

/**
 * @param {unknown} metadata
 */
export function readSubscriptionDelinquency(metadata) {
  const meta = asObject(metadata) ?? {};
  const status = asTrimmedString(meta.delinquency_status) ?? DELINQUENCY_STATUS.NONE;
  return {
    delinquency_status: status,
    overdue_since: asTrimmedString(meta.overdue_since),
    grace_period_ends_at: asTrimmedString(meta.grace_period_ends_at),
    access_suspended_at: asTrimmedString(meta.access_suspended_at),
  };
}

/**
 * @param {Record<string, unknown>} subscription
 */
export function enrichSubscriptionDelinquencyFields(subscription) {
  const delinquency = readSubscriptionDelinquency(subscription.metadata);
  const graceEndsAt = parseDate(delinquency.grace_period_ends_at);
  const now = Date.now();
  const inGrace =
    delinquency.delinquency_status === DELINQUENCY_STATUS.GRACE &&
    graceEndsAt != null &&
    graceEndsAt.getTime() > now;
  return {
    ...subscription,
    ...delinquency,
    delinquency_in_grace: inGrace,
    delinquency_access_blocked:
      delinquency.delinquency_status === DELINQUENCY_STATUS.SUSPENDED ||
      (delinquency.delinquency_status === DELINQUENCY_STATUS.GRACE && !inGrace),
  };
}

/**
 * @param {Record<string, unknown>} metadata
 * @param {Date} now
 */
export function resolveDelinquencyAccess(metadata, now = new Date()) {
  const delinquency = readSubscriptionDelinquency(metadata);
  if (delinquency.delinquency_status === DELINQUENCY_STATUS.GRACE) {
    const graceEndsAt = parseDate(delinquency.grace_period_ends_at);
    if (graceEndsAt && graceEndsAt.getTime() > now.getTime()) {
      return { can_access: true, state: "past_due", delinquency_warning: true };
    }
    return { can_access: false, state: "past_due", delinquency_warning: false };
  }
  if (delinquency.delinquency_status === DELINQUENCY_STATUS.SUSPENDED) {
    return { can_access: false, state: "past_due", delinquency_warning: false };
  }
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} eventType
 * @param {string} providerEventId
 * @param {Record<string, unknown>} rawPayload
 */
async function recordDunningEvent(supabase, eventType, providerEventId, rawPayload) {
  try {
    await recordBillingEvent(supabase, {
      provider: "suse7",
      providerEventId,
      eventType,
      rawPayload,
    });
  } catch (error) {
    logBillingError("billing", "dunning_event_failed", error, { event_type: eventType, provider_event_id: providerEventId });
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} providerSubscriptionId
 */
async function loadSubscriptionByProviderId(supabase, providerSubscriptionId) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select(
      "id, user_id, plan_id, plan_key, provider, provider_subscription_id, status, current_period_start, current_period_end, next_due_date, metadata"
    )
    .eq("provider", "asaas")
    .eq("provider_subscription_id", providerSubscriptionId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) ? data[0] ?? null : null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} providerSubscriptionId
 * @param {Record<string, unknown>} patch
 */
async function updateSubscriptionByProviderId(supabase, providerSubscriptionId, patch) {
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("provider", "asaas")
    .eq("provider_subscription_id", providerSubscriptionId);
  if (error) throw error;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string | null} subscriptionId
 */
export async function findLatestOverduePaymentInvoiceUrl(supabase, userId, subscriptionId) {
  let query = supabase
    .from("billing_payments")
    .select("status, raw_payload, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(20);
  if (subscriptionId) query = query.eq("subscription_id", subscriptionId);
  const { data, error } = await query;
  if (error) throw error;

  for (const row of data ?? []) {
    const status = String(row.status || "").toUpperCase();
    if (status !== "OVERDUE" && status !== "PAST_DUE") continue;
    const payload = asObject(row.raw_payload) ?? {};
    const invoiceUrl =
      asTrimmedString(payload.invoiceUrl) ??
      asTrimmedString(payload.bankSlipUrl) ??
      asTrimmedString(payload.transactionReceiptUrl);
    if (invoiceUrl) return invoiceUrl;
  }
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   providerSubscriptionId: string;
 *   paymentId?: string | null;
 *   nextDueDate?: string | null;
 * }} ctx
 */
export async function applyPaymentOverdueDelinquency(supabase, ctx) {
  const subscription = await loadSubscriptionByProviderId(supabase, ctx.providerSubscriptionId);
  if (!subscription?.id) return null;

  const now = new Date();
  const graceDays = resolveBillingDunningGracePeriodDays();
  const graceEndsAt = addUtcDays(now, graceDays);
  const metadata = {
    ...(asObject(subscription.metadata) ?? {}),
    overdue_since: asObject(subscription.metadata)?.overdue_since ?? now.toISOString(),
  };
  const previousStatus = readSubscriptionDelinquency(metadata).delinquency_status;
  if (previousStatus !== DELINQUENCY_STATUS.GRACE && previousStatus !== DELINQUENCY_STATUS.SUSPENDED) {
    metadata.delinquency_status = DELINQUENCY_STATUS.GRACE;
    metadata.grace_period_ends_at = graceEndsAt.toISOString();
    metadata.access_suspended_at = null;
  }

  await updateSubscriptionByProviderId(supabase, ctx.providerSubscriptionId, {
    status: SUBSCRIPTION_STATUS.PAST_DUE,
    ...(ctx.nextDueDate ? { next_due_date: ctx.nextDueDate } : {}),
    metadata,
  });

  if (previousStatus !== DELINQUENCY_STATUS.GRACE) {
    await recordDunningEvent(supabase, "SUBSCRIPTION_GRACE_PERIOD_STARTED", `grace:${subscription.id}`, {
      subscription_id: subscription.id,
      user_id: subscription.user_id,
      payment_id: ctx.paymentId ?? null,
      grace_period_ends_at: metadata.grace_period_ends_at,
      grace_period_days: graceDays,
    });
  }

  await recordDunningEvent(supabase, "PAYMENT_OVERDUE", `payment_overdue:${ctx.paymentId ?? subscription.id}:${now.toISOString().slice(0, 10)}`, {
    subscription_id: subscription.id,
    user_id: subscription.user_id,
    payment_id: ctx.paymentId ?? null,
    grace_period_ends_at: metadata.grace_period_ends_at,
  });

  logBilling("billing", "payment_overdue_grace_started", {
    subscription_id: subscription.id,
    user_id: subscription.user_id,
    grace_period_ends_at: metadata.grace_period_ends_at,
  });

  return { subscription_id: subscription.id, grace_period_ends_at: metadata.grace_period_ends_at };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   providerSubscriptionId: string;
 *   paymentId?: string | null;
 *   nextDueDate?: string | null;
 *   paidAt?: string | null;
 * }} ctx
 */
export async function applyPaymentRecoveryDelinquency(supabase, ctx) {
  const result = await activateSubscriptionFromPaidPayment(supabase, {
    providerSubscriptionId: ctx.providerSubscriptionId,
    providerPaymentId: ctx.paymentId ?? null,
    nextDueDate: ctx.nextDueDate ?? null,
    paidAt: ctx.paidAt ?? null,
    source: "payment_recovery",
  });

  if (!result?.subscription_id) return null;

  const subscription = await loadSubscriptionByProviderId(supabase, ctx.providerSubscriptionId);
  if (!subscription?.id) {
    return { subscription_id: result.subscription_id, recovered: Boolean(result.activated) };
  }

  const previous = readSubscriptionDelinquency(subscription.metadata);
  if (previous.delinquency_status === DELINQUENCY_STATUS.GRACE || previous.delinquency_status === DELINQUENCY_STATUS.SUSPENDED) {
    await recordDunningEvent(supabase, "SUBSCRIPTION_RECOVERED", `recovered:${subscription.id}:${ctx.paymentId ?? "payment"}`, {
      subscription_id: subscription.id,
      user_id: subscription.user_id,
      payment_id: ctx.paymentId ?? null,
      previous_delinquency_status: previous.delinquency_status,
    });
  }

  logBilling("billing", "subscription_recovered", {
    subscription_id: result.subscription_id,
    user_id: result.user_id ?? subscription.user_id,
    payment_id: ctx.paymentId ?? null,
    activated: result.activated,
  });

  return { subscription_id: result.subscription_id, recovered: true, activated: result.activated };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 * @param {Date} now
 */
async function suspendDelinquentSubscription(supabase, subscription, now) {
  const metadata = {
    ...(asObject(subscription.metadata) ?? {}),
    delinquency_status: DELINQUENCY_STATUS.SUSPENDED,
    access_suspended_at: now.toISOString(),
  };
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({
      status: SUBSCRIPTION_STATUS.PAST_DUE,
      metadata,
      updated_at: now.toISOString(),
    })
    .eq("id", subscription.id);
  if (error) throw error;

  await recordDunningEvent(supabase, "SUBSCRIPTION_ACCESS_SUSPENDED", `suspended:${subscription.id}`, {
    subscription_id: subscription.id,
    user_id: subscription.user_id,
    access_suspended_at: metadata.access_suspended_at,
    grace_period_ends_at: readSubscriptionDelinquency(subscription.metadata).grace_period_ends_at,
  });

  logBilling("billing", "subscription_access_suspended", {
    subscription_id: subscription.id,
    user_id: subscription.user_id,
  });

  return { subscription_id: String(subscription.id), user_id: String(subscription.user_id) };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ now?: Date; limit?: number }} [options]
 */
export async function processBillingOverdues(supabase, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("id, user_id, status, metadata")
    .in("status", [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.PENDING])
    .limit(200);
  if (error) throw error;

  const dueRows = (Array.isArray(data) ? data : []).filter((row) => {
    const delinquency = readSubscriptionDelinquency(row.metadata);
    if (delinquency.delinquency_status !== DELINQUENCY_STATUS.GRACE) return false;
    const graceEndsAt = parseDate(delinquency.grace_period_ends_at);
    return graceEndsAt != null && graceEndsAt.getTime() <= now.getTime();
  });

  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : dueRows.length;
  const selected = dueRows.slice(0, limit);
  /** @type {Array<Record<string, unknown>>} */
  const processed = [];
  /** @type {Array<{ subscription_id: string; message: string }>} */
  const failures = [];

  for (const row of selected) {
    try {
      const result = await suspendDelinquentSubscription(supabase, row, now);
      processed.push(result);
    } catch (err) {
      failures.push({ subscription_id: String(row.id), message: err instanceof Error ? err.message : String(err) });
      logBillingError("billing", "process_overdue_failed", err, { subscription_id: row.id });
    }
  }

  return {
    scanned: dueRows.length,
    selected: selected.length,
    processed_count: processed.length,
    failed_count: failures.length,
    processed,
    failures,
  };
}
