// ============================================================
// Cancelamento explícito de delivery (não retenta)
// ============================================================

import { appendNotificationDeliveryLog } from "./deliveryAuditLog.js";
import { logNotification } from "./notificationLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} deliveryId
 * @param {string} [reason]
 * @param {{ logMessage?: string }} [opts]
 */
export async function cancelNotificationDelivery(supabase, deliveryId, reason = "cancelled", opts = {}) {
  const id = String(deliveryId ?? "").trim();
  if (!id) return { ok: false, error: "INVALID_ID" };

  const logMsg = opts.logMessage != null ? String(opts.logMessage) : "delivery_cancelled";

  const { error } = await supabase
    .from("notification_deliveries")
    .update({
      status: "cancelled",
      error_message: reason.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .in("status", ["pending", "processing"]);

  if (error) {
    return { ok: false, error: error.message };
  }

  await appendNotificationDeliveryLog(supabase, id, "info", logMsg, { reason });
  logNotification("DELIVERY_CANCELLED", { delivery_id: id, reason });
  return { ok: true };
}
