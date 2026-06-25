// ======================================================================
// Integração Fase 3.0 — timeline + audit + notifications (pontos do domínio)
// ======================================================================

import {
  BILLING_AUDIT_ACTION,
  BILLING_AUDIT_ACTOR,
  BILLING_TIMELINE_EVENT,
  BILLING_TIMELINE_SEVERITY,
  BILLING_TIMELINE_SOURCE,
} from "../billingPhase30Constants.js";
import { recordBillingAuditLog } from "./billingAuditLogService.js";
import { dispatchRenewalNotificationFromHook } from "./billingNotificationCenterService.js";
import { recordBillingTimelineEvent } from "./billingTimelineEventService.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   subscriptionId: string;
 *   renewalCycleId?: string | null;
 *   eventType: string;
 *   title: string;
 *   summary?: string;
 *   severity?: string;
 *   source?: string;
 *   payload?: Record<string, unknown>;
 *   idempotencyKey?: string;
 *   correlationId?: string | null;
 *   requestId?: string | null;
 *   auditAction?: string;
 *   beforeState?: Record<string, unknown> | null;
 *   afterState?: Record<string, unknown> | null;
 *   renewalHookType?: string | null;
 *   notificationVariables?: Record<string, unknown>;
 * }} input
 */
export async function emitBillingFinancialSignal(supabase, input) {
  const timeline = await recordBillingTimelineEvent(supabase, {
    userId: input.userId,
    subscriptionId: input.subscriptionId,
    renewalCycleId: input.renewalCycleId ?? null,
    eventType: input.eventType,
    title: input.title,
    summary: input.summary ?? null,
    severity: input.severity ?? BILLING_TIMELINE_SEVERITY.INFO,
    eventSource: input.source ?? BILLING_TIMELINE_SOURCE.ENGINE,
    payload: input.payload ?? {},
    idempotencyKey: input.idempotencyKey ?? null,
    correlationId: input.correlationId ?? null,
    requestId: input.requestId ?? null,
  });

  if (input.auditAction) {
    await recordBillingAuditLog(supabase, {
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      renewalCycleId: input.renewalCycleId ?? null,
      action: input.auditAction,
      actorType: BILLING_AUDIT_ACTOR.SYSTEM,
      entityType: "billing_renewal_cycle",
      entityId: input.renewalCycleId ?? input.subscriptionId,
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
      source: input.source ?? "billing_engine",
      correlationId: input.correlationId ?? null,
      requestId: input.requestId ?? null,
    });
  }

  if (input.renewalHookType) {
    await dispatchRenewalNotificationFromHook(supabase, input.renewalHookType, {
      user_id: input.userId,
      subscription_id: input.subscriptionId,
      renewal_cycle_id: input.renewalCycleId,
      timeline_event_id: timeline?.id,
      ...(input.notificationVariables ?? {}),
      correlation_id: input.correlationId,
      request_id: input.requestId,
    });
  }

  return timeline;
}

export {
  BILLING_TIMELINE_EVENT,
  BILLING_TIMELINE_SEVERITY,
  BILLING_TIMELINE_SOURCE,
  BILLING_AUDIT_ACTION,
  BILLING_AUDIT_ACTOR,
};
