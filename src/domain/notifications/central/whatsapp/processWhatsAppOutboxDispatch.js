// =============================================================================
// Processa uma única entrada da outbox WhatsApp por dispatch_id (3.5C.1.A4)
// =============================================================================

import { processWhatsAppOutbox } from "./processWhatsAppOutbox.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} dispatchId
 */
export async function processWhatsAppOutboxDispatch(supabase, dispatchId) {
  const started = Date.now();
  const id = String(dispatchId ?? "").trim();
  if (!id) {
    return {
      ok: false,
      error: "MISSING_DISPATCH_ID",
      processed: 0,
      sent: 0,
      failed: 0,
      duration_ms: 0,
    };
  }

  const result = await processWhatsAppOutbox(supabase, { dispatchId: id });
  const durationMs = Date.now() - started;

  const { data: outbox } = await supabase
    .from("s7_notification_whatsapp_outbox")
    .select("id, status, provider_message_id, attempts, last_error, metadata")
    .eq("dispatch_id", id)
    .maybeSingle();

  return {
    ...result,
    duration_ms: durationMs,
    outbox_id: outbox?.id ?? null,
    outbox_status: outbox?.status ?? null,
    provider_message_id: outbox?.provider_message_id ?? null,
    attempts: outbox?.attempts ?? null,
    last_error: outbox?.last_error ?? null,
    simulated:
      outbox?.metadata &&
      typeof outbox.metadata === "object" &&
      /** @type {{ simulated?: boolean }} */ (outbox.metadata).simulated === true,
  };
}
