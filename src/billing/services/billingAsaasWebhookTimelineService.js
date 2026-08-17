// ======================================================================
// Fase 3.0.1 — Webhook Asaas → timeline + audit + notifications
// ======================================================================

import { DELINQUENCY_STATUS, RENEWAL_STATUS, SUBSCRIPTION_STATUS } from "../billingConstants.js";
import {
  BILLING_AUDIT_ACTION,
  BILLING_AUDIT_ACTOR,
  BILLING_TIMELINE_EVENT,
  BILLING_TIMELINE_SEVERITY,
  BILLING_TIMELINE_SOURCE,
} from "../billingPhase30Constants.js";
import { logBilling, logBillingError } from "../billingLog.js";
import { recordBillingAuditLog } from "./billingAuditLogService.js";
import { publishBillingCentralNotification } from "./billingCentralNotificationBridge.js";
import { enqueueBillingNotification } from "./billingNotificationCenterService.js";
import { recordBillingTimelineEvent } from "./billingTimelineEventService.js";
import { reconcileOpenRenewalCyclesForSubscription } from "./billingRenewalCycleConsistencyService.js";
import { updateRenewalCycle } from "./billingRenewalCycleRepository.js";
import { isAsaasPaymentConfirmedStatus } from "./billingSubscriptionActivationService.js";
import { ensurePaymentGeneratedTimelineBeforeConfirm } from "./billingWebhookReconcileService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {string} providerEventId
 * @param {string} timelineEventType
 * @param {string} [paymentId]
 */
function buildTimelineIdempotencyKey(providerEventId, timelineEventType, paymentId) {
  const pay = paymentId ? `:pay:${paymentId}` : "";
  return `asaas:${providerEventId}:${timelineEventType}${pay}`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   subscriptionId: string | null;
 *   paymentId?: string | null;
 *   providerPaymentId?: string | null;
 *   renewalCycleId?: string | null;
 *   providerEventId: string;
 *   asaasEventType: string;
 *   timelineEventType: string;
 *   title: string;
 *   summary?: string;
 *   severity?: string;
 *   auditAction?: string;
 *   beforeState?: Record<string, unknown> | null;
 *   afterState?: Record<string, unknown> | null;
 *   payload?: Record<string, unknown>;
 *   notificationTemplateKey?: string | null;
 *   notificationVariables?: Record<string, unknown>;
 * }} input
 */
async function emitWebhookFinancialSignal(supabase, input) {
  if (!input.userId) return null;

  const idempotencyKey = buildTimelineIdempotencyKey(
    input.providerEventId,
    input.timelineEventType,
    input.providerPaymentId ?? undefined
  );

  const timeline = await recordBillingTimelineEvent(supabase, {
    userId: input.userId,
    subscriptionId: input.subscriptionId,
    paymentId: input.paymentId ?? null,
    renewalCycleId: input.renewalCycleId ?? null,
    eventType: input.timelineEventType,
    title: input.title,
    summary: input.summary ?? null,
    severity: input.severity ?? BILLING_TIMELINE_SEVERITY.INFO,
    eventSource: BILLING_TIMELINE_SOURCE.WEBHOOK,
    payload: {
      asaas_event_type: input.asaasEventType,
      provider_payment_id: input.providerPaymentId ?? null,
      ...(input.payload ?? {}),
    },
    idempotencyKey,
    correlationId: input.providerEventId,
  });

  if (input.auditAction) {
    await recordBillingAuditLog(supabase, {
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      paymentId: input.paymentId ?? null,
      renewalCycleId: input.renewalCycleId ?? null,
      action: input.auditAction,
      actorType: BILLING_AUDIT_ACTOR.WEBHOOK,
      actorId: "asaas",
      entityType: "billing_payment",
      entityId: input.paymentId ?? input.providerPaymentId ?? input.subscriptionId,
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
      source: "asaas_webhook",
      correlationId: input.providerEventId,
      metadata: { asaas_event_type: input.asaasEventType },
    });
  }

  if (input.notificationTemplateKey) {
    try {
      await enqueueBillingNotification(supabase, {
        userId: input.userId,
        templateKey: input.notificationTemplateKey,
        subscriptionId: input.subscriptionId,
        timelineEventId: timeline?.id != null ? String(timeline.id) : null,
        variables: input.notificationVariables ?? {},
        correlationId: input.providerEventId,
      });
    } catch (notifyErr) {
      logBillingError("billing", "webhook_notification_dispatch_failed", notifyErr, {
        user_id: input.userId,
        template_key: input.notificationTemplateKey,
      });
    }
  }

  if (!input.notificationTemplateKey) {
    try {
      await publishBillingCentralNotification(supabase, {
        userId: input.userId,
        timelineEventType: input.timelineEventType,
        variables: input.notificationVariables ?? {},
        correlationId: input.providerEventId,
        idempotencyKey,
        subscriptionId: input.subscriptionId,
        timelineEventId: timeline?.id != null ? String(timeline.id) : null,
      });
    } catch (centralErr) {
      logBillingError("billing", "webhook_central_notification_failed", centralErr, {
        user_id: input.userId,
        timeline_event_type: input.timelineEventType,
      });
    }
  }

  return timeline;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {string} providerPaymentId
 * @param {string | null} billingPaymentId
 */
async function tryMarkRenewalCyclePaidFromPayment(supabase, subscriptionId, providerPaymentId, billingPaymentId) {
  const { canonicalCycle } = await reconcileOpenRenewalCyclesForSubscription(supabase, subscriptionId, {
    reason: "webhook_payment_confirmed",
  });
  if (!canonicalCycle?.id) return null;

  const cyclePaymentId = canonicalCycle.generated_payment_id != null ? String(canonicalCycle.generated_payment_id) : null;
  const cycleProviderPay = asTrimmedString(canonicalCycle.provider_payment_id);
  const matches =
    (billingPaymentId && cyclePaymentId && cyclePaymentId === billingPaymentId) ||
    (providerPaymentId && cycleProviderPay && cycleProviderPay === providerPaymentId);

  if (!matches) return null;

  const oldStatus = String(canonicalCycle.renewal_status);
  if (oldStatus === RENEWAL_STATUS.PAID) {
    return { cycle: canonicalCycle, alreadyPaid: true };
  }

  const updated = await updateRenewalCycle(supabase, String(canonicalCycle.id), {
    renewal_status: RENEWAL_STATUS.PAID,
    provider_payment_id: providerPaymentId,
    ...(billingPaymentId ? { generated_payment_id: billingPaymentId } : {}),
  });

  return { cycle: updated, alreadyPaid: false, oldStatus };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string | null} providerPaymentId
 */
async function loadBillingPaymentByProviderId(supabase, providerPaymentId) {
  if (!providerPaymentId) return null;
  const { data, error } = await supabase
    .from("billing_payments")
    .select("id, user_id, subscription_id, status, amount, provider_payment_id")
    .eq("provider", "asaas")
    .eq("provider_payment_id", providerPaymentId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Emite sinais Fase 3.0 após processamento do webhook (idempotente via timeline key).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {ReturnType<import("../providers/asaas/asaasEventNormalizer.js").normalizeAsaasWebhook>} norm
 * @param {{
 *   userId: string | null;
 *   subscriptionId: string | null;
 *   providerEventId: string;
 *   subscriptionBefore?: Record<string, unknown> | null;
 *   activationResult?: { activated?: boolean; idempotent?: boolean; subscription_id?: string } | null;
 * }} ctx
 */
export async function emitAsaasWebhookPhase30Signals(supabase, norm, ctx) {
  const userId = ctx.userId;
  const subscriptionId = ctx.subscriptionId;
  const providerEventId = ctx.providerEventId;

  if (!userId || !norm.eventType) return;

  const paymentId = norm.paymentId ?? null;
  const billingPayment = paymentId ? await loadBillingPaymentByProviderId(supabase, paymentId) : null;
  const billingPaymentRowId = billingPayment?.id != null ? String(billingPayment.id) : null;
  const resolvedSubscriptionId = subscriptionId ?? (billingPayment?.subscription_id != null ? String(billingPayment.subscription_id) : null);

  const planKey = asTrimmedString(
    (ctx.subscriptionBefore && typeof ctx.subscriptionBefore === "object" ? ctx.subscriptionBefore.plan_key : null) ??
      billingPayment?.plan_key
  );

  const basePayload = {
    provider_event_id: providerEventId,
    provider_payment_id: paymentId,
    billing_payment_id: billingPaymentRowId,
    subscription_id: resolvedSubscriptionId,
  };

  const eventType = String(norm.eventType).toUpperCase();

  if (eventType === "PAYMENT_CREATED" || eventType === "PAYMENT_UPDATED") {
    await emitWebhookFinancialSignal(supabase, {
      userId,
      subscriptionId: resolvedSubscriptionId,
      paymentId: billingPaymentRowId,
      providerPaymentId: paymentId,
      providerEventId,
      asaasEventType: eventType,
      timelineEventType: BILLING_TIMELINE_EVENT.PAYMENT_GENERATED,
      title: "Cobrança gerada",
      summary: "Uma nova cobrança foi registrada no Asaas.",
      severity: BILLING_TIMELINE_SEVERITY.INFO,
      auditAction: BILLING_AUDIT_ACTION.PAYMENT_CREATED,
      afterState: {
        status: billingPayment?.status ?? norm.payment?.status ?? null,
        amount: billingPayment?.amount ?? norm.payment?.value ?? null,
      },
      payload: basePayload,
      notificationTemplateKey: "payment.generated",
      notificationVariables: { plan_name: planKey ?? "seu plano", amount: billingPayment?.amount ?? "" },
    });
    return;
  }

  if (eventType === "PAYMENT_OVERDUE") {
    await emitWebhookFinancialSignal(supabase, {
      userId,
      subscriptionId: resolvedSubscriptionId,
      paymentId: billingPaymentRowId,
      providerPaymentId: paymentId,
      providerEventId,
      asaasEventType: eventType,
      timelineEventType: BILLING_TIMELINE_EVENT.PAYMENT_FAILED,
      title: "Pagamento em atraso",
      summary: "A cobrança venceu sem confirmação de pagamento.",
      severity: BILLING_TIMELINE_SEVERITY.WARNING,
      auditAction: BILLING_AUDIT_ACTION.PAYMENT_STATUS_CHANGED,
      beforeState: ctx.subscriptionBefore ? { status: ctx.subscriptionBefore.status } : null,
      afterState: { payment_status: "OVERDUE" },
      payload: basePayload,
      notificationTemplateKey: "payment.failed",
      notificationVariables: { plan_name: planKey ?? "seu plano" },
    });
    return;
  }

  if (eventType !== "PAYMENT_RECEIVED" && eventType !== "PAYMENT_CONFIRMED") {
    return;
  }

  const remoteStatus = norm.payment ? String(norm.payment.status || "").toUpperCase() : "";
  if (!isAsaasPaymentConfirmedStatus(remoteStatus) && eventType !== "PAYMENT_CONFIRMED" && eventType !== "PAYMENT_RECEIVED") {
    return;
  }

  const subBefore = ctx.subscriptionBefore;
  const beforeStatus = subBefore ? String(subBefore.status || "").toLowerCase() : null;
  const beforeDelinquency =
    subBefore?.metadata && typeof subBefore.metadata === "object"
      ? String(/** @type {Record<string, unknown>} */ (subBefore.metadata).delinquency_status || "none").toLowerCase()
      : "none";

  if (paymentId) {
    await ensurePaymentGeneratedTimelineBeforeConfirm(supabase, {
      userId,
      subscriptionId: resolvedSubscriptionId,
      paymentId: billingPaymentRowId,
      providerPaymentId: paymentId,
      providerEventId,
    });
  }

  await emitWebhookFinancialSignal(supabase, {
    userId,
    subscriptionId: resolvedSubscriptionId,
    paymentId: billingPaymentRowId,
    providerPaymentId: paymentId,
    providerEventId,
    asaasEventType: eventType,
    timelineEventType: BILLING_TIMELINE_EVENT.PAYMENT_CONFIRMED,
    title: "Pagamento confirmado",
    summary: "Pagamento confirmado pelo Asaas.",
    severity: BILLING_TIMELINE_SEVERITY.INFO,
    auditAction: BILLING_AUDIT_ACTION.PAYMENT_STATUS_CHANGED,
    beforeState: {
      subscription_status: beforeStatus,
      payment_status: billingPayment?.status ?? null,
    },
    afterState: {
      subscription_status: SUBSCRIPTION_STATUS.ACTIVE,
      payment_status: "CONFIRMED",
    },
    payload: basePayload,
    notificationTemplateKey: "payment.confirmed",
    notificationVariables: { plan_name: planKey ?? "seu plano" },
  });

  const wasDelinquent =
    beforeStatus === SUBSCRIPTION_STATUS.PAST_DUE ||
    beforeDelinquency === DELINQUENCY_STATUS.SUSPENDED ||
    beforeDelinquency === DELINQUENCY_STATUS.GRACE;

  if (wasDelinquent) {
    await emitWebhookFinancialSignal(supabase, {
      userId,
      subscriptionId: resolvedSubscriptionId,
      paymentId: billingPaymentRowId,
      providerPaymentId: paymentId,
      providerEventId,
      asaasEventType: eventType,
      timelineEventType: BILLING_TIMELINE_EVENT.REACTIVATED,
      title: "Assinatura reativada",
      summary: "Acesso regularizado após confirmação do pagamento.",
      severity: BILLING_TIMELINE_SEVERITY.INFO,
      auditAction: BILLING_AUDIT_ACTION.SUBSCRIPTION_STATUS_CHANGED,
      beforeState: { subscription_status: beforeStatus, delinquency_status: beforeDelinquency },
      afterState: { subscription_status: SUBSCRIPTION_STATUS.ACTIVE, delinquency_status: DELINQUENCY_STATUS.NONE },
      payload: basePayload,
    });
  }

  if (resolvedSubscriptionId && paymentId) {
    const renewalResult = await tryMarkRenewalCyclePaidFromPayment(
      supabase,
      resolvedSubscriptionId,
      paymentId,
      billingPaymentRowId
    );
    if (renewalResult?.cycle && !renewalResult.alreadyPaid) {
      await emitWebhookFinancialSignal(supabase, {
        userId,
        subscriptionId: resolvedSubscriptionId,
        paymentId: billingPaymentRowId,
        providerPaymentId: paymentId,
        renewalCycleId: String(renewalResult.cycle.id),
        providerEventId,
        asaasEventType: eventType,
        timelineEventType: BILLING_TIMELINE_EVENT.RENEWAL_COMPLETED,
        title: "Renovação concluída",
        summary: "Ciclo de renovação quitado com pagamento confirmado.",
        severity: BILLING_TIMELINE_SEVERITY.INFO,
        auditAction: BILLING_AUDIT_ACTION.RENEWAL_CYCLE_STATUS_CHANGED,
        beforeState: { renewal_status: renewalResult.oldStatus ?? null },
        afterState: { renewal_status: RENEWAL_STATUS.PAID },
        payload: { ...basePayload, renewal_cycle_id: renewalResult.cycle.id },
      });
    }
  }

  logBilling("billing", "S7_BILLING_WEBHOOK_PHASE30_SIGNALS", {
    user_id: userId,
    subscription_id: resolvedSubscriptionId,
    provider_event_id: providerEventId,
    asaas_event_type: eventType,
  });
}
