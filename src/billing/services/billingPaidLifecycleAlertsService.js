// ======================================================================
// Alertas IN_APP do ciclo pago (S1.HF.6.9A.12)
// Somente Central de Notificações — sem Asaas / e-mail / SMS / WhatsApp.
// ======================================================================

import { logBilling } from "../billingLog.js";
import { S7_NOTIFICATION_CATEGORY } from "../../domain/notifications/central/constants/categories.js";
import { S7_NOTIFICATION_CHANNEL } from "../../domain/notifications/central/constants/channels.js";
import { publishNotificationEvent } from "../../domain/notifications/central/events/publishNotificationEvent.js";
import {
  BILLING_PAID_ALERT_KIND,
  buildPaidLifecycleAlertIdempotencyKey,
  resolvePaidAlertKindForLifecycle,
  resolvePaidLifecyclePresentation,
  resolvePaidLifecycleState,
} from "./billingPaidLifecycleService.js";
import { resolvePaidCivilCycleClock } from "./billingPaidCivilCycleService.js";
import {
  applyPaidLifecycleTransitionAtomic,
  BILLING_PAID_TRANSITION_KIND,
} from "./billingPaidLifecycleAtomicService.js";

/** @type {Record<string, string>} */
const ALERT_KIND_TO_TYPE = {
  [BILLING_PAID_ALERT_KIND.RENEWAL_AVAILABLE]: "RENEWAL_AVAILABLE",
  [BILLING_PAID_ALERT_KIND.PAYMENT_PENDING]: "PAYMENT_PENDING",
  [BILLING_PAID_ALERT_KIND.PAYMENT_CONFIRMED]: "PAYMENT_CONFIRMED",
  [BILLING_PAID_ALERT_KIND.PAYMENT_DUE]: "PAYMENT_DUE",
  [BILLING_PAID_ALERT_KIND.ENTERED_GRACE]: "ENTERED_GRACE",
  [BILLING_PAID_ALERT_KIND.GRACE_LAST_DAY]: "GRACE_LAST_DAY",
  [BILLING_PAID_ALERT_KIND.SUSPENDED]: "SUSPENDED",
  [BILLING_PAID_ALERT_KIND.BABY_FALLBACK_ACTIVATED]: "BABY_FALLBACK_ACTIVATED",
  [BILLING_PAID_ALERT_KIND.REACTIVATED]: "REACTIVATED",
  [BILLING_PAID_ALERT_KIND.PAYMENT_FAILED]: "PAYMENT_FAILED",
};

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   subscription: Record<string, unknown>;
 *   openCycle?: Record<string, unknown> | null;
 *   now?: Date;
 *   payment_pending?: boolean;
 *   payment_confirmed_for_competence?: boolean;
 *   reactivation_checkout_open?: boolean;
 *   usage_restricted?: boolean;
 *   forceAlertKind?: string | null;
 *   correlation_id?: string | null;
 * }} input
 */
export async function publishPaidLifecycleAlertIfNeeded(supabase, input) {
  const userId = String(input.userId ?? "").trim();
  const subscription = input.subscription && typeof input.subscription === "object" ? input.subscription : null;
  if (!userId || !subscription?.id) {
    return { ok: false, error: "MISSING_USER_OR_SUBSCRIPTION" };
  }

  const lifecycle = resolvePaidLifecycleState({
    subscription,
    openCycle: input.openCycle,
    now: input.now,
    payment_pending: input.payment_pending,
    payment_confirmed_for_competence: input.payment_confirmed_for_competence,
    reactivation_checkout_open: input.reactivation_checkout_open,
    usage_restricted: input.usage_restricted,
  });

  const clock =
    lifecycle.clock ??
    resolvePaidCivilCycleClock(subscription, input.now instanceof Date ? input.now : new Date());

  const alertKind =
    input.forceAlertKind ??
    resolvePaidAlertKindForLifecycle(lifecycle.lifecycle_state, {
      days_past_due: clock.days_past_due,
      financial_grace_days: clock.financial_grace_days,
    });

  logBilling("billing", "PAID_STATE_EVALUATED", {
    user_id: userId,
    subscription_id: subscription.id,
    lifecycle_state: lifecycle.lifecycle_state,
    alert_kind: alertKind,
    competence_key: clock.competence_key,
    correlation_id: input.correlation_id ?? null,
  });

  if (!alertKind) {
    return { ok: true, skipped: true, reason: "NO_ALERT_FOR_STATE", lifecycle };
  }

  const type = ALERT_KIND_TO_TYPE[alertKind];
  if (!type) return { ok: true, skipped: true, reason: "UNKNOWN_ALERT_KIND", lifecycle };

  const competenceKey = String(clock.competence_key ?? clock.next_competence_key ?? "unknown");
  const idempotencyKey = buildPaidLifecycleAlertIdempotencyKey(
    userId,
    String(subscription.id),
    competenceKey,
    type,
  );

  try {
    const claim = await applyPaidLifecycleTransitionAtomic(supabase, {
      provider: "suse7_in_app",
      providerEventId: idempotencyKey,
      providerPaymentId: null,
      canonicalSubscriptionId: String(subscription.id),
      competenceKey,
      eventType: `${BILLING_PAID_TRANSITION_KIND.ALERT}:${type}`,
      paidConfirmed: false,
      correlationId: input.correlation_id ?? null,
    });
    if (claim.ok && claim.idempotent) {
      return {
        ok: true,
        created: false,
        idempotent: true,
        lifecycle,
        idempotency_key: idempotencyKey,
        ledger_idempotent: true,
      };
    }
  } catch {
    /* RPC ausente — unique s7_notification_events cobre */
  }

  const presentation =
    lifecycle.presentation ?? resolvePaidLifecyclePresentation(lifecycle.lifecycle_state);

  try {
    const published = await publishNotificationEvent(supabase, {
      category: S7_NOTIFICATION_CATEGORY.BILLING,
      type,
      seller_id: userId,
      severity:
        type === "SUSPENDED" || type === "PAYMENT_FAILED" || type === "GRACE_LAST_DAY"
          ? "warning"
          : "info",
      payload: {
        title: presentation?.title ?? null,
        message: presentation?.message ?? null,
        cta_label: presentation?.ctaLabel ?? null,
        deep_link: presentation?.ctaPath ?? "/perfil/assinatura",
        lifecycle_state: lifecycle.lifecycle_state,
        access_owner: lifecycle.access_owner ?? null,
        competence_key: competenceKey,
        canonical_subscription_id: String(subscription.id),
        external_channels_forbidden: true,
      },
      correlation_id: input.correlation_id ?? null,
      idempotency_key: idempotencyKey,
      entity_type: "billing_paid_lifecycle",
      entity_id: String(subscription.id),
      source_module: "billing_paid_lifecycle",
      source_event: type,
      dispatch_options: {
        channels_filter: [S7_NOTIFICATION_CHANNEL.IN_APP],
      },
    });

    if (!published.ok) {
      return { ok: false, error: published.error ?? "PUBLISH_FAILED", lifecycle };
    }

    if (published.idempotent || published.deduped) {
      return {
        ok: true,
        created: false,
        idempotent: true,
        lifecycle,
        idempotency_key: idempotencyKey,
      };
    }

    logBilling("billing", "PAID_LIFECYCLE_NOTIFICATION_CREATED", {
      user_id: userId,
      subscription_id: subscription.id,
      type,
      idempotency_key: idempotencyKey,
      correlation_id: input.correlation_id ?? null,
    });

    return {
      ok: true,
      created: true,
      lifecycle,
      idempotency_key: idempotencyKey,
      type,
      channel: S7_NOTIFICATION_CHANNEL.IN_APP,
      external_channels: [],
      event: published.event ?? null,
    };
  } catch (err) {
    logBilling("billing", "PAID_TRANSITION_FAILED", {
      user_id: userId,
      reason: err instanceof Error ? err.message : String(err),
      alert_kind: alertKind,
    });
    return { ok: false, error: "PUBLISH_EXCEPTION", lifecycle };
  }
}
