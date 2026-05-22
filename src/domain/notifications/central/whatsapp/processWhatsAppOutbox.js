// =============================================================================
// Processador da fila WhatsApp — Fase 3.5A
// =============================================================================

import { S7_NOTIFICATION_DISPATCH_STATUS } from "../constants/dispatchStatus.js";
import { logWhatsAppNotification } from "./whatsappLog.js";
import { S7_WHATSAPP_MAX_ATTEMPTS, S7_WHATSAPP_OUTBOX_STATUS } from "./whatsappOutboxStatus.js";
import { sendS7WhatsApp } from "./S7WhatsAppProvider.js";

/**
 * @param {string | null | undefined} err
 */
function sanitizeError(err) {
  const msg = String(err ?? "unknown_error").replace(/\s+/g, " ").trim();
  return msg.slice(0, 500);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ batchSize?: number; dispatchId?: string }} [options]
 */
export async function processWhatsAppOutbox(supabase, options = {}) {
  const batchSize = Math.min(100, Math.max(1, Number(options.batchSize) || 25));
  const now = new Date().toISOString();

  logWhatsAppNotification("PROCESS_START", { batch_size: batchSize });

  let query = supabase
    .from("s7_notification_whatsapp_outbox")
    .select(
      "id, seller_id, dispatch_id, recipient_phone, message_text, status, attempts, metadata"
    )
    .eq("status", S7_WHATSAPP_OUTBOX_STATUS.PENDING)
    .lte("scheduled_at", now)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (options.dispatchId) {
    query = supabase
      .from("s7_notification_whatsapp_outbox")
      .select(
        "id, seller_id, dispatch_id, recipient_phone, message_text, status, attempts, metadata"
      )
      .eq("dispatch_id", String(options.dispatchId))
      .in("status", [S7_WHATSAPP_OUTBOX_STATUS.PENDING, S7_WHATSAPP_OUTBOX_STATUS.FAILED])
      .limit(1);
  }

  const { data: rows, error } = await query;
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") {
      return { ok: false, error: "OUTBOX_TABLE_MISSING", processed: 0 };
    }
    throw error;
  }

  let processed = 0;
  let sent = 0;
  let failed = 0;

  for (const row of rows ?? []) {
    const outboxId = String(row.id);
    const dispatchId = String(row.dispatch_id);
    const attempts = Number(row.attempts ?? 0) + 1;

    if (attempts > S7_WHATSAPP_MAX_ATTEMPTS) {
      await supabase
        .from("s7_notification_whatsapp_outbox")
        .update({
          status: S7_WHATSAPP_OUTBOX_STATUS.FAILED,
          last_error: "MAX_ATTEMPTS_EXCEEDED",
          updated_at: now,
        })
        .eq("id", outboxId);
      failed += 1;
      continue;
    }

    await supabase
      .from("s7_notification_whatsapp_outbox")
      .update({
        status: S7_WHATSAPP_OUTBOX_STATUS.PROCESSING,
        attempts,
        updated_at: now,
      })
      .eq("id", outboxId);

    const sendResult = await sendS7WhatsApp({
      to: String(row.recipient_phone),
      message: String(row.message_text),
      metadata: {
        ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
        dispatch_id: dispatchId,
        attempt: attempts,
        seller_id: row.seller_id != null ? String(row.seller_id) : null,
      },
    });

    if (sendResult.ok) {
      const sentAt = new Date().toISOString();
      await supabase
        .from("s7_notification_whatsapp_outbox")
        .update({
          status: S7_WHATSAPP_OUTBOX_STATUS.SENT,
          provider_message_id: sendResult.providerMessageId ?? null,
          sent_at: sentAt,
          last_error: null,
          updated_at: sentAt,
          metadata: {
            ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
            provider: sendResult.provider ?? "mock",
            simulated: Boolean(sendResult.simulated),
          },
        })
        .eq("id", outboxId);

      await supabase
        .from("s7_notification_dispatches")
        .update({
          status: S7_NOTIFICATION_DISPATCH_STATUS.SENT,
          sent_at: sentAt,
          updated_at: sentAt,
          provider_key: sendResult.provider ?? "s7_whatsapp_mock",
          attempt_count: attempts,
          last_error: null,
        })
        .eq("id", dispatchId);

      await supabase.from("s7_notification_delivery_logs").insert({
        dispatch_id: dispatchId,
        attempt_number: attempts,
        status: S7_NOTIFICATION_DISPATCH_STATUS.SENT,
        provider_key: sendResult.provider ?? "s7_whatsapp_mock",
        provider_response: {
          outbox_id: outboxId,
          provider_message_id: sendResult.providerMessageId ?? null,
          simulated: Boolean(sendResult.simulated),
        },
        error_message: null,
        duration_ms: 0,
      });

      sent += 1;
      processed += 1;
      continue;
    }

    const errMsg = sanitizeError(sendResult.error);
    const finalStatus =
      attempts >= S7_WHATSAPP_MAX_ATTEMPTS
        ? S7_WHATSAPP_OUTBOX_STATUS.FAILED
        : S7_WHATSAPP_OUTBOX_STATUS.PENDING;

    await supabase
      .from("s7_notification_whatsapp_outbox")
      .update({
        status: finalStatus,
        last_error: errMsg,
        updated_at: now,
        scheduled_at: new Date(Date.now() + attempts * 60_000).toISOString(),
      })
      .eq("id", outboxId);

    if (finalStatus === S7_WHATSAPP_OUTBOX_STATUS.FAILED) {
      await supabase
        .from("s7_notification_dispatches")
        .update({
          status: S7_NOTIFICATION_DISPATCH_STATUS.FAILED,
          failed_at: now,
          updated_at: now,
          attempt_count: attempts,
          last_error: errMsg,
        })
        .eq("id", dispatchId);
    }

    logWhatsAppNotification("FAILED", {
      outbox_id: outboxId,
      dispatch_id: dispatchId,
      attempts,
      error: errMsg,
    });

    failed += 1;
    processed += 1;
  }

  return { ok: true, processed, sent, failed, batch_size: batchSize };
}
