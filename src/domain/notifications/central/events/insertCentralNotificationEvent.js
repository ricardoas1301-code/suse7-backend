// =============================================================================
// Persistência append-only — s7_notification_events
// =============================================================================

import { logCentralNotification } from "../observability/centralNotificationLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   category: string;
 *   type: string;
 *   severity?: string;
 *   payload?: Record<string, unknown>;
 *   correlationId?: string | null;
 *   idempotencyKey: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   sellerCompanyId?: string | null;
 *   entityType?: string | null;
 *   entityId?: string | null;
 *   sourceModule?: string | null;
 * }} input
 */
export async function insertCentralNotificationEvent(supabase, input) {
  const { data: existing, error: findErr } = await supabase
    .from("s7_notification_events")
    .select("*")
    .eq("seller_id", input.sellerId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();

  if (findErr) {
    logCentralNotification("EVENT_INSERT_LOOKUP_ERR", { message: findErr.message });
    return { ok: false, error: findErr.message };
  }

  if (existing) {
    logCentralNotification("EVENT_IDEMPOTENT_HIT", {
      event_id: existing.id,
      seller_id: input.sellerId,
      idempotency_key: input.idempotencyKey,
    });
    return { ok: true, event: existing, idempotent: true };
  }

  const { data, error } = await supabase
    .from("s7_notification_events")
    .insert({
      seller_id: input.sellerId,
      category_code: input.category,
      type_key: input.type,
      severity: input.severity ?? "info",
      payload: input.payload ?? {},
      correlation_id: input.correlationId ?? null,
      idempotency_key: input.idempotencyKey,
      marketplace: input.marketplace ?? null,
      marketplace_account_id: input.marketplaceAccountId ?? null,
      seller_company_id: input.sellerCompanyId ?? null,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      source_module: input.sourceModule ?? null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      const { data: race } = await supabase
        .from("s7_notification_events")
        .select("*")
        .eq("seller_id", input.sellerId)
        .eq("idempotency_key", input.idempotencyKey)
        .maybeSingle();
      if (race) {
        return { ok: true, event: race, idempotent: true };
      }
    }
    logCentralNotification("EVENT_INSERT_FAILED", { message: error.message });
    return { ok: false, error: error.message };
  }

  logCentralNotification("EVENT_PUBLISHED", {
    event_id: data?.id,
    seller_id: input.sellerId,
    category: input.category,
    type: input.type,
    correlation_id: input.correlationId,
  });

  return { ok: true, event: data, idempotent: false };
}
