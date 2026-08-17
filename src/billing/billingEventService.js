// ======================================================================
// billingEventService — persistência e idempotência de eventos financeiros
// ======================================================================

import { logBilling, logBillingError } from "./billingLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   provider: string;
 *   providerEventId: string;
 *   eventType: string | null;
 *   rawPayload: Record<string, unknown>;
 * }} input
 * @returns {Promise<{ duplicate: boolean; eventId: string | null }>}
 */
export async function recordBillingEvent(supabase, input) {
  const { provider, providerEventId, eventType, rawPayload } = input;
  const insertRow = {
    provider,
    provider_event_id: providerEventId,
    event_type: eventType,
    raw_payload: rawPayload,
    processing_status: "received",
  };

  const { data: inserted, error: insErr } = await supabase
    .from("billing_events")
    .insert(insertRow)
    .select("id")
    .maybeSingle();

  const dup =
    insErr &&
    (insErr.code === "23505" ||
      String(insErr.message || "")
        .toLowerCase()
        .includes("duplicate"));
  if (dup) {
    logBilling("webhook", "duplicate_ignored", { provider_event_id: providerEventId });
    return { duplicate: true, eventId: null };
  }
  if (insErr) {
    logBillingError("webhook", "insert_billing_event_failed", insErr, { provider_event_id: providerEventId });
    throw insErr;
  }

  const eventId =
    inserted && typeof inserted === "object" && "id" in inserted && inserted.id != null
      ? String(/** @type {{ id: unknown }} */ (inserted).id)
      : null;
  return { duplicate: false, eventId };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} eventId
 * @param {{ status: "processed" | "failed"; error?: string | null }} outcome
 */
export async function finalizeBillingEvent(supabase, eventId, outcome) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("billing_events")
    .update({
      processing_status: outcome.status,
      processing_error: outcome.error ?? null,
      processed_at: now,
    })
    .eq("id", eventId);
  if (error) {
    logBillingError("webhook", "finalize_billing_event_failed", error, { event_id: eventId });
  }
}
