// ============================================================
// Persistência de auditoria — notification_delivery_logs
// ============================================================

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} deliveryId
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 * @param {Record<string, unknown>} [payload]
 */
export async function appendNotificationDeliveryLog(supabase, deliveryId, level, message, payload = {}) {
  const { error } = await supabase.from("notification_delivery_logs").insert({
    notification_delivery_id: deliveryId,
    level,
    message,
    payload,
  });
  if (error) {
    console.error("[S7_NOTIFICATION_DELIVERY_LOG_INSERT_ERR]", { deliveryId, message: error.message });
  }
}
