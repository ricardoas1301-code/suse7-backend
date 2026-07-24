// ======================================================================
// Alertas internos D-3/D-2/D-1/EXPIRED do trial (S1.HF.6.9A.11)
// Somente Central de Notificações IN_APP — sem Asaas / e-mail / SMS / WhatsApp.
// ======================================================================

import { logBilling } from "../billingLog.js";
import { S7_NOTIFICATION_CATEGORY } from "../../domain/notifications/central/constants/categories.js";
import { S7_NOTIFICATION_CHANNEL } from "../../domain/notifications/central/constants/channels.js";
import { publishNotificationEvent } from "../../domain/notifications/central/events/publishNotificationEvent.js";
import {
  BILLING_TRIAL_ALERT_KIND,
  BILLING_TRIAL_ACCESS_OWNER,
  buildTrialAlertIdempotencyKey,
  resolveTrialLifecyclePresentation,
  resolveTrialLifecycleState,
} from "./billingTrialLifecycleService.js";
import { BILLING_TRIAL_LIFECYCLE_STATE } from "../billingConstants.js";

/** @type {Record<string, string>} */
const ALERT_KIND_TO_TYPE = {
  [BILLING_TRIAL_ALERT_KIND.D3]: "TRIAL_ENDING_D3",
  [BILLING_TRIAL_ALERT_KIND.D2]: "TRIAL_ENDING_D2",
  [BILLING_TRIAL_ALERT_KIND.D1]: "TRIAL_ENDING_D1",
  [BILLING_TRIAL_ALERT_KIND.EXPIRED]: "TRIAL_EXPIRED",
};

/** @type {Record<string, string>} */
const ALERT_KIND_TO_LOG = {
  [BILLING_TRIAL_ALERT_KIND.D3]: "TRIAL_D3_NOTIFICATION_CREATED",
  [BILLING_TRIAL_ALERT_KIND.D2]: "TRIAL_D2_NOTIFICATION_CREATED",
  [BILLING_TRIAL_ALERT_KIND.D1]: "TRIAL_D1_NOTIFICATION_CREATED",
  [BILLING_TRIAL_ALERT_KIND.EXPIRED]: "TRIAL_EXPIRED_NOTIFICATION_CREATED",
};

/**
 * Publica alerta interno idempotente para o estado atual do trial.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   metadata?: Record<string, unknown> | null;
 *   now?: Date;
 *   paid_confirmed?: boolean;
 *   canonical_subscription_active?: boolean;
 *   subscription_id?: string | null;
 *   correlation_id?: string | null;
 * }} input
 */
export async function publishTrialLifecycleAlertIfNeeded(supabase, input) {
  const userId = String(input.userId ?? "").trim();
  if (!userId) return { ok: false, error: "MISSING_USER" };

  const lifecycle = resolveTrialLifecycleState({
    metadata: input.metadata,
    now: input.now,
    paid_confirmed: input.paid_confirmed,
    canonical_subscription_active: input.canonical_subscription_active,
  });

  logBilling("billing", "TRIAL_STATE_EVALUATED", {
    user_id: userId,
    subscription_id: input.subscription_id ?? null,
    lifecycle_state: lifecycle.lifecycle_state,
    trial_ends_at: lifecycle.trial_ends_at,
    trial_days_remaining: lifecycle.trial_days_remaining,
    access_owner: lifecycle.access_owner,
    access_reason: lifecycle.access_reason,
    correlation_id: input.correlation_id ?? null,
  });

  if (lifecycle.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.PAID_ACTIVE) {
    logBilling("billing", "TRIAL_NOTIFICATION_SKIPPED_PAID_ACTIVE", {
      user_id: userId,
      subscription_id: input.subscription_id ?? null,
      trial_ends_at: lifecycle.trial_ends_at,
      correlation_id: input.correlation_id ?? null,
    });
    return { ok: true, skipped: true, reason: "PAID_ACTIVE", lifecycle };
  }

  if (!lifecycle.allow_trial_alerts || !lifecycle.alert_kind) {
    return { ok: true, skipped: true, reason: "NO_ALERT_FOR_STATE", lifecycle };
  }

  const type = ALERT_KIND_TO_TYPE[lifecycle.alert_kind];
  if (!type) return { ok: true, skipped: true, reason: "UNKNOWN_ALERT_KIND", lifecycle };

  const presentation = resolveTrialLifecyclePresentation(lifecycle.warning_key);
  const idempotencyKey = buildTrialAlertIdempotencyKey(
    userId,
    lifecycle.trial_end_date ?? lifecycle.trial_ends_at,
    lifecycle.alert_kind,
  );

  // Ledger atômico (multi-instância) — unique (user_id, trial_end_civil, kind).
  // Complementa s7_notification_events_seller_idempotency_uq.
  try {
    const {
      alertKindToTransitionKind,
      applyTrialLifecycleTransitionAtomic,
    } = await import("./billingTrialLifecycleAtomicService.js");
    const transitionKind = alertKindToTransitionKind(lifecycle.alert_kind);
    if (transitionKind && lifecycle.trial_end_date) {
      const claim = await applyTrialLifecycleTransitionAtomic(supabase, {
        userId,
        kind: transitionKind,
        trialEndCivil: String(lifecycle.trial_end_date),
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
      // rpc_missing: segue para unique da s7_notification_events (já persistente).
    }
  } catch {
    /* fail-open para claim de alerta quando RPC ausente — unique DB cobre */
  }

  try {
    const published = await publishNotificationEvent(supabase, {
      category: S7_NOTIFICATION_CATEGORY.BILLING,
      type,
      seller_id: userId,
      severity: lifecycle.alert_kind === BILLING_TRIAL_ALERT_KIND.EXPIRED ? "warning" : "info",
      payload: {
        title: presentation?.title ?? null,
        message: presentation?.message ?? null,
        cta_label: presentation?.ctaLabel ?? null,
        deep_link: presentation?.ctaPath ?? "/perfil/assinatura",
        trial_lifecycle_state: lifecycle.lifecycle_state,
        trial_days_remaining: lifecycle.trial_days_remaining,
        trial_ends_at: lifecycle.trial_ends_at,
        access_owner: BILLING_TRIAL_ACCESS_OWNER.TRIAL_LIFECYCLE_ENGINE,
      },
      correlation_id: input.correlation_id ?? null,
      idempotency_key: idempotencyKey,
      entity_type: "billing_trial",
      entity_id: lifecycle.trial_end_date ?? null,
      source_module: "billing_trial_lifecycle",
      source_event: type,
      dispatch_options: {
        // Somente IN_APP — sem canais externos.
        channels_filter: [S7_NOTIFICATION_CHANNEL.IN_APP],
      },
    });

    if (!published.ok) {
      logBilling("billing", "TRIAL_TRANSITION_FAILED", {
        user_id: userId,
        reason: published.error ?? "publish_failed",
        alert_kind: lifecycle.alert_kind,
        correlation_id: input.correlation_id ?? null,
      });
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

    logBilling("billing", ALERT_KIND_TO_LOG[lifecycle.alert_kind] ?? "TRIAL_NOTIFICATION_CREATED", {
      user_id: userId,
      subscription_id: input.subscription_id ?? null,
      trial_ends_at: lifecycle.trial_ends_at,
      access_owner: BILLING_TRIAL_ACCESS_OWNER.TRIAL_LIFECYCLE_ENGINE,
      correlation_id: input.correlation_id ?? null,
      idempotency_key: idempotencyKey,
    });

    return {
      ok: true,
      created: true,
      lifecycle,
      idempotency_key: idempotencyKey,
      event: published.event ?? null,
    };
  } catch (err) {
    logBilling("billing", "TRIAL_TRANSITION_FAILED", {
      user_id: userId,
      reason: err instanceof Error ? err.message : String(err),
      alert_kind: lifecycle.alert_kind,
      correlation_id: input.correlation_id ?? null,
    });
    return { ok: false, error: "PUBLISH_EXCEPTION", lifecycle };
  }
}
