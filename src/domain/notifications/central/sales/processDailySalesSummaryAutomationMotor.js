// =============================================================================
// Motor automático — SALES:DAILY_SALES_SUMMARY
// =============================================================================

import { buildSaleExecutiveSummary } from "../../../sales/buildSaleExecutiveSummary.js";
import { DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN } from "./dailySalesSummaryAutomationConstants.js";
import { listActiveDailySalesSummaryAutomationRules } from "./dailySalesSummaryAutomationRuleService.js";
import {
  calculateDailySalesSummaryWindow,
  explainDailySalesScheduleSlot,
  formatBrtLogTimestamp,
} from "./dailySalesSummaryWindow.js";
import { triggerDailySalesSummaryNotification } from "./triggerDailySalesSummaryNotification.js";
import { logCentralNotification } from "../observability/centralNotificationLog.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} rule
 * @param {Date} nowUtc
 */
async function processDailySalesSummaryRule(supabase, rule, nowUtc) {
  const config = rule.config && typeof rule.config === "object" ? rule.config : {};
  const weekdays = Array.isArray(config.weekdays) ? config.weekdays : [];
  const times = Array.isArray(config.times) ? config.times : [];
  const channels =
    config.channels && typeof config.channels === "object"
      ? /** @type {Record<string, boolean>} */ (config.channels)
      : {};

  const sellerId = String(rule.seller_id);

  logCentralNotification("DAILY_SALES_SUMMARY_RULE_SCAN", {
    seller_id: sellerId,
    enabled: rule.enabled !== false,
    weekdays,
    times,
    channels,
    timezone: config.timezone ?? "America/Sao_Paulo",
    last_successful_run_at: rule.last_successful_run_at ?? null,
    now_utc: nowUtc.toISOString(),
    now_brt: formatBrtLogTimestamp(nowUtc),
    tolerance_min: DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN,
  });

  const slotExplain = explainDailySalesScheduleSlot(
    nowUtc,
    weekdays,
    times,
    DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN,
  );

  if (!slotExplain.matched || !slotExplain.scheduled_at || !slotExplain.time) {
    logCentralNotification("DAILY_SALES_SUMMARY_RULE_SKIP", {
      seller_id: sellerId,
      reason: slotExplain.debug?.reason ?? "no_slot",
      ...slotExplain.debug,
    });
    return { status: "skipped", reason: slotExplain.debug?.reason ?? "no_slot" };
  }

  const scheduledAt = slotExplain.scheduled_at;

  logCentralNotification("DAILY_SALES_SUMMARY_SLOT_MATCH", {
    seller_id: sellerId,
    scheduled_at: scheduledAt.toISOString(),
    scheduled_time: slotExplain.time,
    ...slotExplain.debug,
  });

  const { data: existingRun } = await supabase
    .from("s7_notification_automation_runs")
    .select("id, status")
    .eq("seller_id", sellerId)
    .eq("category_code", rule.category_code)
    .eq("type_key", rule.type_key)
    .eq("scheduled_at", scheduledAt.toISOString())
    .maybeSingle();

  if (existingRun?.status === "completed") {
    logCentralNotification("DAILY_SALES_SUMMARY_RULE_SKIP", {
      seller_id: sellerId,
      reason: "already_completed",
      scheduled_at: scheduledAt.toISOString(),
      run_id: existingRun.id,
    });
    return { status: "skipped", reason: "already_completed" };
  }

  const window = calculateDailySalesSummaryWindow({
    lastSuccessfulRunAt: rule.last_successful_run_at,
    scheduledAt,
    timezone: config.timezone,
  });

  logCentralNotification("DAILY_SALES_SUMMARY_WINDOW", {
    seller_id: sellerId,
    scheduled_at: scheduledAt.toISOString(),
    period_start: window.period_start.toISOString(),
    period_end: window.period_end.toISOString(),
    window_fallback: window.fallback,
  });

  const { data: runRow, error: runInsertErr } = await supabase
    .from("s7_notification_automation_runs")
    .upsert(
      {
        seller_id: sellerId,
        category_code: rule.category_code,
        type_key: rule.type_key,
        scheduled_at: scheduledAt.toISOString(),
        period_start: window.period_start.toISOString(),
        period_end: window.period_end.toISOString(),
        status: "processing",
        metadata: { window_fallback: window.fallback },
      },
      { onConflict: "seller_id,category_code,type_key,scheduled_at", ignoreDuplicates: false },
    )
    .select("id")
    .maybeSingle();

  if (runInsertErr) {
    if (String(runInsertErr.code) === "23505") {
      logCentralNotification("DAILY_SALES_SUMMARY_RULE_SKIP", {
        seller_id: sellerId,
        reason: "duplicate_run",
        scheduled_at: scheduledAt.toISOString(),
      });
      return { status: "skipped", reason: "duplicate_run" };
    }
    throw runInsertErr;
  }

  try {
    const executivePayload = await buildSaleExecutiveSummary(
      supabase,
      sellerId,
      {
        period: {
          preset: "custom",
          start_date: window.period_start.toISOString().slice(0, 10),
          end_date: new Date(window.period_end.getTime() - 86_400_000).toISOString().slice(0, 10),
          start_ms: window.period_start.getTime(),
          end_ms_exclusive: window.period_end.getTime(),
        },
      },
    );

    const published = await triggerDailySalesSummaryNotification(supabase, {
      sellerId,
      scheduledAt,
      periodStart: window.period_start,
      periodEnd: window.period_end,
      executivePayload,
      channels,
    });

    if (!published.ok) {
      throw new Error(String(published.error ?? "PUBLISH_FAILED"));
    }

    const completedAt = new Date().toISOString();
    await supabase
      .from("s7_notification_automation_runs")
      .update({
        status: "completed",
        event_id: published.event?.id ?? null,
        completed_at: completedAt,
      })
      .eq("id", runRow?.id);

    await supabase
      .from("s7_notification_automation_rules")
      .update({ last_successful_run_at: scheduledAt.toISOString(), updated_at: completedAt })
      .eq("seller_id", sellerId)
      .eq("category_code", rule.category_code)
      .eq("type_key", rule.type_key);

    logCentralNotification("DAILY_SALES_SUMMARY_RULE_COMPLETED", {
      seller_id: sellerId,
      scheduled_at: scheduledAt.toISOString(),
      event_id: published.event?.id ?? null,
      run_id: runRow?.id ?? null,
      channels,
    });

    return { status: "completed", event_id: published.event?.id ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from("s7_notification_automation_runs")
      .update({
        status: "failed",
        error_message: message.slice(0, 500),
        completed_at: new Date().toISOString(),
      })
      .eq("id", runRow?.id);

    logCentralNotification("DAILY_SALES_SUMMARY_RULE_FAILED", {
      seller_id: sellerId,
      scheduled_at: scheduledAt.toISOString(),
      run_id: runRow?.id ?? null,
      error: message,
    });

    return { status: "failed", error: message };
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ now?: Date; limit?: number }} [options]
 */
export async function processDailySalesSummaryAutomationMotor(supabase, options = {}) {
  const nowUtc = options.now instanceof Date ? options.now : new Date();
  const limit = Number.isFinite(options.limit) ? Number(options.limit) : 200;

  logCentralNotification("DAILY_SALES_SUMMARY_MOTOR_START", {
    now_utc: nowUtc.toISOString(),
    now_brt: formatBrtLogTimestamp(nowUtc),
    tolerance_min: DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN,
    limit,
  });

  const rules = await listActiveDailySalesSummaryAutomationRules(supabase);
  const slice = rules.slice(0, limit);

  logCentralNotification("DAILY_SALES_SUMMARY_MOTOR_RULES", {
    active_rules: rules.length,
    scanning: slice.length,
  });

  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  for (const rule of slice) {
    try {
      const outcome = await processDailySalesSummaryRule(supabase, rule, nowUtc);
      results.push({ seller_id: rule.seller_id, ...outcome });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logCentralNotification("DAILY_SALES_SUMMARY_RULE_ERR", {
        seller_id: rule.seller_id,
        message,
      });
      results.push({ seller_id: rule.seller_id, status: "failed", error: message });
    }
  }

  const summary = {
    scanned: slice.length,
    completed: results.filter((r) => r.status === "completed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    results,
  };

  logCentralNotification("DAILY_SALES_SUMMARY_MOTOR_OK", summary);

  return summary;
}
