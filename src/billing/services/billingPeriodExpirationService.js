// ======================================================================
// Expiração de ciclo — cancelamento para Baby e downgrade agendado
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { recordBillingEvent } from "../billingEventService.js";
import { readSubscriptionCancellation } from "./billingSubscriptionCancelService.js";
import { readSubscriptionPlanChange } from "./billingSubscriptionChangePlanService.js";
import {
  activateOrCreateScheduledDowngradeTargetSubscription,
  resolveScheduledDowngradeTargetPlan,
} from "./billingScheduledDowngradeApplicationService.js";
import { activateOrCreateInternalBabySubscription } from "./internalBabyPlanService.js";

const ELIGIBLE_STATUSES = new Set([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.PENDING]);

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 */
function parsePeriodEnd(value) {
  if (value == null || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * @param {Record<string, unknown>} metadata
 */
function hasDowngradeAlreadyApplied(metadata) {
  const meta = asObject(metadata) ?? {};
  if (typeof meta.downgrade_applied_at === "string" && meta.downgrade_applied_at.trim() !== "") return true;
  if (typeof meta.plan_change_applied_at === "string" && meta.plan_change_applied_at.trim() !== "") return true;
  return false;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Date} now
 */
function isDueForPeriodExpiration(row, now) {
  if (hasDowngradeAlreadyApplied(row.metadata)) return false;

  const cancellation = readSubscriptionCancellation(row.metadata);
  const planChange = readSubscriptionPlanChange(row.metadata);
  if (!cancellation.cancel_at_period_end && !planChange.plan_change_at_period_end) return false;

  const periodEnd = parsePeriodEnd(row.current_period_end);
  if (!periodEnd) return false;
  return periodEnd.getTime() <= now.getTime();
}

/**
 * @param {Record<string, unknown>} row
 */
function resolvePeriodExpirationKind(row) {
  const planChange = readSubscriptionPlanChange(row.metadata);
  if (planChange.plan_change_at_period_end) return "scheduled_plan_downgrade";
  const cancellation = readSubscriptionCancellation(row.metadata);
  if (cancellation.cancel_at_period_end) return "cancel_to_baby";
  return null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Date} now
 */
async function listDuePeriodExpirations(supabase, now) {
  const nowIso = now.toISOString();
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select(
      "id, user_id, plan_id, plan_key, provider, provider_customer_id, provider_subscription_id, status, current_period_start, current_period_end, metadata, canceled_at"
    )
    .in("status", [...ELIGIBLE_STATUSES])
    .not("current_period_end", "is", null)
    .lte("current_period_end", nowIso)
    .order("current_period_end", { ascending: true })
    .limit(200);
  if (error) throw error;
  return (Array.isArray(data) ? data : []).filter((row) => isDueForPeriodExpiration(row, now));
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} paidSubscription
 * @param {Date} now
 * @param {Record<string, unknown>} babyResult
 */
async function recordDowngradeToBabyEvent(supabase, paidSubscription, now, babyResult) {
  const paidId = String(paidSubscription.id);
  const userId = String(paidSubscription.user_id);
  try {
    await recordBillingEvent(supabase, {
      provider: "suse7",
      providerEventId: `downgrade:${paidId}`,
      eventType: "BILLING_DOWNGRADED_TO_BABY",
      rawPayload: {
        user_id: userId,
        paid_subscription_id: paidId,
        baby_subscription_id: babyResult.subscription_id ?? null,
        downgrade_target_plan_key: readSubscriptionCancellation(paidSubscription.metadata).downgrade_target_plan_key,
        applied_at: now.toISOString(),
        current_period_end: paidSubscription.current_period_end ?? null,
      },
    });
  } catch (error) {
    logBillingError("billing", "downgrade_event_failed", error, { user_id: userId, subscription_id: paidId });
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} paidSubscription
 * @param {Date} now
 * @param {Record<string, unknown>} targetResult
 * @param {import("./billingPlanRepository.js").Suse7PlanRow} targetPlan
 */
async function recordDowngradeToPlanEvent(supabase, paidSubscription, now, targetResult, targetPlan) {
  const paidId = String(paidSubscription.id);
  const userId = String(paidSubscription.user_id);
  const planChange = readSubscriptionPlanChange(paidSubscription.metadata);
  try {
    await recordBillingEvent(supabase, {
      provider: "suse7",
      providerEventId: `downgrade_to_plan:${paidId}`,
      eventType: "BILLING_DOWNGRADED_TO_PLAN",
      rawPayload: {
        user_id: userId,
        paid_subscription_id: paidId,
        target_subscription_id: targetResult.subscription_id ?? null,
        target_plan_id: targetPlan.id,
        target_plan_key: targetPlan.plan_key,
        target_plan_slug: planChange.plan_change_target_plan_slug,
        applied_at: now.toISOString(),
        current_period_end: paidSubscription.current_period_end ?? null,
      },
    });
  } catch (error) {
    logBillingError("billing", "downgrade_to_plan_event_failed", error, { user_id: userId, subscription_id: paidId });
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} paidSubscription
 * @param {Date} now
 * @param {{ kind: "cancel_to_baby" | "scheduled_plan_downgrade" }} options
 */
async function expirePaidSubscriptionForDowngrade(supabase, paidSubscription, now, options) {
  const paidId = String(paidSubscription.id);
  const userId = String(paidSubscription.user_id);
  const appliedAt = now.toISOString();
  const planChange = readSubscriptionPlanChange(paidSubscription.metadata);
  const metadata = {
    ...(asObject(paidSubscription.metadata) ?? {}),
    downgrade_applied_at: appliedAt,
    period_expired_at: appliedAt,
  };

  if (options.kind === "scheduled_plan_downgrade") {
    metadata.plan_change_applied_at = appliedAt;
    metadata.plan_change_target_plan_slug = planChange.plan_change_target_plan_slug;
    metadata.plan_change_target_plan_id = planChange.plan_change_target_plan_id;
    metadata.plan_change_target_plan_key = planChange.plan_change_target_plan_slug;
  } else {
    metadata.downgrade_target_plan_key = readSubscriptionCancellation(paidSubscription.metadata).downgrade_target_plan_key;
  }

  const { data, error } = await supabase
    .from("billing_subscriptions")
    .update({
      status: SUBSCRIPTION_STATUS.CANCELED,
      canceled_at: paidSubscription.canceled_at ?? appliedAt,
      metadata,
      updated_at: appliedAt,
    })
    .eq("id", paidId)
    .eq("user_id", userId)
    .select(
      "id, user_id, plan_id, plan_key, provider, provider_customer_id, status, current_period_start, current_period_end, metadata, canceled_at"
    )
    .single();
  if (error) throw error;
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} paidSubscription
 * @param {Date} now
 */
async function processCancelToBabyExpiration(supabase, paidSubscription, now) {
  const paidId = String(paidSubscription.id);
  const userId = String(paidSubscription.user_id);

  const expired = await expirePaidSubscriptionForDowngrade(supabase, paidSubscription, now, { kind: "cancel_to_baby" });
  const baby = await activateOrCreateInternalBabySubscription(supabase, userId, {
    downgrade_from_subscription_id: paidId,
    source: "period_expiration_downgrade",
  });
  await recordDowngradeToBabyEvent(supabase, expired, now, baby);

  logBilling("billing", "period_expiration_downgraded", {
    user_id: userId,
    paid_subscription_id: paidId,
    baby_subscription_id: baby.subscription_id ?? null,
    idempotent: Boolean(baby.idempotent),
    kind: "cancel_to_baby",
  });

  return {
    kind: "cancel_to_baby",
    user_id: userId,
    paid_subscription_id: paidId,
    baby_subscription_id: baby.subscription_id ?? null,
    baby_created: Boolean(baby.created),
    idempotent: Boolean(baby.idempotent),
    downgrade_target_plan_key: readSubscriptionCancellation(expired.metadata).downgrade_target_plan_key,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} paidSubscription
 * @param {Date} now
 */
async function processScheduledPlanDowngradeExpiration(supabase, paidSubscription, now) {
  const paidId = String(paidSubscription.id);
  const userId = String(paidSubscription.user_id);
  const planChange = readSubscriptionPlanChange(paidSubscription.metadata);
  const targetPlan = await resolveScheduledDowngradeTargetPlan(supabase, planChange);
  if (!targetPlan) {
    const err = new Error("SCHEDULED_DOWNGRADE_TARGET_PLAN_NOT_FOUND");
    /** @type {any} */ (err).code = "SCHEDULED_DOWNGRADE_TARGET_PLAN_NOT_FOUND";
    throw err;
  }

  const expired = await expirePaidSubscriptionForDowngrade(supabase, paidSubscription, now, {
    kind: "scheduled_plan_downgrade",
  });
  const target = await activateOrCreateScheduledDowngradeTargetSubscription({
    supabase,
    userId,
    fromSubscription: expired,
    targetPlan,
    now,
  });
  await recordDowngradeToPlanEvent(supabase, expired, now, target, targetPlan);

  logBilling("billing", "period_expiration_downgraded", {
    user_id: userId,
    paid_subscription_id: paidId,
    target_subscription_id: target.subscription_id ?? null,
    target_plan_key: targetPlan.plan_key,
    idempotent: Boolean(target.idempotent),
    kind: "scheduled_plan_downgrade",
  });

  return {
    kind: "scheduled_plan_downgrade",
    user_id: userId,
    paid_subscription_id: paidId,
    target_subscription_id: target.subscription_id ?? null,
    target_plan_id: targetPlan.id,
    target_plan_key: targetPlan.plan_key,
    target_created: Boolean(target.created),
    idempotent: Boolean(target.idempotent),
    plan_change_target_plan_slug: planChange.plan_change_target_plan_slug,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} paidSubscription
 * @param {Date} now
 */
async function processSinglePeriodExpiration(supabase, paidSubscription, now) {
  const expirationKind = resolvePeriodExpirationKind(paidSubscription);
  if (expirationKind === "scheduled_plan_downgrade") {
    return processScheduledPlanDowngradeExpiration(supabase, paidSubscription, now);
  }
  return processCancelToBabyExpiration(supabase, paidSubscription, now);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ now?: Date; limit?: number }} [options]
 */
export async function processBillingPeriodExpirations(supabase, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const dueRows = await listDuePeriodExpirations(supabase, now);
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : dueRows.length;
  const selected = dueRows.slice(0, limit);

  /** @type {Array<Record<string, unknown>>} */
  const processed = [];
  /** @type {Array<{ subscription_id: string; message: string }>} */
  const failures = [];

  for (const row of selected) {
    try {
      const result = await processSinglePeriodExpiration(supabase, row, now);
      processed.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ subscription_id: String(row.id), message });
      logBillingError("billing", "period_expiration_failed", error, {
        subscription_id: row.id,
        user_id: row.user_id,
      });
    }
  }

  return {
    scanned: dueRows.length,
    selected: selected.length,
    processed_count: processed.length,
    failed_count: failures.length,
    processed,
    failures,
  };
}
