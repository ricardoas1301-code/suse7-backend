// ======================================================================
// Audit logs financeiros — imutável (Fase 3.0)
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { BILLING_PHASE30_LOG } from "../billingPhase30Constants.js";
import { sanitizeBillingAuditValue } from "../utils/billingAuditSanitize.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId?: string | null;
 *   action: string;
 *   actorType?: string;
 *   actorId?: string | null;
 *   entityType?: string | null;
 *   entityId?: string | null;
 *   subscriptionId?: string | null;
 *   paymentId?: string | null;
 *   renewalCycleId?: string | null;
 *   beforeState?: Record<string, unknown> | null;
 *   afterState?: Record<string, unknown> | null;
 *   source?: string;
 *   correlationId?: string | null;
 *   requestId?: string | null;
 *   metadata?: Record<string, unknown>;
 * }} input
 */
export async function recordBillingAuditLog(supabase, input) {
  const row = {
    user_id: input.userId ?? null,
    subscription_id: input.subscriptionId ?? null,
    payment_id: input.paymentId ?? null,
    renewal_cycle_id: input.renewalCycleId ?? null,
    actor_type: input.actorType ?? "system",
    actor_id: input.actorId ?? null,
    action: input.action,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    before_state: input.beforeState != null ? sanitizeBillingAuditValue(input.beforeState) : null,
    after_state: input.afterState != null ? sanitizeBillingAuditValue(input.afterState) : null,
    source: input.source ?? "billing",
    correlation_id: input.correlationId ?? null,
    request_id: input.requestId ?? null,
    metadata: sanitizeBillingAuditValue(input.metadata ?? {}),
  };

  const { data, error } = await supabase.from("billing_audit_logs").insert(row).select("id").single();
  if (error) {
    logBillingError("billing", "audit_log_insert_failed", error, {
      user_id: input.userId,
      action: input.action,
    });
    throw error;
  }

  logBilling("billing", BILLING_PHASE30_LOG.AUDIT_RECORDED, {
    audit_log_id: data.id,
    user_id: input.userId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
  });

  return data;
}
