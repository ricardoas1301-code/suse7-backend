// ======================================================================
// subscriptionStateService — aplica eventos Asaas ao estado persistido
// ======================================================================

import { decimalToScale2String, toDecimal } from "./utils/moneyDecimal.js";
import { logBilling, logBillingError } from "./billingLog.js";
import { SUBSCRIPTION_STATUS } from "./billingConstants.js";
import { derivePeriodEndFromNextBilling, startOfUtcDay } from "./services/billingCycleService.js";
import { applyPaymentOverdueDelinquency } from "./services/billingDunningService.js";
import { activateSubscriptionFromPaidPayment } from "./services/billingSubscriptionActivationService.js";
import { emitAsaasWebhookPhase30Signals } from "./services/billingAsaasWebhookTimelineService.js";
/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function extractNestedId(value) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  const obj = asObject(value);
  return obj ? asTrimmedString(obj.id) : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function parseAsaasDate(value) {
  const raw = asTrimmedString(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) {
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function parseAsaasDateOnly(value) {
  const iso = parseAsaasDate(value);
  return iso ? iso.slice(0, 10) : null;
}

/**
 * @param {string | null} nextDueDate
 * @param {unknown} periodStartSource
 */
function buildConfirmedSubscriptionPeriodPatch(nextDueDate, periodStartSource) {
  const nextDue = parseAsaasDateOnly(nextDueDate);
  const periodStart = periodStartSource ? startOfUtcDay(periodStartSource) : null;
  const periodEnd = nextDue ? derivePeriodEndFromNextBilling(nextDue) : null;
  return {
    ...(nextDue ? { next_due_date: nextDue } : {}),
    ...(periodStart ? { current_period_start: periodStart.toISOString() } : {}),
    ...(periodEnd ? { current_period_end: periodEnd.toISOString() } : {}),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} payment
 */
export async function resolveUserAndSubscriptionFromPayment(supabase, payment) {
  const subAsaas = extractNestedId(payment.subscription);
  if (subAsaas) {
    const { data, error } = await supabase
      .from("billing_subscriptions")
      .select("id, user_id")
      .eq("provider", "asaas")
      .eq("provider_subscription_id", subAsaas)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : null;
    if (row?.user_id) {
      return { userId: String(row.user_id), subscriptionId: row.id != null ? String(row.id) : null, providerSubscriptionId: subAsaas };
    }
  }

  const cust = extractNestedId(payment.customer);
  if (!cust) {
    return { userId: null, subscriptionId: null, providerSubscriptionId: subAsaas };
  }

  const { data: bc } = await supabase
    .from("billing_customers")
    .select("user_id")
    .eq("provider", "asaas")
    .eq("provider_customer_id", cust)
    .maybeSingle();
  if (!bc?.user_id) return { userId: null, subscriptionId: null, providerSubscriptionId: subAsaas };

  const { data: sub2Rows, error: sub2Error } = await supabase
    .from("billing_subscriptions")
    .select("id, provider_subscription_id")
    .eq("user_id", bc.user_id)
    .eq("provider", "asaas")
    .order("created_at", { ascending: false })
    .limit(1);
  if (sub2Error) throw sub2Error;
  const sub2 = Array.isArray(sub2Rows) ? sub2Rows[0] : null;

  return {
    userId: String(bc.user_id),
    subscriptionId: sub2?.id != null ? String(sub2.id) : null,
    providerSubscriptionId: subAsaas || (sub2?.provider_subscription_id != null ? String(sub2.provider_subscription_id) : null),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 */
export async function resolveUserAndSubscriptionFromSubscription(supabase, subscription) {
  const subAsaas = asTrimmedString(subscription.id);
  if (subAsaas) {
    const { data, error } = await supabase
      .from("billing_subscriptions")
      .select("id, user_id")
      .eq("provider", "asaas")
      .eq("provider_subscription_id", subAsaas)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : null;
    if (row?.user_id) {
      return { userId: String(row.user_id), subscriptionId: row.id != null ? String(row.id) : null, providerSubscriptionId: subAsaas };
    }
  }

  const cust = extractNestedId(subscription.customer);
  if (!cust) {
    return { userId: null, subscriptionId: null, providerSubscriptionId: subAsaas };
  }

  const { data: bc } = await supabase
    .from("billing_customers")
    .select("user_id")
    .eq("provider", "asaas")
    .eq("provider_customer_id", cust)
    .maybeSingle();
  if (!bc?.user_id) return { userId: null, subscriptionId: null, providerSubscriptionId: subAsaas };

  return { userId: String(bc.user_id), subscriptionId: null, providerSubscriptionId: subAsaas };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} provider
 * @param {Record<string, unknown>} payment
 * @param {string | null} userId
 * @param {string | null} subscriptionId
 * @param {string | null} eventType
 */
export async function upsertBillingPaymentRow(supabase, provider, payment, userId, subscriptionId, eventType) {
  const payId = asTrimmedString(payment.id);
  if (!payId || !userId) return;

  const amount = payment.value != null ? decimalToScale2String(toDecimal(payment.value)) : null;
  const paidAt =
    parseAsaasDate(payment.confirmedDate) ||
    parseAsaasDate(payment.clientPaymentDate) ||
    parseAsaasDate(payment.paymentDate);

  const remoteStatus = String(asTrimmedString(payment.status) || "").toUpperCase();
  const eventTypeUpper = String(eventType || "").toUpperCase();
  const paymentStatus =
    eventTypeUpper === "PAYMENT_RECEIVED" ||
    eventTypeUpper === "PAYMENT_CONFIRMED" ||
    ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"].includes(remoteStatus)
      ? "CONFIRMED"
      : asTrimmedString(payment.status);

  const row = {
    user_id: userId,
    subscription_id: subscriptionId,
    provider,
    provider_payment_id: payId,
    status: paymentStatus,
    amount,
    currency: "BRL",
    event_type_snapshot: eventType,
    paid_at: paidAt,
    raw_payload: payment,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("billing_payments").upsert(row, { onConflict: "provider,provider_payment_id" });
  if (error) {
    logBillingError("webhook", "billing_payments_upsert_failed", error, { provider_payment_id: payId });
    throw error;
  }
}

/**
 * @param {string | null | undefined} remoteStatus
 * @returns {string}
 */
function mapAsaasSubscriptionStatus(remoteStatus) {
  const s = String(remoteStatus || "").toUpperCase();
  if (s === "ACTIVE") return SUBSCRIPTION_STATUS.ACTIVE;
  if (s === "INACTIVE" || s === "DELETED") return SUBSCRIPTION_STATUS.CANCELED;
  if (s === "EXPIRED") return SUBSCRIPTION_STATUS.PAST_DUE;
  return SUBSCRIPTION_STATUS.PENDING;
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
  if (error) {
    logBillingError("webhook", "billing_subscriptions_update_failed", error, { provider_subscription_id: providerSubscriptionId });
    throw error;
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 */
async function loadSubscriptionSnapshotForWebhook(supabase, subscriptionId) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("id, user_id, status, plan_key, metadata")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {ReturnType<import("./providers/asaas/asaasEventNormalizer.js").normalizeAsaasWebhook>} norm
 * @param {{ providerEventId?: string }} [webhookCtx]
 */
export async function applyAsaasWebhookEvent(supabase, norm, webhookCtx = {}) {
  const provider = "asaas";

  if (norm.kind === "payment" && norm.payment && norm.paymentId) {
    const { userId, subscriptionId, providerSubscriptionId } = await resolveUserAndSubscriptionFromPayment(supabase, norm.payment);
    const subscriptionBefore = subscriptionId
      ? await loadSubscriptionSnapshotForWebhook(supabase, subscriptionId)
      : null;

    await upsertBillingPaymentRow(supabase, provider, norm.payment, userId, subscriptionId, norm.eventType);

    const subAsaas = providerSubscriptionId || extractNestedId(norm.payment.subscription);
    if (!subAsaas) {
      logBilling("webhook", "payment_without_subscription_link", { payment_id: norm.paymentId, event_type: norm.eventType });
      try {
        await emitAsaasWebhookPhase30Signals(supabase, norm, {
          userId,
          subscriptionId,
          providerEventId: webhookCtx.providerEventId ?? norm.providerEventId ?? `pay:${norm.paymentId}`,
          subscriptionBefore,
        });
      } catch (phase30Err) {
        logBillingError("webhook", "phase30_signals_failed", phase30Err, { payment_id: norm.paymentId });
      }
      return;
    }

    const nextDueDate = parseAsaasDateOnly(norm.payment.dueDate) || parseAsaasDateOnly(norm.payment.originalDueDate);
    const paidAt =
      parseAsaasDate(norm.payment.confirmedDate) ||
      parseAsaasDate(norm.payment.clientPaymentDate) ||
      parseAsaasDate(norm.payment.paymentDate);
    switch (norm.eventType) {
      case "PAYMENT_RECEIVED":
      case "PAYMENT_CONFIRMED": {
        await activateSubscriptionFromPaidPayment(supabase, {
          userId,
          subscriptionId,
          providerSubscriptionId: subAsaas,
          providerPaymentId: norm.paymentId,
          nextDueDate,
          paidAt: paidAt || new Date().toISOString(),
          source: `webhook:${norm.eventType}`,
        });
        break;
      }
      case "PAYMENT_OVERDUE": {
        await applyPaymentOverdueDelinquency(supabase, {
          providerSubscriptionId: subAsaas,
          paymentId: norm.paymentId,
          nextDueDate,
        });
        break;
      }
      case "PAYMENT_REFUNDED": {
        await updateSubscriptionByProviderId(supabase, subAsaas, { status: SUBSCRIPTION_STATUS.REFUNDED });
        break;
      }
      case "PAYMENT_DELETED":
        break;
      case "PAYMENT_CREATED":
      case "PAYMENT_UPDATED":
      default:
        if (nextDueDate) {
          await updateSubscriptionByProviderId(supabase, subAsaas, { next_due_date: nextDueDate });
        }
        break;
    }

    try {
      await emitAsaasWebhookPhase30Signals(supabase, norm, {
        userId,
        subscriptionId,
        providerEventId: webhookCtx.providerEventId ?? norm.providerEventId ?? `pay:${norm.paymentId}`,
        subscriptionBefore,
      });
    } catch (phase30Err) {
      logBillingError("webhook", "phase30_signals_failed", phase30Err, {
        payment_id: norm.paymentId,
        event_type: norm.eventType,
      });
    }
    return;
  }

  if (norm.kind === "subscription" && norm.subscription && norm.subscriptionId) {
    const { providerSubscriptionId } = await resolveUserAndSubscriptionFromSubscription(supabase, norm.subscription);
    const subAsaas = providerSubscriptionId || norm.subscriptionId;
    const remoteStatus = asTrimmedString(norm.subscription.status);
    const nextDueDate = parseAsaasDateOnly(norm.subscription.nextDueDate);

    const patch = {
      ...(nextDueDate ? { next_due_date: nextDueDate } : {}),
    };

    /** Não promover para active só pelo status remoto da assinatura — ativação só via pagamento confirmado. */
    if (norm.eventType === "SUBSCRIPTION_DELETED" || norm.eventType === "SUBSCRIPTION_INACTIVATED") {
      /* handled below */
    } else if (remoteStatus && ["INACTIVE", "DELETED", "EXPIRED"].includes(remoteStatus.toUpperCase())) {
      patch.status = mapAsaasSubscriptionStatus(remoteStatus);
    }

    if (norm.eventType === "SUBSCRIPTION_DELETED" || norm.eventType === "SUBSCRIPTION_INACTIVATED") {
      patch.status = SUBSCRIPTION_STATUS.CANCELED;
      patch.canceled_at = new Date().toISOString();
    }

    await updateSubscriptionByProviderId(supabase, subAsaas, patch);
  }
}
