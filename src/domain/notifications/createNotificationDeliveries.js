// ============================================================
// Materializa notification_deliveries a partir de um evento (Fase 2)
// Resolve destinatários uma vez por canal (sem N+1 pesado por contato).
// ============================================================

import {
  NOTIFICATION_ROUTING_CHANNELS,
  NOTIFICATION_ROUTING_TYPE_LOOKUP,
  isValidRoutingNotificationType,
} from "../notificationRoutingCatalog.js";
import { resolveNotificationRecipients } from "../notificationRecipientsResolver.js";
import { fetchUserNotifyChannelsForRoutingType } from "./userNotifyChannelPrefs.js";
import { appendNotificationDeliveryLog } from "./deliveryAuditLog.js";
import { logNotification } from "./notificationLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} event — linha notification_events
 * @returns {Promise<{ ok: boolean, inserted?: number, error?: string }>}
 */
export async function createNotificationDeliveriesForEvent(supabase, event) {
  const userId = event?.user_id != null ? String(event.user_id) : "";
  const routingType =
    event?.notification_type != null ? String(event.notification_type).trim() : "";

  if (!userId || !isValidRoutingNotificationType(routingType)) {
    return { ok: false, error: "INVALID_EVENT" };
  }

  const catalog = NOTIFICATION_ROUTING_TYPE_LOOKUP[routingType];
  if (!catalog) {
    return { ok: false, error: "UNKNOWN_ROUTING_TYPE" };
  }

  const prefs = await fetchUserNotifyChannelsForRoutingType(supabase, userId, routingType);
  const marketplaceAccountId =
    event.marketplace_account_id != null && String(event.marketplace_account_id).trim() !== ""
      ? String(event.marketplace_account_id).trim()
      : null;

  /** @type {Array<Record<string, unknown>>} */
  const rows = [];

  for (const ch of catalog.supportedChannels) {
    if (!prefs[ch]) continue;

    const resolved = await resolveNotificationRecipients(supabase, {
      userId,
      notificationType: routingType,
      marketplaceAccountId,
      channel: ch,
    });

    if (!resolved.ok) {
      continue;
    }

    if (ch === NOTIFICATION_ROUTING_CHANNELS.app) {
      if (!prefs.app || !resolved.owner_app) continue;
      rows.push({
        notification_event_id: event.id,
        user_id: userId,
        contact_id: null,
        notification_channel: ch,
        destination: null,
        provider: "app",
        status: "pending",
      });
      continue;
    }

    if (ch === NOTIFICATION_ROUTING_CHANNELS.whatsapp || ch === NOTIFICATION_ROUTING_CHANNELS.email) {
      const contacts = Array.isArray(resolved.contacts_resolved) ? resolved.contacts_resolved : [];
      for (const c of contacts) {
        const dest =
          ch === NOTIFICATION_ROUTING_CHANNELS.whatsapp
            ? c.whatsapp != null
              ? String(c.whatsapp).replace(/\D/g, "")
              : ""
            : c.email != null
              ? String(c.email).trim().toLowerCase()
              : "";
        if (!dest) continue;

        rows.push({
          notification_event_id: event.id,
          user_id: userId,
          contact_id: c.id,
          notification_channel: ch,
          destination: dest,
          provider: ch === NOTIFICATION_ROUTING_CHANNELS.whatsapp ? "mock_whatsapp" : "mock_email",
          status: "pending",
        });
      }
    }
  }

  if (rows.length === 0) {
    logNotification("DELIVERY_SKIPPED_NO_RECIPIENTS", {
      event_id: event.id,
      user_id: userId,
      notification_type: routingType,
    });
    return { ok: true, inserted: 0 };
  }

  let inserted = 0;
  for (const row of rows) {
    const { data, error } = await supabase.from("notification_deliveries").insert(row).select("id").maybeSingle();
    if (error) {
      const code = String(error.code ?? "");
      const msg = String(error.message ?? "");
      if (code === "23505" || msg.includes("duplicate")) continue;
      console.error("[S7_NOTIFICATION_DELIVERIES_INSERT_ERR]", { message: error.message });
      return { ok: false, error: error.message };
    }
    if (data?.id) {
      inserted++;
      await appendNotificationDeliveryLog(supabase, String(data.id), "info", "delivery_enqueued", {
        event_id: event.id,
      });
    }
  }

  logNotification("DELIVERY_CREATED", { event_id: event.id, count: inserted });
  return { ok: true, inserted };
}
