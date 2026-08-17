// =============================================================================
// Builder de ações planejadas — Fase 3.5C.1.A2
// =============================================================================

import { NOTIFICATION_ACTION_STATUS } from "./notificationActionTypes.js";

/**
 * @param {string} channel
 * @param {string | null} recipientId
 * @param {string | null} destination
 */
export function buildDispatchSlotKey(channel, recipientId, destination) {
  const dest =
    destination != null && String(destination).trim() !== "" ? String(destination).trim() : "__in_app__";
  const recip =
    recipientId != null && String(recipientId).trim() !== "" ? String(recipientId).trim() : "__owner__";
  return `${channel}:${recip}:${dest}`;
}

/**
 * @param {{
 *   sellerId: string;
 *   channel: string;
 *   recipient: { recipientId?: string | null; destination?: string | null; label?: string };
 *   template: { template_key: string; id?: string };
 *   renderedSubject: string;
 *   renderedBody: string;
 *   variables: Record<string, unknown>;
 *   eventId: string;
 *   correlationId?: string | null;
 *   category: string;
 *   type: string;
 *   deepLink?: string | null;
 *   sourceModule?: string | null;
 * }} spec
 * @returns {import("./notificationActionTypes.js").PlannedNotificationAction}
 */
export function buildPlannedNotificationAction(spec) {
  const recipientId = spec.recipient.recipientId ?? null;
  const recipientContact = spec.recipient.destination ?? null;
  const slotKey = buildDispatchSlotKey(spec.channel, recipientId, recipientContact);

  return {
    seller_id: spec.sellerId,
    channel: spec.channel,
    recipient_id: recipientId,
    recipient_contact: recipientContact,
    template_key: String(spec.template.template_key ?? ""),
    message_payload: {
      subject: spec.renderedSubject,
      body: spec.renderedBody,
      variables: spec.variables,
    },
    status: NOTIFICATION_ACTION_STATUS.PLANNED,
    slot_key: slotKey,
    metadata: {
      event_id: spec.eventId,
      correlation_id: spec.correlationId ?? null,
      category_key: spec.category,
      event_type: spec.type,
      recipient_label: spec.recipient.label ?? null,
      template_id: spec.template.id ?? null,
      deep_link: spec.deepLink ?? null,
      source_module: spec.sourceModule ?? null,
      engine: "notification_actions_v1",
    },
  };
}

/**
 * @param {import("./notificationActionTypes.js").PlannedNotificationAction} action
 * @param {string} reason
 * @returns {import("./notificationActionTypes.js").PlannedNotificationAction}
 */
export function markActionSkipped(action, reason) {
  return {
    ...action,
    status: NOTIFICATION_ACTION_STATUS.SKIPPED,
    skip_reason: reason,
    metadata: { ...action.metadata, skip_reason: reason },
  };
}
