// ============================================================
// Processa uma única notification_delivery (worker)
// ============================================================

import { NOTIFICATION_ROUTING_CHANNELS } from "../notificationRoutingCatalog.js";
import { appendNotificationDeliveryLog } from "./deliveryAuditLog.js";
import { logNotification, maskEmailForLog, maskPhoneForLog } from "./notificationLog.js";
import { scheduleDeliveryRetryOrFail } from "./retryNotificationDelivery.js";
import { sendWhatsAppNotification } from "../../services/notifications/providers/whatsappProvider.js";
import { sendEmailNotification } from "../../services/notifications/providers/emailProvider.js";
import { sendAppBellNotification } from "../../services/notifications/providers/appProvider.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} deliveryId
 */
export async function processNotificationDelivery(supabase, deliveryId) {
  const id = String(deliveryId ?? "").trim();
  if (!id) return { ok: false, error: "INVALID_ID" };

  const { data: delivery, error: dErr } = await supabase
    .from("notification_deliveries")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (dErr || !delivery) {
    return { ok: false, error: dErr?.message ?? "DELIVERY_NOT_FOUND" };
  }

  if (delivery.status !== "processing") {
    return { ok: true, skipped: true, reason: "not_processing_state" };
  }

  const eventId = delivery.notification_event_id != null ? String(delivery.notification_event_id) : "";
  const { data: event, error: eErr } = await supabase
    .from("notification_events")
    .select("*")
    .eq("id", eventId)
    .maybeSingle();

  if (eErr || !event) {
    await scheduleDeliveryRetryOrFail(supabase, delivery, "notification_event_missing", true);
    return { ok: false, error: "EVENT_NOT_FOUND" };
  }

  const channel = String(delivery.notification_channel ?? "");
  const title = String(event.title ?? "");
  const message = String(event.message ?? "");
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? /** @type {Record<string, unknown>} */ (event.payload)
      : {};

  await appendNotificationDeliveryLog(supabase, id, "info", "delivery_send_start", {
    channel,
    attempts: delivery.attempts,
  });

  /** @type {{ success: boolean, providerMessageId?: string | null, raw?: unknown, permanentFailure?: boolean }} */
  let result;

  try {
    if (channel === NOTIFICATION_ROUTING_CHANNELS.app) {
      result = await sendAppBellNotification(supabase, {
        userId: String(delivery.user_id),
        deliveryId: id,
        notificationEventId: eventId,
        notificationType: String(event.notification_type ?? "generic"),
        title,
        message,
        payload,
      });
    } else if (channel === NOTIFICATION_ROUTING_CHANNELS.whatsapp) {
      logNotification("SEND_ATTEMPT", {
        notification_channel: "whatsapp",
        destination: maskPhoneForLog(delivery.destination),
        delivery_id: id,
      });
      result = await sendWhatsAppNotification({
        destination: String(delivery.destination ?? ""),
        title,
        message,
        payload,
      });
    } else if (channel === NOTIFICATION_ROUTING_CHANNELS.email) {
      logNotification("SEND_ATTEMPT", {
        notification_channel: "email",
        destination: maskEmailForLog(delivery.destination),
        delivery_id: id,
      });
      result = await sendEmailNotification({
        destination: String(delivery.destination ?? ""),
        title,
        message,
        payload,
      });
    } else {
      await scheduleDeliveryRetryOrFail(supabase, delivery, `unknown_channel:${channel}`, true);
      return { ok: false, error: "UNKNOWN_CHANNEL" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await scheduleDeliveryRetryOrFail(supabase, delivery, msg, false);
    return { ok: false, error: msg };
  }

  const nowIso = new Date().toISOString();

  if (result.success) {
    await supabase
      .from("notification_deliveries")
      .update({
        status: "delivered",
        sent_at: nowIso,
        delivered_at: nowIso,
        provider_message_id: result.providerMessageId ?? null,
        provider_response: result.raw != null ? result.raw : null,
        error_message: null,
        updated_at: nowIso,
      })
      .eq("id", id);

    await appendNotificationDeliveryLog(supabase, id, "info", "delivery_delivered", {
      provider_message_id: result.providerMessageId ?? null,
    });
    logNotification("SEND_SUCCESS", { delivery_id: id, channel });
    return { ok: true, delivered: true };
  }

  const detail =
    result.raw != null
      ? JSON.stringify(result.raw).slice(0, 800)
      : "provider_returned_failure";

  await scheduleDeliveryRetryOrFail(supabase, delivery, detail, Boolean(result.permanentFailure));
  logNotification("SEND_FAILED", {
    delivery_id: id,
    channel,
    permanent: Boolean(result.permanentFailure),
  });
  return { ok: false, error: "PROVIDER_FAILED" };
}
