// =============================================================================
// Disparo automático — SALES:DAILY_SALES_SUMMARY
// =============================================================================

import { S7_NOTIFICATION_CHANNEL } from "../constants/channels.js";
import { publishNotificationEvent } from "../events/publishNotificationEvent.js";
import {
  DAILY_SALES_SUMMARY_CATEGORY,
  DAILY_SALES_SUMMARY_TYPE,
} from "./dailySalesSummaryAutomationConstants.js";
import {
  buildDailySalesSummaryIdempotencyKey,
  buildDailySalesSummaryTemplatePayload,
} from "./buildDailySalesSummaryTemplatePayload.js";

/**
 * @param {{ in_app?: boolean; email?: boolean; whatsapp?: boolean; popup?: boolean }} channels
 */
function resolveEnabledChannels(channels) {
  /** @type {string[]} */
  const list = [];
  // Regra de produto: canal interno sempre gera sininho.
  list.push(S7_NOTIFICATION_CHANNEL.IN_APP);
  if (channels.email !== false) list.push(S7_NOTIFICATION_CHANNEL.EMAIL);
  if (channels.whatsapp !== false) list.push(S7_NOTIFICATION_CHANNEL.WHATSAPP);
  return list;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   sellerId: string;
 *   scheduledAt: Date;
 *   periodStart: Date;
 *   periodEnd: Date;
 *   executivePayload: Record<string, unknown>;
 *   channels: Record<string, boolean>;
 * }} input
 */
export async function triggerDailySalesSummaryNotification(supabase, input) {
  const templatePayloadBase = buildDailySalesSummaryTemplatePayload(
    input.executivePayload,
    { period_start: input.periodStart, period_end: input.periodEnd },
  );
  const channelsConfig =
    input.channels && typeof input.channels === "object"
      ? {
          in_app: true,
          popup: input.channels.popup !== false,
          email: input.channels.email !== false,
          whatsapp: input.channels.whatsapp !== false,
        }
      : {
          in_app: true,
          popup: true,
          email: true,
          whatsapp: true,
        };
  const templatePayload = {
    ...templatePayloadBase,
    channels: channelsConfig,
  };

  const scheduledIso = input.scheduledAt.toISOString();
  const channelsFilter = resolveEnabledChannels(channelsConfig);

  const published = await publishNotificationEvent(supabase, {
    category: DAILY_SALES_SUMMARY_CATEGORY,
    type: DAILY_SALES_SUMMARY_TYPE,
    seller_id: input.sellerId,
    payload: templatePayload,
    correlation_id: `sales.daily-summary.${input.sellerId}.${scheduledIso}`,
    idempotency_key: buildDailySalesSummaryIdempotencyKey(input.sellerId, input.scheduledAt),
    entity_type: "daily_sales_summary",
    entity_id: scheduledIso,
    source_module: "vendas_daily_summary_automation",
    dispatch_options: {
      channels_filter: channelsFilter,
    },
    metadata: {
      period_start: input.periodStart.toISOString(),
      period_end: input.periodEnd.toISOString(),
      scheduled_at: scheduledIso,
      assets_mode: "template_only",
      channels: channelsConfig,
    },
  });

  return published;
}
