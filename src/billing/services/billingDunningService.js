// ======================================================================
// Inadimplência — LEGADO NEUTRALIZADO (S1.HF.6.9A.12A)
// Carência financeira SSOT = 10 dias civis (renewal / paid lifecycle).
// Este módulo: leitura + sinalização; NÃO suspende em +3 dias.
// ======================================================================

import {
  BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT,
  DELINQUENCY_STATUS,
} from "../billingConstants.js";
import { logBilling, logBillingError } from "../billingLog.js";
import { confirmCanonicalSubscriptionPayment } from "./billingConfirmCanonicalSubscriptionPaymentService.js";
import { recordBillingEvent } from "../billingEventService.js";

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
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

/**
 * Sempre 10 — ignora env legado que tentaria reabilitar 3 dias.
 */
export function resolveBillingDunningGracePeriodDays() {
  const raw = Number(process.env.BILLING_DUNNING_GRACE_PERIOD_DAYS);
  if (Number.isFinite(raw) && raw === 3) {
    logBilling("billing", "LEGACY_DUNNING_3D_ENV_IGNORED", {
      env_value: raw,
      effective_days: BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT,
    });
  }
  return BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT;
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
    logBillingError("billing", "dunning_event_failed", error, {
      event_type: eventType,
      provider_event_id: providerEventId,
    });
  }
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
 * PAYMENT_OVERDUE — somente sinalização / projeção.
 * NÃO marca PAST_DUE, NÃO inicia grace de 3 dias, NÃO suspende.
 * Suspensão financeira = D11 via billingRenewalEngine (10 dias civis).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   providerSubscriptionId: string;
 *   paymentId?: string | null;
 *   nextDueDate?: string | null;
 *   userId?: string | null;
 *   subscriptionId?: string | null;
 * }} ctx
 */
export async function applyPaymentOverdueDelinquency(supabase, ctx) {
  const now = new Date();
  const graceDays = resolveBillingDunningGracePeriodDays();

  await recordDunningEvent(
    supabase,
    "PAYMENT_OVERDUE_SIGNAL",
    `payment_overdue_signal:${ctx.paymentId ?? ctx.providerSubscriptionId}:${now.toISOString().slice(0, 10)}`,
    {
      provider_subscription_id: ctx.providerSubscriptionId,
      subscription_id: ctx.subscriptionId ?? null,
      user_id: ctx.userId ?? null,
      payment_id: ctx.paymentId ?? null,
      next_due_date: ctx.nextDueDate ?? null,
      financial_grace_days_canonical: graceDays,
      legacy_3d_dunning: false,
      decision_engine: "PAYMENT_DELINQUENCY_ENGINE",
      note: "Sinal overdue não altera entitlement; carência 10d no renewal engine",
    },
  );

  if (ctx.subscriptionId) {
    const { data: sub } = await supabase
      .from("billing_subscriptions")
      .select("id, metadata")
      .eq("id", ctx.subscriptionId)
      .maybeSingle();
    if (sub?.id) {
      const meta = {
        ...(asObject(sub.metadata) ?? {}),
        payment_overdue_signal_at: now.toISOString(),
        payment_overdue_payment_id: ctx.paymentId ?? null,
      };
      await supabase
        .from("billing_subscriptions")
        .update({
          ...(ctx.nextDueDate ? { next_due_date: ctx.nextDueDate } : {}),
          metadata: meta,
          updated_at: now.toISOString(),
        })
        .eq("id", sub.id);
    }
  }

  logBilling("billing", "payment_overdue_signal_only", {
    provider_subscription_id: ctx.providerSubscriptionId,
    subscription_id: ctx.subscriptionId ?? null,
    payment_id: ctx.paymentId ?? null,
    financial_grace_days_canonical: graceDays,
    legacy_dunning_disabled: true,
  });

  return {
    signal_only: true,
    legacy_dunning_disabled: true,
    financial_grace_days_canonical: graceDays,
    subscription_id: ctx.subscriptionId ?? null,
  };
}

/**
 * Recuperação — converge para fachada canônica.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   providerSubscriptionId: string;
 *   paymentId?: string | null;
 *   nextDueDate?: string | null;
 *   paidAt?: string | null;
 *   userId?: string | null;
 *   subscriptionId?: string | null;
 * }} ctx
 */
export async function applyPaymentRecoveryDelinquency(supabase, ctx) {
  let userId = asTrimmedString(ctx.userId);
  let subscriptionId = asTrimmedString(ctx.subscriptionId);

  if (!userId || !subscriptionId) {
    const { data, error } = await supabase
      .from("billing_subscriptions")
      .select("id, user_id")
      .eq("provider", "asaas")
      .eq("provider_subscription_id", ctx.providerSubscriptionId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : null;
    userId = userId ?? (row?.user_id != null ? String(row.user_id) : null);
    subscriptionId = subscriptionId ?? (row?.id != null ? String(row.id) : null);
  }

  if (!userId) {
    return { subscription_id: subscriptionId, recovered: false, reason: "missing_user" };
  }

  const result = await confirmCanonicalSubscriptionPayment(supabase, {
    userId,
    linkedSubscriptionId: subscriptionId,
    providerPaymentId: ctx.paymentId ?? null,
    eventType: "PAYMENT_CONFIRMED",
    paymentStatus: "CONFIRMED",
    nextDueDate: ctx.nextDueDate ?? null,
    paidAt: ctx.paidAt ?? new Date().toISOString(),
    source: "payment_recovery",
  });

  logBilling("billing", "subscription_recovered_via_canonical_facade", {
    subscription_id: result.canonical_subscription_id ?? subscriptionId,
    user_id: userId,
    payment_id: ctx.paymentId ?? null,
    confirmed: Boolean(result.confirmed),
  });

  return {
    subscription_id: result.canonical_subscription_id ?? subscriptionId,
    recovered: Boolean(result.confirmed),
    activated: Boolean(result.activation?.activated),
    facade: result,
  };
}

/**
 * Job legado de suspensão +3d — DESATIVADO.
 * Suspensão canônica: processBillingRenewalEngine (D11 / 10 dias civis).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} _supabase
 * @param {{ now?: Date; limit?: number }} [options]
 */
export async function processBillingOverdues(_supabase, options = {}) {
  logBilling("billing", "LEGACY_DUNNING_OVERDUES_JOB_DISABLED", {
    reason: "S1.HF.6.9A.12A_use_renewal_engine_10d",
    limit: options.limit ?? null,
    redirect: "processBillingRenewalEngine",
  });
  return {
    scanned: 0,
    selected: 0,
    processed_count: 0,
    failed_count: 0,
    processed: [],
    failures: [],
    disabled: true,
    legacy_dunning_disabled: true,
    use_instead: "processBillingRenewalEngine",
  };
}
