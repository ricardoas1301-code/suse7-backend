// ======================================================================
// Notification center — template-driven (Fase 3.0)
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { publishBillingCentralNotification } from "./billingCentralNotificationBridge.js";
import {
  BILLING_NOTIFICATION_CHANNEL,
  BILLING_NOTIFICATION_DISPATCH_STATUS,
  BILLING_PHASE30_LOG,
  RENEWAL_EVENT_TO_TEMPLATE_KEY,
} from "../billingPhase30Constants.js";
import { sanitizeBillingAuditValue } from "../utils/billingAuditSanitize.js";

/**
 * Render simples {{var}} — sem dependência externa.
 *
 * @param {string} template
 * @param {Record<string, unknown>} variables
 */
export function renderBillingNotificationTemplate(template, variables) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = variables[key];
    return value == null ? "" : String(value);
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} templateKey
 * @param {string} [channel]
 * @param {string} [locale]
 */
export async function getBillingNotificationTemplate(supabase, templateKey, channel = "in_app", locale = "pt-BR") {
  const { data, error } = await supabase
    .from("billing_notification_templates")
    .select("*")
    .eq("template_key", templateKey)
    .eq("channel", channel)
    .eq("locale", locale)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   templateKey: string;
 *   variables?: Record<string, unknown>;
 *   channel?: string;
 *   locale?: string;
 *   subscriptionId?: string | null;
 *   timelineEventId?: string | null;
 *   correlationId?: string | null;
 *   requestId?: string | null;
 * }} input
 */
export async function enqueueBillingNotification(supabase, input) {
  const channel = input.channel ?? BILLING_NOTIFICATION_CHANNEL.IN_APP;
  const locale = input.locale ?? "pt-BR";
  const variables = sanitizeBillingAuditValue(input.variables ?? {});

  const template = await getBillingNotificationTemplate(supabase, input.templateKey, channel, locale);
  if (!template) {
    logBilling("billing", "notification_template_missing", {
      template_key: input.templateKey,
      channel,
      locale,
      user_id: input.userId,
    });
    return null;
  }

  const renderedSubject = renderBillingNotificationTemplate(String(template.subject_template), variables);
  const renderedBody = renderBillingNotificationTemplate(String(template.body_template), variables);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("billing_notification_dispatches")
    .insert({
      user_id: input.userId,
      template_key: input.templateKey,
      channel,
      status: BILLING_NOTIFICATION_DISPATCH_STATUS.SENT,
      variables,
      rendered_subject: renderedSubject,
      rendered_body: renderedBody,
      timeline_event_id: input.timelineEventId ?? null,
      subscription_id: input.subscriptionId ?? null,
      sent_at: now,
      correlation_id: input.correlationId ?? null,
      request_id: input.requestId ?? null,
      metadata: {},
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();

  if (error) {
    logBillingError("billing", "notification_dispatch_failed", error, {
      user_id: input.userId,
      template_key: input.templateKey,
    });
    throw error;
  }

  logBilling("billing", BILLING_PHASE30_LOG.NOTIFICATION_DISPATCHED, {
    user_id: input.userId,
    dispatch_id: data.id,
    template_key: input.templateKey,
    channel,
  });

  try {
    await publishBillingCentralNotification(supabase, {
      userId: input.userId,
      templateKey: input.templateKey,
      variables,
      correlationId: input.correlationId ?? null,
      idempotencyKey:
        input.timelineEventId != null
          ? `billing:dispatch:${input.timelineEventId}:${input.templateKey}`
          : input.correlationId != null
            ? `billing:dispatch:${input.correlationId}:${input.templateKey}`
            : null,
      subscriptionId: input.subscriptionId ?? null,
      timelineEventId: input.timelineEventId ?? null,
    });
  } catch (centralErr) {
    logBillingError("billing", "central_notification_after_billing_dispatch", centralErr, {
      user_id: input.userId,
      template_key: input.templateKey,
    });
  }

  return data;
}

/**
 * Ponte renewal hooks → notification center.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} renewalEventType
 * @param {Record<string, unknown>} ctx
 */
export async function dispatchRenewalNotificationFromHook(supabase, renewalEventType, ctx) {
  const templateKey = RENEWAL_EVENT_TO_TEMPLATE_KEY[renewalEventType];
  if (!templateKey) return null;

  const userId = ctx.user_id != null ? String(ctx.user_id) : null;
  if (!userId) return null;

  return enqueueBillingNotification(supabase, {
    userId,
    templateKey,
    subscriptionId: ctx.subscription_id != null ? String(ctx.subscription_id) : null,
    variables: {
      plan_name: ctx.plan_key ?? ctx.plan_name ?? "seu plano",
      grace_ends_at: ctx.grace_period_until ?? ctx.grace_ends_at ?? "",
      target_plan_name: ctx.target_plan_name ?? "",
      change_mode: ctx.change_mode ?? "",
      limit_label: ctx.limit_label ?? "",
    },
    correlationId: ctx.correlation_id != null ? String(ctx.correlation_id) : null,
    requestId: ctx.request_id != null ? String(ctx.request_id) : null,
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ limit?: number }} [options]
 */
export async function listBillingNotificationsForUser(supabase, userId, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.min(50, Number(options.limit))) : 20;
  const { data, error } = await supabase
    .from("billing_notification_dispatches")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}
