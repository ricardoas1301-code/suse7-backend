// ======================================================================
// Timeline financeira — append-only (Fase 3.0)
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { BILLING_PHASE30_LOG } from "../billingPhase30Constants.js";
import { sanitizeBillingAuditValue } from "../utils/billingAuditSanitize.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   eventType: string;
 *   title: string;
 *   summary?: string | null;
 *   severity?: string;
 *   eventSource?: string;
 *   subscriptionId?: string | null;
 *   paymentId?: string | null;
 *   renewalCycleId?: string | null;
 *   sellerCompanyId?: string | null;
 *   payload?: Record<string, unknown>;
 *   idempotencyKey?: string | null;
 *   correlationId?: string | null;
 *   requestId?: string | null;
 *   occurredAt?: string | Date;
 * }} input
 */
export async function recordBillingTimelineEvent(supabase, input) {
  const occurredAt =
    input.occurredAt instanceof Date
      ? input.occurredAt.toISOString()
      : input.occurredAt != null
        ? String(input.occurredAt)
        : new Date().toISOString();

  const row = {
    user_id: input.userId,
    subscription_id: input.subscriptionId ?? null,
    payment_id: input.paymentId ?? null,
    renewal_cycle_id: input.renewalCycleId ?? null,
    seller_company_id: input.sellerCompanyId ?? null,
    event_type: input.eventType,
    event_source: input.eventSource ?? "system",
    severity: input.severity ?? "info",
    title: input.title,
    summary: input.summary ?? null,
    payload: sanitizeBillingAuditValue(input.payload ?? {}),
    idempotency_key: input.idempotencyKey ?? null,
    correlation_id: input.correlationId ?? null,
    request_id: input.requestId ?? null,
    occurred_at: occurredAt,
  };

  const { data, error } = await supabase.from("billing_timeline_events").insert(row).select("*").single();

  if (error) {
    const dup =
      error.code === "23505" &&
      String(error.message || "")
        .toLowerCase()
        .includes("idempotency");
    if (dup && input.idempotencyKey) {
      const { data: existing } = await supabase
        .from("billing_timeline_events")
        .select("*")
        .eq("user_id", input.userId)
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();
      return existing;
    }
    logBillingError("billing", "timeline_event_insert_failed", error, {
      user_id: input.userId,
      event_type: input.eventType,
    });
    throw error;
  }

  logBilling("billing", BILLING_PHASE30_LOG.TIMELINE_RECORDED, {
    user_id: input.userId,
    timeline_event_id: data.id,
    event_type: input.eventType,
    severity: row.severity,
  });

  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ limit?: number; subscriptionId?: string | null }} [options]
 */
export async function listBillingTimelineForUser(supabase, userId, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(100, Number(options.limit))) : 50;

  let query = supabase
    .from("billing_timeline_events")
    .select("*")
    .eq("user_id", userId)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (options.subscriptionId) {
    query = query.eq("subscription_id", options.subscriptionId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}
