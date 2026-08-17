// ============================================================
// Atualização de estado pós-falha — retry ou failed permanente
// ============================================================

import { calculateNotificationRetryDelayMs, NOTIFICATION_DELIVERY_MAX_ATTEMPTS } from "./retrySchedule.js";
import { appendNotificationDeliveryLog } from "./deliveryAuditLog.js";
import { logNotification } from "./notificationLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} delivery — linha atualizada com attempts já incrementados
 * @param {string} errorMessage
 * @param {boolean} [permanentFailure] — ex.: validação do provider
 */
export async function scheduleDeliveryRetryOrFail(supabase, delivery, errorMessage, permanentFailure = false) {
  const id = String(delivery.id ?? "");
  const attempts = Number(delivery.attempts ?? 0);
  const nowIso = new Date().toISOString();
  const errShort = String(errorMessage ?? "").slice(0, 2000);

  if (permanentFailure || attempts >= NOTIFICATION_DELIVERY_MAX_ATTEMPTS) {
    await supabase
      .from("notification_deliveries")
      .update({
        status: "failed",
        failed_at: nowIso,
        error_message: errShort,
        updated_at: nowIso,
      })
      .eq("id", id);

    await appendNotificationDeliveryLog(supabase, id, "error", "delivery_failed_permanent", {
      attempts,
      error_message: errShort,
      permanentFailure,
    });
    logNotification("SEND_FAILED", { delivery_id: id, attempts, permanent: true });
    return { outcome: "failed" };
  }

  const delayMs = calculateNotificationRetryDelayMs(attempts);
  if (delayMs == null || delayMs <= 0) {
    await supabase
      .from("notification_deliveries")
      .update({
        status: "failed",
        failed_at: nowIso,
        error_message: errShort,
        updated_at: nowIso,
      })
      .eq("id", id);

    await appendNotificationDeliveryLog(supabase, id, "error", "delivery_failed_no_schedule", { attempts });
    logNotification("SEND_FAILED", { delivery_id: id, attempts, permanent: true });
    return { outcome: "failed" };
  }

  const next = new Date(Date.now() + delayMs).toISOString();
  await supabase
    .from("notification_deliveries")
    .update({
      status: "pending",
      next_retry_at: next,
      error_message: errShort,
      updated_at: nowIso,
    })
    .eq("id", id);

  await appendNotificationDeliveryLog(supabase, id, "warn", "retry_scheduled", {
    attempts,
    next_retry_at: next,
    delay_ms: delayMs,
  });
  logNotification("RETRY_SCHEDULED", { delivery_id: id, attempts, next_retry_at: next });
  return { outcome: "retry", next_retry_at: next };
}
