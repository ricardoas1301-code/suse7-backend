// =============================================================================
// Cria item na outbox WhatsApp — idempotente por dispatch_id
// =============================================================================

import { logWhatsAppNotification } from "./whatsappLog.js";
import { S7_WHATSAPP_OUTBOX_STATUS } from "./whatsappOutboxStatus.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   dispatchId: string;
 *   recipientId?: string | null;
 *   recipientPhone: string;
 *   messageText: string;
 *   metadata?: Record<string, unknown>;
 * }} input
 */
export async function createWhatsAppOutboxEntry(supabase, input) {
  const dispatchId = String(input.dispatchId ?? "").trim();
  const phone = String(input.recipientPhone ?? "").replace(/\D/g, "");

  if (!dispatchId || phone.length < 10) {
    return { ok: false, error: "INVALID_INPUT" };
  }

  const { data: existing, error: exErr } = await supabase
    .from("s7_notification_whatsapp_outbox")
    .select("id, status")
    .eq("dispatch_id", dispatchId)
    .maybeSingle();

  if (exErr && exErr.code !== "42P01" && exErr.code !== "PGRST205") throw exErr;
  if (existing?.id) {
    logWhatsAppNotification("SKIPPED", { reason: "duplicate_dispatch", dispatch_id: dispatchId });
    return { ok: true, idempotent: true, outboxId: String(existing.id), status: existing.status };
  }

  const now = new Date().toISOString();
  const row = {
    seller_id: String(input.sellerId),
    dispatch_id: dispatchId,
    recipient_id: input.recipientId ?? null,
    recipient_phone: phone,
    message_text: String(input.messageText ?? ""),
    status: S7_WHATSAPP_OUTBOX_STATUS.PENDING,
    attempts: 0,
    scheduled_at: now,
    created_at: now,
    updated_at: now,
    metadata: input.metadata ?? {},
  };

  const { data, error } = await supabase
    .from("s7_notification_whatsapp_outbox")
    .insert(row)
    .select("id, status")
    .single();

  if (error) {
    if (error.code === "23505") {
      logWhatsAppNotification("SKIPPED", { reason: "unique_violation", dispatch_id: dispatchId });
      return { ok: true, idempotent: true };
    }
    if (error.code === "42P01" || error.code === "PGRST205") {
      logWhatsAppNotification("SKIPPED", { reason: "outbox_table_missing", dispatch_id: dispatchId });
      return { ok: false, error: "OUTBOX_TABLE_MISSING" };
    }
    throw error;
  }

  logWhatsAppNotification("OUTBOX_CREATED", {
    outbox_id: data?.id,
    dispatch_id: dispatchId,
    seller_id: input.sellerId,
  });

  return { ok: true, outboxId: data?.id != null ? String(data.id) : null, status: data?.status };
}
