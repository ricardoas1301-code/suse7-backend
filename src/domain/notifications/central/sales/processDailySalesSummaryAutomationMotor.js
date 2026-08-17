// =============================================================================
// Motor automático — SALES:DAILY_SALES_SUMMARY
// =============================================================================

import { buildSaleExecutiveSummary } from "../../../sales/buildSaleExecutiveSummary.js";
import { DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN } from "./dailySalesSummaryAutomationConstants.js";
import { listActiveDailySalesSummaryAutomationRules } from "./dailySalesSummaryAutomationRuleService.js";
import {
  buildBrtScheduledAtUtc,
  calculateDailySalesSummaryWindow,
  explainDailySalesScheduleSlot,
  formatBrtLogTimestamp,
  toBrtParts,
} from "./dailySalesSummaryWindow.js";
import { triggerDailySalesSummaryNotification } from "./triggerDailySalesSummaryNotification.js";
import { logCentralNotification } from "../observability/centralNotificationLog.js";

const DAILY_SALES_SUMMARY_SLOT_LOOKBACK_MIN = 90;
const DAILY_SALES_SUMMARY_MOTOR_DEFAULT_CONCURRENCY = 4;

/**
 * @param {Array<Record<string, unknown>>} rules
 * @param {number} concurrency
 * @param {(rule: Record<string, unknown>) => Promise<void>} handler
 */
async function processRulesWithConcurrency(rules, concurrency, handler) {
  if (!Array.isArray(rules) || rules.length === 0) return;
  const workers = Math.max(1, Math.min(Number(concurrency) || 1, rules.length));
  let nextIndex = 0;

  const workerRuns = Array.from({ length: workers }, async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= rules.length) break;
      await handler(rules[current]);
    }
  });
  await Promise.all(workerRuns);
}

/**
 * @param {Date} startUtc
 * @param {Date} endUtc
 */
function listBrtDateKeysBetween(startUtc, endUtc) {
  const keys = [];
  const startKey = toBrtParts(startUtc).dateKey;
  const endKey = toBrtParts(endUtc).dateKey;
  let cursor = buildBrtScheduledAtUtc(startKey, "00:00");
  const end = buildBrtScheduledAtUtc(endKey, "00:00");
  if (!cursor || !end) return keys;
  while (cursor.getTime() <= end.getTime()) {
    keys.push(toBrtParts(cursor).dateKey);
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return keys;
}

/**
 * @param {{
 *  nowUtc: Date;
 *  lowerBoundUtc: Date;
 *  weekdays: readonly number[];
 *  times: readonly string[];
 *  toleranceMin: number;
 * }} input
 */
function resolveDueDailySalesSlots(input) {
  const weekdays = new Set(input.weekdays ?? []);
  const due = [];
  const seen = new Set();
  const dateKeys = listBrtDateKeysBetween(input.lowerBoundUtc, input.nowUtc);
  for (const dateKey of dateKeys) {
    for (const time of input.times ?? []) {
      const scheduled = buildBrtScheduledAtUtc(dateKey, time);
      if (!scheduled) continue;
      const key = scheduled.toISOString();
      if (seen.has(key)) continue;
      seen.add(key);

      if (!weekdays.has(toBrtParts(scheduled).weekday)) continue;
      if (scheduled.getTime() < input.lowerBoundUtc.getTime()) continue;
      // Nunca processar slot futuro: o motor só pode executar quando o horário já chegou.
      if (scheduled.getTime() > input.nowUtc.getTime()) continue;
      due.push({ scheduled_at: scheduled, time });
    }
  }
  due.sort((a, b) => a.scheduled_at.getTime() - b.scheduled_at.getTime());
  return due;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} rule
 * @param {Date} nowUtc
 */
async function processDailySalesSummaryRule(supabase, rule, nowUtc) {
  const ruleStartedAtIso = new Date().toISOString();
  const ruleStartedAtMs = Date.now();
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
    updated_at: rule.updated_at ?? null,
    now_utc: nowUtc.toISOString(),
    now_brt: formatBrtLogTimestamp(nowUtc),
    tolerance_min: DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN,
  });

  const slotExplain = explainDailySalesScheduleSlot(
    nowUtc,
    weekdays,
    times,
    DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN
  );

  const lookbackFloor = new Date(
    nowUtc.getTime() - DAILY_SALES_SUMMARY_SLOT_LOOKBACK_MIN * 60_000
  );
  const lowerBoundCandidates = [lookbackFloor];
  if (
    rule.last_successful_run_at != null &&
    String(rule.last_successful_run_at).trim() !== ""
  ) {
    const last = new Date(String(rule.last_successful_run_at));
    if (Number.isFinite(last.getTime())) lowerBoundCandidates.push(new Date(last.getTime() + 1000));
  }
  const lowerBoundUtc = new Date(
    Math.max(...lowerBoundCandidates.map((d) => d.getTime()))
  );
  const dueSlots = resolveDueDailySalesSlots({
    nowUtc,
    lowerBoundUtc,
    weekdays,
    times,
    toleranceMin: DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN,
  });

  logCentralNotification("DAILY_SALES_SUMMARY_DUE_SLOTS", {
    seller_id: sellerId,
    lower_bound_utc: lowerBoundUtc.toISOString(),
    due_slots: dueSlots.map((s) => s.scheduled_at.toISOString()),
    slot_probe_reason: slotExplain.debug?.reason ?? null,
  });
  const dueScheduledTimes = dueSlots.map((slot) => slot.scheduled_at.toISOString());

  if (dueSlots.length === 0) {
    const finishedAtIso = new Date().toISOString();
    logCentralNotification("DAILY_SALES_SUMMARY_RULE_PERF", {
      seller_id: sellerId,
      started_at: ruleStartedAtIso,
      finished_at: finishedAtIso,
      duration_ms: Date.now() - ruleStartedAtMs,
      processed_count: 0,
      success_count: 0,
      failed_count: 0,
      scheduled_time: null,
    });
    logCentralNotification("DAILY_SALES_SUMMARY_RULE_SKIP", {
      seller_id: sellerId,
      reason: "no_due_slot",
      ...slotExplain.debug,
    });
    return { status: "skipped", reason: "no_due_slot", scheduled_times: [] };
  }

  let rollingLastSuccessfulAt = rule.last_successful_run_at;
  let completedCount = 0;
  /** @type {string[]} */
  const eventIds = [];

  for (const slot of dueSlots) {
    const scheduledAt = slot.scheduled_at;
    logCentralNotification("DAILY_SALES_SUMMARY_SLOT_MATCH", {
      seller_id: sellerId,
      scheduled_at: scheduledAt.toISOString(),
      scheduled_time: slot.time,
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
      rollingLastSuccessfulAt = scheduledAt.toISOString();
      continue;
    }

    const window = calculateDailySalesSummaryWindow({
      lastSuccessfulRunAt: rollingLastSuccessfulAt,
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
        { onConflict: "seller_id,category_code,type_key,scheduled_at", ignoreDuplicates: false }
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
        continue;
      }
      throw runInsertErr;
    }

    logCentralNotification("DAILY_SALES_SUMMARY_RUN_CREATED", {
      seller_id: sellerId,
      scheduled_at: scheduledAt.toISOString(),
      run_id: runRow?.id ?? null,
      period_start: window.period_start.toISOString(),
      period_end: window.period_end.toISOString(),
      window_fallback: window.fallback,
    });

    try {
      const executivePayload = await buildSaleExecutiveSummary(supabase, sellerId, {
        period: {
          preset: "custom",
          start_date: window.period_start.toISOString().slice(0, 10),
          end_date: new Date(window.period_end.getTime() - 86_400_000).toISOString().slice(0, 10),
          start_ms: window.period_start.getTime(),
          end_ms_exclusive: window.period_end.getTime(),
        },
      });

      const published = await triggerDailySalesSummaryNotification(supabase, {
        sellerId,
        scheduledAt,
        periodStart: window.period_start,
        periodEnd: window.period_end,
        executivePayload,
        channels,
      });

      if (!published.ok) throw new Error(String(published.error ?? "PUBLISH_FAILED"));

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

      completedCount += 1;
      if (published.event?.id) eventIds.push(String(published.event.id));
      rollingLastSuccessfulAt = scheduledAt.toISOString();
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

      return { status: "failed", error: message, scheduled_times: dueScheduledTimes };
    }
  }

  if (completedCount > 0) {
    const finishedAtIso = new Date().toISOString();
    logCentralNotification("DAILY_SALES_SUMMARY_RULE_PERF", {
      seller_id: sellerId,
      started_at: ruleStartedAtIso,
      finished_at: finishedAtIso,
      duration_ms: Date.now() - ruleStartedAtMs,
      processed_count: dueSlots.length,
      success_count: completedCount,
      failed_count: 0,
      scheduled_time: dueSlots.map((slot) => slot.scheduled_at.toISOString()),
    });
    return {
      status: "completed",
      completed_slots: completedCount,
      events: eventIds,
      scheduled_times: dueScheduledTimes,
    };
  }
  const finishedAtIso = new Date().toISOString();
  logCentralNotification("DAILY_SALES_SUMMARY_RULE_PERF", {
    seller_id: sellerId,
    started_at: ruleStartedAtIso,
    finished_at: finishedAtIso,
    duration_ms: Date.now() - ruleStartedAtMs,
    processed_count: dueSlots.length,
    success_count: 0,
    failed_count: 0,
    scheduled_time: dueSlots.map((slot) => slot.scheduled_at.toISOString()),
  });
  return { status: "skipped", reason: "no_new_slot", scheduled_times: dueScheduledTimes };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ now?: Date; limit?: number }} [options]
 */
export async function processDailySalesSummaryAutomationMotor(supabase, options = {}) {
  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();
  const nowUtc = options.now instanceof Date ? options.now : new Date();
  const limit = Number.isFinite(options.limit) ? Number(options.limit) : 200;
  const concurrency = Number.isFinite(options.concurrency)
    ? Math.max(1, Number(options.concurrency))
    : DAILY_SALES_SUMMARY_MOTOR_DEFAULT_CONCURRENCY;

  logCentralNotification("DAILY_SALES_SUMMARY_MOTOR_START", {
    now_utc: nowUtc.toISOString(),
    now_brt: formatBrtLogTimestamp(nowUtc),
    tolerance_min: DAILY_SALES_SUMMARY_SCHEDULE_TOLERANCE_MIN,
    lookback_min: DAILY_SALES_SUMMARY_SLOT_LOOKBACK_MIN,
    limit,
    concurrency,
  });

  const rules = await listActiveDailySalesSummaryAutomationRules(supabase);
  const slice = rules.slice(0, limit);

  logCentralNotification("DAILY_SALES_SUMMARY_MOTOR_RULES", {
    active_rules: rules.length,
    scanning: slice.length,
  });

  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  /** @type {Array<Record<string, unknown>>} */
  const sellerExecutions = [];
  await processRulesWithConcurrency(slice, concurrency, async (rule) => {
    const sellerStartedAtIso = new Date().toISOString();
    const sellerStartedAtMs = Date.now();
    try {
      const outcome = await processDailySalesSummaryRule(supabase, rule, nowUtc);
      const sellerFinishedAtIso = new Date().toISOString();
      const sellerResult = { seller_id: rule.seller_id, ...outcome };
      results.push(sellerResult);
      sellerExecutions.push({
        seller_id: rule.seller_id,
        started_at: sellerStartedAtIso,
        finished_at: sellerFinishedAtIso,
        duration_ms: Date.now() - sellerStartedAtMs,
        status: outcome.status,
        processed_count:
          outcome.status === "completed"
            ? Number(outcome.completed_slots ?? 0)
            : outcome.status === "failed"
              ? 1
              : 0,
        success_count: outcome.status === "completed" ? Number(outcome.completed_slots ?? 0) : 0,
        failed_count: outcome.status === "failed" ? 1 : 0,
        scheduled_time: Array.isArray(outcome.scheduled_times) ? outcome.scheduled_times : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logCentralNotification("DAILY_SALES_SUMMARY_RULE_ERR", {
        seller_id: rule.seller_id,
        message,
      });
      results.push({ seller_id: rule.seller_id, status: "failed", error: message });
      sellerExecutions.push({
        seller_id: rule.seller_id,
        started_at: sellerStartedAtIso,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - sellerStartedAtMs,
        status: "failed",
        processed_count: 1,
        success_count: 0,
        failed_count: 1,
        scheduled_time: null,
      });
    }
  });

  const finishedAtIso = new Date().toISOString();
  const summary = {
    started_at: startedAtIso,
    finished_at: finishedAtIso,
    duration_ms: Date.now() - startedAtMs,
    scanned: slice.length,
    processed_count: results.length,
    success_count: results.filter((r) => r.status === "completed").length,
    failed_count: results.filter((r) => r.status === "failed").length,
    completed: results.filter((r) => r.status === "completed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    seller_executions: sellerExecutions,
    results,
  };

  logCentralNotification("DAILY_SALES_SUMMARY_MOTOR_OK", summary);
  return summary;
}


