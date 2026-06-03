// =============================================================================
// Notification Actions Engine — Fase 3.5C.1.A2
// Evento → ações por canal → execução via providers/outbox (sem acoplamento Z-API)
// =============================================================================

import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { S7_NOTIFICATION_DISPATCH_STATUS } from "../constants/dispatchStatus.js";
import { lookupNotificationTypeCatalog } from "../constants/eventTypes.js";
import { logCentralNotification } from "../observability/centralNotificationLog.js";
import { resolveInAppDeepLink } from "../inbox/resolveInAppDeepLink.js";
import { logInAppNotification } from "../inbox/inAppNotificationLog.js";
import { logEmailNotification } from "../email/emailLog.js";
import { logWhatsAppNotification } from "../whatsapp/whatsappLog.js";
import { getNotificationDeliveryProvider } from "../providers/providerRegistry.js";
import { renderNotificationTemplate } from "../templates/renderNotificationTemplate.js";
import { resolveNotificationTemplate } from "../templates/resolveNotificationTemplate.js";
import { resolveNotificationChannels } from "./notificationChannelResolver.js";
import { resolveNotificationActionRecipients } from "./notificationRecipientResolver.js";
import {
  buildPlannedNotificationAction,
  buildDispatchSlotKey,
  markActionSkipped,
} from "./notificationActionBuilder.js";
import {
  NOTIFICATION_ACTION_STATUS,
  actionsInputFromPersistedEvent,
  normalizeActionsEngineInput,
} from "./notificationActionTypes.js";
import { logNotificationActions } from "./notificationActionsLog.js";

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

/**
 * Planeja ações sem executar providers (útil para testes e auditoria).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("./notificationActionTypes.js").NotificationActionsEngineInput | Record<string, unknown>} input
 * @param {{ locale?: string; allow_redispatch?: boolean; existingSlots?: Set<string> }} [options]
 */
export async function planNotificationActions(supabase, input, options = {}) {
  const normalized = normalizeActionsEngineInput(input);
  const sellerId = normalized.seller_id;
  const category = normalized.category_key;
  const type = normalized.event_type;
  const eventId = String(normalized.event_id ?? "").trim();

  if (!sellerId || !category || !type) {
    return { ok: false, error: "INVALID_ACTIONS_INPUT", actions: [] };
  }

  const catalog = lookupNotificationTypeCatalog(category, type);
  const variables = normalized.payload ?? {};

  const { channels: resolvedChannels } = await resolveNotificationChannels(supabase, {
    sellerId,
    category,
    type,
  });

  const channelFilter = Array.isArray(options.channels_filter)
    ? options.channels_filter.map((c) => String(c).trim()).filter(Boolean)
    : null;
  const channels =
    channelFilter && channelFilter.length > 0
      ? resolvedChannels.filter((ch) => channelFilter.includes(ch))
      : resolvedChannels;

  /** @type {Record<string, { destination?: string | null; recipient_id?: string | null }>} */
  const manualRecipientsByChannel =
    options.manual_recipients_by_channel && typeof options.manual_recipients_by_channel === "object"
      ? /** @type {Record<string, { destination?: string | null; recipient_id?: string | null }>} */ (
          options.manual_recipients_by_channel
        )
      : {};

  const allowRedispatch = options.allow_redispatch === true;
  const existingSlots =
    options.existingSlots ??
    (eventId && !allowRedispatch ? await loadExistingDispatchSlotKeys(supabase, eventId) : new Set());

  /** @type {import("./notificationActionTypes.js").PlannedNotificationAction[]} */
  const actions = [];

  for (const channel of channels) {
    if (channel === S7_NOTIFICATION_CHANNEL.PUSH) continue;

    const template = await resolveNotificationTemplate(supabase, {
      templateKey: catalog?.templateKey ?? null,
      category,
      type,
      channel,
      locale: options.locale ?? "pt-BR",
    });

    if (!template) {
      logNotificationActions("SKIPPED_NO_TEMPLATE", { event_id: eventId, channel, category, type });
      continue;
    }

    const manualRecipient = manualRecipientsByChannel[channel];
    const recipients = manualRecipient?.destination
      ? [
          {
            recipientId: manualRecipient.recipient_id ?? null,
            destination: String(manualRecipient.destination).trim(),
            label: "manual_sale_rayx",
          },
        ]
      : await resolveNotificationActionRecipients(supabase, {
          sellerId,
          category,
          type,
          channel,
          marketplaceAccountId: normalized.marketplace_account_id ?? null,
        });

    if (recipients.length === 0) {
      logNotificationActions("SKIPPED_NO_RECIPIENTS", { event_id: eventId, channel });
      continue;
    }

    const renderedSubject = renderNotificationTemplate(String(template.subject_template ?? ""), variables);
    const renderedBody = renderNotificationTemplate(String(template.body_template ?? ""), variables);

    for (const recipient of recipients) {
      const isInApp = channel === S7_NOTIFICATION_CHANNEL.IN_APP;
      const deepLink = isInApp
        ? resolveInAppDeepLink({
            category,
            type,
            entityType: normalized.entity_type ?? null,
            entityId: normalized.entity_id ?? null,
            payload: variables,
          })
        : null;

      let action = buildPlannedNotificationAction({
        sellerId,
        channel,
        recipient,
        template,
        renderedSubject,
        renderedBody,
        variables,
        eventId,
        correlationId: normalized.correlation_id,
        category,
        type,
        deepLink,
        sourceModule: normalized.source_module,
      });

      if (eventId && action.slot_key && existingSlots.has(action.slot_key)) {
        action = markActionSkipped(action, "DUPLICATE_SLOT");
      }

      actions.push(action);
    }
  }

  logNotificationActions("PLAN_COMPLETE", {
    event_id: eventId || null,
    seller_id: sellerId,
    category,
    type,
    planned: actions.filter((a) => a.status === NOTIFICATION_ACTION_STATUS.PLANNED).length,
    skipped: actions.filter((a) => a.status === NOTIFICATION_ACTION_STATUS.SKIPPED).length,
    correlation_id: normalized.correlation_id,
  });

  return { ok: true, actions, catalog, variables };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} dispatchId
 * @param {number} attemptNumber
 * @param {string} status
 * @param {string} providerKey
 * @param {Record<string, unknown>} providerResponse
 * @param {string | null} errorMessage
 */
async function appendDeliveryLog(
  supabase,
  dispatchId,
  attemptNumber,
  status,
  providerKey,
  providerResponse,
  errorMessage
) {
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
 * @param {import("./notificationActionTypes.js").PlannedNotificationAction} action
 * @param {Record<string, unknown>} event
 * @param {Record<string, unknown>} template
 * @param {string} severity
 */
async function executePlannedAction(supabase, action, event, template, severity) {
  if (action.status === NOTIFICATION_ACTION_STATUS.SKIPPED) {
    logNotificationActions("EXECUTE_SKIPPED", {
      event_id: action.metadata?.event_id,
      channel: action.channel,
      reason: action.skip_reason ?? action.metadata?.skip_reason,
    });
    return { skipped: true, reason: action.skip_reason ?? "SKIPPED" };
  }

  const channel = action.channel;
  const sellerId = action.seller_id;
  const eventId = String(action.metadata?.event_id ?? event.id ?? "");
  const category = String(action.metadata?.category_key ?? event.category_code ?? "");
  const type = String(action.metadata?.event_type ?? event.type_key ?? "");
  const variables = action.message_payload?.variables ?? {};
  const renderedSubject = String(action.message_payload?.subject ?? "");
  const renderedBody = String(action.message_payload?.body ?? "");
  const deepLink = action.metadata?.deep_link ?? null;
  const isInApp = channel === S7_NOTIFICATION_CHANNEL.IN_APP;
  const provider = getNotificationDeliveryProvider(channel);
  const now = new Date().toISOString();

  /** @type {Record<string, unknown>} */
  const insertRow = {
    event_id: eventId,
    seller_id: sellerId,
    template_id: template.id,
    template_key: template.template_key,
    recipient_id: action.recipient_id,
    channel,
    destination: action.recipient_contact,
    status: S7_NOTIFICATION_DISPATCH_STATUS.PENDING,
    priority: template.priority ?? "normal",
    variables,
    rendered_subject: renderedSubject,
    rendered_body: renderedBody,
    provider_key: provider?.providerKey ?? null,
    correlation_id: event.correlation_id ?? action.metadata?.correlation_id ?? null,
    source_module: event.source_module ?? action.metadata?.source_module ?? null,
    metadata: {
      recipient_label: action.metadata?.recipient_label ?? null,
      actions_engine: true,
      planned_action: {
        template_key: action.template_key,
        status: action.status,
      },
    },
    created_at: now,
    updated_at: now,
  };

  if (isInApp) {
    const inboxSnapshot = {
      category_code: category,
      type_key: type,
      title: renderedSubject,
      message: renderedBody,
      severity: String(severity ?? "info"),
      is_read: false,
      read_at: null,
      deep_link: deepLink,
    };
    Object.assign(insertRow, inboxSnapshot);
    insertRow.metadata = {
      ...(typeof insertRow.metadata === "object" ? insertRow.metadata : {}),
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
  }

  if (insErr || !dispatch) {
    if (insErr?.code === "23505") {
      return { skipped: true, reason: "DUPLICATE_SLOT" };
    }
    return { ok: false, error: insErr?.message ?? "DISPATCH_INSERT_FAILED" };
  }

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
    return { dispatchId, status: S7_NOTIFICATION_DISPATCH_STATUS.SKIPPED };
  }

  await supabase
    .from("s7_notification_dispatches")
    .update({
      status: S7_NOTIFICATION_DISPATCH_STATUS.QUEUED,
      queued_at: now,
      updated_at: now,
    })
    .eq("id", dispatchId);

  const delivery = await provider.deliver({
    dispatchId,
    sellerId,
    channel,
    destination: action.recipient_contact,
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
      recipient_id: action.recipient_id,
      recipient_label: action.metadata?.recipient_label ?? null,
      correlation_id: action.metadata?.correlation_id ?? null,
    },
  });

  const isEmail = channel === S7_NOTIFICATION_CHANNEL.EMAIL;
  const isWhatsApp = channel === S7_NOTIFICATION_CHANNEL.WHATSAPP;

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
    logNotificationActions("WHATSAPP_OUTBOX_ENQUEUED", {
      dispatch_id: dispatchId,
      event_id: eventId,
      queued: Boolean(delivery.queued),
      provider_agnostic: true,
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

  logNotificationActions("ACTION_EXECUTED", {
    dispatch_id: dispatchId,
    channel,
    status: finalStatus,
    provider_key: provider.providerKey,
    correlation_id: action.metadata?.correlation_id ?? null,
  });

  return { dispatchId, status: finalStatus, channel, provider_key: provider.providerKey };
}

/**
 * Motor principal: planeja e executa ações (substitui o corpo legado do dispatch engine).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} event — linha persistida em s7_notification_events
 * @param {{ locale?: string; allow_redispatch?: boolean }} [options]
 */
export async function runNotificationActionsEngine(supabase, event, options = {}) {
  const engineInput = actionsInputFromPersistedEvent(event);
  const plan = await planNotificationActions(supabase, engineInput, options);

  if (!plan.ok) {
    return { ok: false, error: plan.error, inserted: 0, skipped_duplicates: 0, dispatches: [] };
  }

  const catalog = lookupNotificationTypeCatalog(
    String(event.category_code ?? ""),
    String(event.type_key ?? "")
  );
  const severity = String(event.severity ?? catalog?.severity ?? "info");

  /** @type {Array<Record<string, unknown>>} */
  const dispatchResults = [];
  let inserted = 0;
  let skippedDuplicates = 0;

  const templateCache = new Map();

  for (const action of plan.actions) {
    if (action.status === NOTIFICATION_ACTION_STATUS.SKIPPED) {
      skippedDuplicates += 1;
      logCentralNotification("DISPATCH_SKIPPED_DUPLICATE_SLOT", {
        event_id: engineInput.event_id,
        channel: action.channel,
        slot_key: action.slot_key,
        reason: action.skip_reason,
      });
      continue;
    }

    const cacheKey = `${action.channel}:${action.template_key}`;
    let template = templateCache.get(cacheKey);
    if (!template) {
      template = await resolveNotificationTemplate(supabase, {
        templateKey: action.template_key,
        category: engineInput.category_key,
        type: engineInput.event_type,
        channel: action.channel,
        locale: options.locale ?? "pt-BR",
      });
      if (template) templateCache.set(cacheKey, template);
    }

    if (!template) {
      logNotificationActions("EXECUTE_NO_TEMPLATE", { channel: action.channel });
      continue;
    }

    const result = await executePlannedAction(supabase, action, event, template, severity);
    if (result.skipped && result.reason === "DUPLICATE_SLOT") {
      skippedDuplicates += 1;
      continue;
    }
    if (result.dispatchId) {
      inserted += 1;
      dispatchResults.push({
        dispatchId: result.dispatchId,
        status: result.status,
        channel: result.channel,
      });
      logCentralNotification("DISPATCH_COMPLETED", {
        event_id: engineInput.event_id,
        dispatch_id: result.dispatchId,
        channel: result.channel,
        status: result.status,
      });
    }
  }

  logNotificationActions("ENGINE_COMPLETE", {
    event_id: engineInput.event_id,
    inserted,
    skipped_duplicates: skippedDuplicates,
    correlation_id: engineInput.correlation_id,
  });

  return {
    ok: true,
    inserted,
    skipped_duplicates: skippedDuplicates,
    dispatches: dispatchResults,
    planned_actions: plan.actions.length,
  };
}
