// ============================================================
// Persistência de notification_events (Fase 2)
// ============================================================

import { logNotification } from "./notificationLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   user_id: string,
 *   notification_type: string,
 *   marketplace?: string | null,
 *   marketplace_account_id?: string | null,
 *   seller_company_id?: string | null,
 *   entity_type?: string | null,
 *   entity_id?: string | null,
 *   title: string,
 *   message: string,
 *   payload?: Record<string, unknown>,
 *   fingerprint?: string | null,
 *   severity?: string | null,
 * }} row
 */
export async function insertNotificationEvent(supabase, row) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};

  const { data, error } = await supabase
    .from("notification_events")
    .insert({
      user_id: row.user_id,
      notification_type: row.notification_type,
      marketplace: row.marketplace ?? null,
      marketplace_account_id: row.marketplace_account_id ?? null,
      seller_company_id: row.seller_company_id ?? null,
      entity_type: row.entity_type ?? null,
      entity_id: row.entity_id != null ? String(row.entity_id) : null,
      title: row.title,
      message: row.message,
      payload,
      fingerprint: row.fingerprint ?? null,
      severity: row.severity ?? null,
    })
    .select("*")
    .single();

  if (error) {
    console.error("[S7_NOTIFICATION_EVENT_INSERT_ERR]", { message: error.message });
    return { ok: false, error: error.message };
  }

  logNotification("EVENT_CREATED", {
    event_id: data?.id,
    user_id: row.user_id,
    notification_type: row.notification_type,
    severity: row.severity,
    fingerprint: row.fingerprint ? `${String(row.fingerprint).slice(0, 8)}…` : null,
  });

  return { ok: true, event: data };
}
