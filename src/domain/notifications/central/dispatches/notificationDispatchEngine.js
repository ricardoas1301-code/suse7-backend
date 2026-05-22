// =============================================================================
// Dispatch Engine — evento → preferências → destinatários → template → entrega mock
// =============================================================================

import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { S7_NOTIFICATION_DISPATCH_STATUS } from "../constants/dispatchStatus.js";
import { lookupNotificationTypeCatalog } from "../constants/eventTypes.js";
import { logCentralNotification } from "../observability/centralNotificationLog.js";
import { resolveInAppDeepLink } from "../inbox/resolveInAppDeepLink.js";
import { logInAppNotification } from "../inbox/inAppNotificationLog.js";
import { logEmailNotification } from "../email/emailLog.js";
import { logWhatsAppNotification } from "../whatsapp/whatsappLog.js";
import { resolveNotificationPreferences } from "../preferences/resolveNotificationPreferences.js";
import { getNotificationDeliveryProvider } from "../providers/providerRegistry.js";
import { resolveCentralRecipients } from "../recipients/resolveCentralRecipients.js";
import { renderNotificationTemplate } from "../templates/renderNotificationTemplate.js";
import { resolveNotificationTemplate } from "../templates/resolveNotificationTemplate.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} dispatchId
 * @param {number} attemptNumber
 * @param {string} status
 * @param {string} providerKey
 * @param {Record<string, unknown>} providerResponse
 * @param {string | null} errorMessage
 */
/**
 * @param {string} channel
 * @param {string | null} recipientId
 * @param {string | null} destination
 */
/**
 * @param {{ code?: string; message?: string } | null} err
 */
function isMissingInboxColumnError(err) {
  const msg = String(err?.message ?? "").toLowerCase();
  return (
    err?.code === "PGRST204" ||
    msg.includes("category_code") ||
    msg.includes("is_read") ||
    msg.includes("deep_link")
  );
}

function buildDispatchSlotKey(channel, recipientId, destination) {
  const dest =
    destination != null && String(destination).trim() !== "" ? String(destination).trim() : "__in_app__";
  const recip =
    recipientId != null && String(recipientId).trim() !== "" ? String(recipientId).trim() : "__owner__";
  return `${channel}:${recip}:${dest}`;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} eventId
 */
async function loadExistingDispatchSlotKeys(supabase, eventId) {
  const { data, error } = await supabase
    .from("s7_notification_dispatches")
    .select("channel, recipient_id, destination")
    .eq("event_id", eventId);

  if (error) throw error;

  const keys = new Set();
  for (const row of data ?? []) {
    keys.add(
      buildDispatchSlotKey(
        String(row.channel ?? ""),
        row.recipient_id != null ? String(row.recipient_id) : null,
        row.destination != null ? String(row.destination) : null
      )
    );
  }
  return keys;
}

async function appendDeliveryLog(supabase, dispatchId, attemptNumber, status, providerKey, providerResponse, errorMessage) {
  await supabase.from("s7_notification_delivery_logs").insert({
    dispatch_id: dispatchId,
    attempt_number: attemptNumber,
    status,
    provider_key: providerKey,
    provider_response: providerResponse ?? {},
    error_message: errorMessage,
    duration_ms: 0,
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} event
 * @param {Record<string, unknown>} [options]
 */
export async function runNotificationDispatchEngine(supabase, event, options = {}) {
  const sellerId = String(event.seller_id ?? "").trim();
  const category = String(event.category_code ?? "").trim();
  const type = String(event.type_key ?? "").trim();
  const eventId = String(event.id ?? "").trim();
  const catalog = lookupNotificationTypeCatalog(category, type);
  const variables =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? /** @type {Record<string, unknown>} */ (event.payload)
      : {};

  const prefs = await resolveNotificationPreferences(supabase, { sellerId, category, type });
  const marketplaceAccountId =
    event.marketplace_account_id != null ? String(event.marketplace_account_id) : null;

  /** @type {Array<Record<string, unknown>>} */
  const dispatchResults = [];
  let inserted = 0;
  let skippedDuplicates = 0;

  const allowRedispatch = options.allow_redispatch === true;
  const existingSlots = allowRedispatch ? new Set() : await loadExistingDispatchSlotKeys(supabase, eventId);

  const supportedExternal = new Set(
    Array.isArray(catalog?.supportedChannels)
      ? catalog.supportedChannels.map(String)
      : [S7_NOTIFICATION_CHANNEL.EMAIL, S7_NOTIFICATION_CHANNEL.WHATSAPP]
  );

  /** @type {string[]} */
  const channelsToDispatch = [];
  if (prefs.enabledChannels.includes(S7_NOTIFICATION_CHANNEL.IN_APP)) {
    channelsToDispatch.push(S7_NOTIFICATION_CHANNEL.IN_APP);
  }
  for (const ch of [S7_NOTIFICATION_CHANNEL.EMAIL, S7_NOTIFICATION_CHANNEL.WHATSAPP]) {
    if (supportedExternal.has(ch)) channelsToDispatch.push(ch);
  }

  for (const channel of channelsToDispatch) {
    if (channel === S7_NOTIFICATION_CHANNEL.PUSH) continue;

    const template = await resolveNotificationTemplate(supabase, {
      templateKey: catalog?.templateKey ?? null,
      category,
      type,
      channel,
      locale: options.locale ?? "pt-BR",
    });

    if (!template) {
      logCentralNotification("DISPATCH_SKIPPED_NO_TEMPLATE", { event_id: eventId, channel, category, type });
      continue;
    }

    const recipients = await resolveCentralRecipients(supabase, {
      sellerId,
      category,
      type,
      channel,
      marketplaceAccountId,
    });

    if (recipients.length === 0) {
      logCentralNotification("DISPATCH_SKIPPED_NO_RECIPIENTS", { event_id: eventId, channel });
      continue;
    }

    const renderedSubject = renderNotificationTemplate(String(template.subject_template ?? ""), variables);
    const renderedBody = renderNotificationTemplate(String(template.body_template ?? ""), variables);
    const provider = getNotificationDeliveryProvider(channel);

    for (const recipient of recipients) {
      const slotKey = buildDispatchSlotKey(channel, recipient.recipientId, recipient.destination);

      if (!allowRedispatch && existingSlots.has(slotKey)) {
        skippedDuplicates += 1;
        logCentralNotification("DISPATCH_SKIPPED_DUPLICATE_SLOT", {
          event_id: eventId,
          channel,
          slot_key: slotKey,
        });
        continue;
      }

      const now = new Date().toISOString();
      const isInApp = channel === S7_NOTIFICATION_CHANNEL.IN_APP;
      const deepLink = isInApp
        ? resolveInAppDeepLink({
            category,
            type,
            entityType: event.entity_type ?? null,
            entityId: event.entity_id ?? null,
            payload: variables,
          })
        : null;

      /** @type {Record<string, unknown>} */
      const insertRow = {
        event_id: eventId,
        seller_id: sellerId,
        template_id: template.id,
        template_key: template.template_key,
        recipient_id: recipient.recipientId,
        channel,
        destination: recipient.destination,
        status: S7_NOTIFICATION_DISPATCH_STATUS.PENDING,
        priority: template.priority ?? "normal",
        variables,
        rendered_subject: renderedSubject,
        rendered_body: renderedBody,
        provider_key: provider?.providerKey ?? null,
        correlation_id: event.correlation_id ?? null,
        source_module: event.source_module ?? null,
        metadata: { recipient_label: recipient.label ?? null },
        created_at: now,
        updated_at: now,
      };

      const inboxSnapshot = isInApp
        ? {
            category_code: category,
            type_key: type,
            title: renderedSubject,
            message: renderedBody,
            severity: String(event.severity ?? catalog?.severity ?? "info"),
            is_read: false,
            read_at: null,
            deep_link: deepLink,
          }
        : null;

      if (isInApp && inboxSnapshot) {
        Object.assign(insertRow, inboxSnapshot);
        insertRow.metadata = {
          ...(typeof insertRow.metadata === "object" && insertRow.metadata ? insertRow.metadata : {}),
          inbox: inboxSnapshot,
        };
      }

      let dispatch = null;
      let insErr = null;
      {
        const attempt = await supabase.from("s7_notification_dispatches").insert(insertRow).select("*").single();
        dispatch = attempt.data;
        insErr = attempt.error;
      }

      if (insErr && isInApp && isMissingInboxColumnError(insErr)) {
        const legacyRow = { ...insertRow };
        delete legacyRow.category_code;
        delete legacyRow.type_key;
        delete legacyRow.title;
        delete legacyRow.message;
        delete legacyRow.severity;
        delete legacyRow.is_read;
        delete legacyRow.read_at;
        delete legacyRow.deep_link;
        const retry = await supabase.from("s7_notification_dispatches").insert(legacyRow).select("*").single();
        dispatch = retry.data;
        insErr = retry.error;
        if (!insErr) {
          logInAppNotification("STORE_METADATA_FALLBACK", { event_id: eventId, channel });
        }
      }

      if (insErr || !dispatch) {
        if (insErr?.code === "23505") {
          skippedDuplicates += 1;
          existingSlots.add(slotKey);
          logCentralNotification("DISPATCH_SKIPPED_DUPLICATE_SLOT", {
            event_id: eventId,
            channel,
            slot_key: slotKey,
            reason: "unique_violation",
          });
          continue;
        }
        logCentralNotification("DISPATCH_INSERT_FAILED", {
          event_id: eventId,
          channel,
          message: insErr?.message,
        });
        continue;
      }

      existingSlots.add(slotKey);
      inserted += 1;
      const dispatchId = String(dispatch.id);

      if (!provider) {
        await supabase
          .from("s7_notification_dispatches")
          .update({
            status: S7_NOTIFICATION_DISPATCH_STATUS.SKIPPED,
            skipped_at: now,
            updated_at: now,
            last_error: "NO_PROVIDER",
          })
          .eq("id", dispatchId);
        dispatchResults.push({ dispatchId, status: S7_NOTIFICATION_DISPATCH_STATUS.SKIPPED });
        continue;
      }

      await supabase
        .from("s7_notification_dispatches")
        .update({
          status: S7_NOTIFICATION_DISPATCH_STATUS.QUEUED,
          queued_at: now,
          updated_at: now,
        })
        .eq("id", dispatchId);

      const isEmail = channel === S7_NOTIFICATION_CHANNEL.EMAIL;
      const isWhatsApp = channel === S7_NOTIFICATION_CHANNEL.WHATSAPP;

      const delivery = await provider.deliver({
        dispatchId,
        sellerId,
        channel,
        destination: recipient.destination,
        renderedSubject,
        renderedBody,
        supabase,
        metadata: {
          event_id: eventId,
          category_code: category,
          type_key: type,
          deep_link: deepLink,
          entity_type: event.entity_type ?? null,
          entity_id: event.entity_id ?? null,
          variables,
          recipient_id: recipient.recipientId,
          recipient_label: recipient.label ?? null,
        },
      });

      if (isInApp) {
        logInAppNotification(delivery.ok ? "DELIVERED" : "DELIVERY_FAILED", {
          dispatch_id: dispatchId,
          seller_id: sellerId,
          event_id: eventId,
          status: delivery.ok ? "SENT" : "FAILED",
        });
      }

      if (isEmail) {
        logEmailNotification(delivery.ok && delivery.queued ? "OUTBOX_ENQUEUED" : "DELIVERY_FAILED", {
          dispatch_id: dispatchId,
          seller_id: sellerId,
          event_id: eventId,
          queued: Boolean(delivery.queued),
        });
      }

      if (isWhatsApp) {
        logWhatsAppNotification(delivery.ok && delivery.queued ? "OUTBOX_ENQUEUED" : "DELIVERY_FAILED", {
          dispatch_id: dispatchId,
          seller_id: sellerId,
          event_id: eventId,
          queued: Boolean(delivery.queued),
        });
      }

      const finalStatus = delivery.skipped
        ? S7_NOTIFICATION_DISPATCH_STATUS.SKIPPED
        : delivery.ok && (isEmail || isWhatsApp) && delivery.queued
          ? S7_NOTIFICATION_DISPATCH_STATUS.QUEUED
          : delivery.ok
            ? S7_NOTIFICATION_DISPATCH_STATUS.SENT
            : S7_NOTIFICATION_DISPATCH_STATUS.FAILED;

      const patch = {
        status: finalStatus,
        attempt_count: 1,
        updated_at: new Date().toISOString(),
        last_error: delivery.error ?? null,
      };
      if (finalStatus === S7_NOTIFICATION_DISPATCH_STATUS.SENT) patch.sent_at = patch.updated_at;
      if (finalStatus === S7_NOTIFICATION_DISPATCH_STATUS.FAILED) patch.failed_at = patch.updated_at;
      if (finalStatus === S7_NOTIFICATION_DISPATCH_STATUS.SKIPPED) patch.skipped_at = patch.updated_at;

      await supabase.from("s7_notification_dispatches").update(patch).eq("id", dispatchId);

      await appendDeliveryLog(
        supabase,
        dispatchId,
        1,
        finalStatus,
        provider.providerKey,
        delivery.providerResponse ?? {},
        delivery.error ?? null
      );

      dispatchResults.push({ dispatchId, status: finalStatus, channel });
      logCentralNotification("DISPATCH_COMPLETED", {
        event_id: eventId,
        dispatch_id: dispatchId,
        channel,
        status: finalStatus,
      });
    }
  }

  return { ok: true, inserted, skipped_duplicates: skippedDuplicates, dispatches: dispatchResults };
}
