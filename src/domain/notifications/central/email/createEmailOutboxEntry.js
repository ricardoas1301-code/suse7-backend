// =============================================================================
// Cria item na outbox — idempotente por dispatch_id
// =============================================================================

import { logEmailNotification } from "./emailLog.js";
import { S7_EMAIL_OUTBOX_STATUS } from "./emailOutboxStatus.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   dispatchId: string;
 *   recipientId?: string | null;
 *   recipientEmail: string;
 *   subject: string;
 *   bodyHtml: string;
 *   bodyText: string;
 *   metadata?: Record<string, unknown>;
 * }} input
 */
export async function createEmailOutboxEntry(supabase, input) {
  const dispatchId = String(input.dispatchId ?? "").trim();
  const email = String(input.recipientEmail ?? "").trim().toLowerCase();

  if (!dispatchId || !email) {
    return { ok: false, error: "INVALID_INPUT" };
  }

  const { data: existing, error: exErr } = await supabase
    .from("s7_notification_email_outbox")
    .select("id, status")
    .eq("dispatch_id", dispatchId)
    .maybeSingle();

  if (exErr && exErr.code !== "42P01" && exErr.code !== "PGRST205") throw exErr;
  if (existing?.id) {
    logEmailNotification("SKIPPED", { reason: "duplicate_dispatch", dispatch_id: dispatchId });
    return { ok: true, idempotent: true, outboxId: String(existing.id), status: existing.status };
  }

  const now = new Date().toISOString();
  const row = {
    seller_id: String(input.sellerId),
    dispatch_id: dispatchId,
    recipient_id: input.recipientId ?? null,
    recipient_email: email,
    subject: String(input.subject ?? ""),
    body_html: String(input.bodyHtml ?? ""),
    body_text: String(input.bodyText ?? ""),
    status: S7_EMAIL_OUTBOX_STATUS.PENDING,
    attempts: 0,
    scheduled_at: now,
    created_at: now,
    updated_at: now,
    metadata: input.metadata ?? {},
  };

  const { data, error } = await supabase
    .from("s7_notification_email_outbox")
    .insert(row)
    .select("id, status")
    .single();

  if (error) {
    if (error.code === "23505") {
      logEmailNotification("SKIPPED", { reason: "unique_violation", dispatch_id: dispatchId });
      return { ok: true, idempotent: true };
    }
    if (error.code === "42P01" || error.code === "PGRST205") {
      logEmailNotification("SKIPPED", { reason: "outbox_table_missing", dispatch_id: dispatchId });
      return { ok: false, error: "OUTBOX_TABLE_MISSING" };
    }
    throw error;
  }

  logEmailNotification("OUTBOX_CREATED", {
    outbox_id: data?.id,
    dispatch_id: dispatchId,
    seller_id: input.sellerId,
  });

  return { ok: true, outboxId: data?.id != null ? String(data.id) : null, status: data?.status };
}
