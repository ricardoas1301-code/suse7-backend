// ======================================================================
// Billing → S7 Central Notification Engine (Fase 3.1)
// Mantém billing_notification_* (Fase 3.0) + publica no motor central.
// ======================================================================

import { BILLING_TIMELINE_EVENT } from "../billingPhase30Constants.js";
import { logBillingError } from "../billingLog.js";
import { publishNotificationEvent } from "../../domain/notifications/central/index.js";
import { S7_NOTIFICATION_CATEGORY } from "../../domain/notifications/central/constants/categories.js";

/** @type {Record<string, { type: string, severity?: string }>} */
const TIMELINE_TO_CENTRAL = {
  [BILLING_TIMELINE_EVENT.PAYMENT_CONFIRMED]: { type: "PAYMENT_CONFIRMED", severity: "info" },
  [BILLING_TIMELINE_EVENT.PAYMENT_FAILED]: { type: "PAYMENT_FAILED", severity: "warning" },
  [BILLING_TIMELINE_EVENT.PAYMENT_GENERATED]: { type: "PAYMENT_GENERATED", severity: "info" },
  [BILLING_TIMELINE_EVENT.SUSPENDED]: { type: "SUSPENDED", severity: "critical" },
  [BILLING_TIMELINE_EVENT.REACTIVATED]: { type: "REACTIVATED", severity: "info" },
  [BILLING_TIMELINE_EVENT.ENTERED_GRACE]: { type: "ENTERED_GRACE", severity: "warning" },
  [BILLING_TIMELINE_EVENT.RENEWAL_COMPLETED]: { type: "RENEWAL_COMPLETED", severity: "info" },
};

/** @type {Record<string, string>} */
const BILLING_TEMPLATE_TO_CENTRAL_TYPE = {
  "payment.confirmed": "PAYMENT_CONFIRMED",
  "payment.failed": "PAYMENT_FAILED",
  "payment.generated": "PAYMENT_GENERATED",
  "subscription.suspended": "SUSPENDED",
  "grace.started": "ENTERED_GRACE",
  "renewal.paid": "PAYMENT_CONFIRMED",
  "renewal.reminder_3_days": "PAYMENT_GENERATED",
  "renewal.reminder_2_days": "PAYMENT_GENERATED",
  "renewal.reminder_1_day": "PAYMENT_GENERATED",
  "renewal.due_today": "PAYMENT_GENERATED",
};

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   timelineEventType?: string | null;
 *   templateKey?: string | null;
 *   variables?: Record<string, unknown>;
 *   correlationId?: string | null;
 *   idempotencyKey?: string | null;
 *   subscriptionId?: string | null;
 *   timelineEventId?: string | null;
 * }} input
 */
export async function publishBillingCentralNotification(supabase, input) {
  const userId = String(input.userId ?? "").trim();
  if (!userId) return { ok: false, error: "MISSING_USER" };

  let centralType = null;
  let severity = "info";

  if (input.timelineEventType && TIMELINE_TO_CENTRAL[input.timelineEventType]) {
    centralType = TIMELINE_TO_CENTRAL[input.timelineEventType].type;
    severity = TIMELINE_TO_CENTRAL[input.timelineEventType].severity ?? severity;
  } else if (input.templateKey && BILLING_TEMPLATE_TO_CENTRAL_TYPE[input.templateKey]) {
    centralType = BILLING_TEMPLATE_TO_CENTRAL_TYPE[input.templateKey];
  }

  if (!centralType) return { ok: true, skipped: true, reason: "UNMAPPED_TYPE" };

  const correlationId = input.correlationId != null ? String(input.correlationId) : null;
  const idempotencyKey =
    input.idempotencyKey != null && String(input.idempotencyKey).trim() !== ""
      ? `billing:central:${String(input.idempotencyKey).trim()}`
      : input.timelineEventId
        ? `billing:central:timeline:${input.timelineEventId}:${centralType}`
        : correlationId
          ? `billing:central:${correlationId}:${centralType}`
          : null;

  if (!idempotencyKey) {
    return { ok: true, skipped: true, reason: "NO_IDEMPOTENCY_KEY" };
  }

  const payload = {
    ...(input.variables ?? {}),
    subscription_id: input.subscriptionId ?? null,
    timeline_event_id: input.timelineEventId ?? null,
    billing_template_key: input.templateKey ?? null,
  };

  try {
    return await publishNotificationEvent(supabase, {
      category: S7_NOTIFICATION_CATEGORY.BILLING,
      type: centralType,
      seller_id: userId,
      payload,
      severity,
      correlation_id: correlationId,
      idempotency_key: idempotencyKey,
      entity_type: "billing_subscription",
      entity_id: input.subscriptionId != null ? String(input.subscriptionId) : null,
      source_module: "billing",
    });
  } catch (err) {
    logBillingError("billing", "central_notification_publish_failed", err, {
      user_id: userId,
      central_type: centralType,
    });
    return { ok: false, error: "CENTRAL_PUBLISH_FAILED" };
  }
}
