// ======================================================================
// Motor oficial de renovação — Fase 2 (assinatura × pagamento × ciclo)
// ======================================================================

import {
  BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT,
  BILLING_RENEWAL_PRE_RENEWAL_DAYS_DEFAULT,
  DELINQUENCY_STATUS,
  RENEWAL_AUTO_CHARGE_STATUS,
  RENEWAL_ENGINE_LOG,
  RENEWAL_CYCLE_OPEN_STATUSES,
  RENEWAL_STATUS,
  RENEWAL_STRATEGY,
  RENEWAL_SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUS,
} from "../billingConstants.js";
import { logBilling, logBillingError, logBillingTestTransition } from "../billingLog.js";
import { isBillingRenewalTestAccelerated } from "./billingRenewalTestTime.js";
import { resolveSubscriptionBillingCycle } from "./billingCycleService.js";
import { getActivePlanById } from "./billingPlanRepository.js";
import { cancelOrphanAsaasSubscriptionsForUser } from "./billingOrphanAsaasSubscriptionService.js";
import { assertRenewalPlanMatchesActiveSubscription } from "./billingRenewalService.js";
import {
  daysUntilRenewalDue,
  findRenewalCycleByIdempotency,
  insertRenewalCycle,
  listSubscriptionsApproachingRenewal,
  reconcileOpenRenewalCyclesForSubscription,
  updateRenewalCycle,
} from "./billingRenewalCycleRepository.js";
import { isManualRenewalStrategy } from "./billingPendingRenewalPresentationService.js";
import { resolveRenewalStrategyForSubscription } from "./billingRenewalStrategyService.js";
import { attemptAutoCardRenewalCharge } from "./billingRenewalPaymentService.js";
import {
  emitRenewalNotificationHook,
  emitRenewalPreAlertHooks,
  RENEWAL_NOTIFICATION_EVENT,
} from "./billingRenewalNotificationHooks.js";
import { isAsaasPaymentConfirmedStatus } from "./billingSubscriptionActivationService.js";
import {
  emitBillingFinancialSignal,
  BILLING_TIMELINE_EVENT,
  BILLING_TIMELINE_SEVERITY,
  BILLING_TIMELINE_SOURCE,
  BILLING_AUDIT_ACTION,
} from "./billingPhase30Integration.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

function resolveRenewalGraceDays() {
  if (isBillingRenewalTestAccelerated()) {
    return BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT;
  }
  const raw = Number(process.env.BILLING_RENEWAL_GRACE_PERIOD_DAYS ?? BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : BILLING_RENEWAL_GRACE_PERIOD_DAYS_DEFAULT;
}

function resolvePreRenewalDays() {
  const raw = Number(process.env.BILLING_RENEWAL_PRE_RENEWAL_DAYS ?? BILLING_RENEWAL_PRE_RENEWAL_DAYS_DEFAULT);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : BILLING_RENEWAL_PRE_RENEWAL_DAYS_DEFAULT;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {Record<string, unknown>} metadataPatch
 */
async function patchSubscriptionRenewalMetadata(supabase, subscriptionId, metadataPatch) {
  const { data: row, error: readErr } = await supabase
    .from("billing_subscriptions")
    .select("metadata")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (readErr) throw readErr;
  const meta = asObject(row?.metadata);
  const nextMeta = { ...meta, ...metadataPatch };
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({ metadata: nextMeta, updated_at: new Date().toISOString() })
    .eq("id", subscriptionId);
  if (error) throw error;
}

/**
 * @param {number | null} daysUntilDue
 * @param {string} currentStatus
 */
function resolveCycleStatusFromTimeline(daysUntilDue, currentStatus) {
  if (currentStatus === RENEWAL_STATUS.PAID || currentStatus === RENEWAL_STATUS.CANCELED) return currentStatus;
  if (daysUntilDue == null) return currentStatus;
  if (daysUntilDue < 0) {
    return RENEWAL_STATUS.GRACE_PERIOD;
  }
  if (daysUntilDue === 0) {
    return RENEWAL_STATUS.PENDING_PAYMENT;
  }
  if (daysUntilDue >= 1 && daysUntilDue <= resolvePreRenewalDays()) {
    return RENEWAL_STATUS.PRE_RENEWAL;
  }
  return RENEWAL_STATUS.SCHEDULED;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 * @param {import("./billingPlanRepository.js").Suse7PlanRow} plan
 * @param {Date} now
 */
async function ensureRenewalCycleForSubscription(supabase, subscription, plan, now) {
  const cycleWindow = resolveSubscriptionBillingCycle(subscription, now);
  const renewalDueDate = cycleWindow.next_billing_at;
  const strategyInfo = await resolveRenewalStrategyForSubscription(supabase, subscription);
  const subscriptionId = String(subscription.id);
  const userId = String(subscription.user_id);

  const openResolution = await reconcileOpenRenewalCyclesForSubscription(supabase, subscriptionId, {
    userId,
    reason: "engine_pre_cycle_ensure",
  });

  const idempotencyInput = {
    userId,
    subscriptionId,
    currentPlanKey: String(plan.plan_key),
    currentPlanId: String(plan.id),
    cycleStart: cycleWindow.current_period_start,
    cycleEnd: cycleWindow.current_period_end,
    renewalDueDate,
    renewalStrategy: strategyInfo.strategy,
    renewalStatus: RENEWAL_STATUS.SCHEDULED,
    metadata: {
      payment_method: strategyInfo.payment_method,
      default_payment_method_id: strategyInfo.default_payment_method_id,
    },
  };

  let cycleRow =
    openResolution.canonicalCycle != null
      ? /** @type {Record<string, unknown>} */ (openResolution.canonicalCycle)
      : await findRenewalCycleByIdempotency(supabase, idempotencyInput);

  if (cycleRow && !RENEWAL_CYCLE_OPEN_STATUSES.includes(String(cycleRow.renewal_status))) {
    cycleRow = null;
  }

  if (cycleRow) {
    const syncPatch = {
      cycle_start: idempotencyInput.cycleStart,
      cycle_end: idempotencyInput.cycleEnd,
      renewal_due_date: renewalDueDate,
      current_plan_key: idempotencyInput.currentPlanKey,
      current_plan_id: idempotencyInput.currentPlanId,
      renewal_strategy: strategyInfo.strategy,
    };
    const drift =
      String(cycleRow.cycle_start) !== String(syncPatch.cycle_start) ||
      String(cycleRow.cycle_end) !== String(syncPatch.cycle_end) ||
      String(cycleRow.renewal_due_date) !== String(syncPatch.renewal_due_date);
    if (drift) {
      cycleRow = await updateRenewalCycle(supabase, String(cycleRow.id), syncPatch);
    }
  } else {
    try {
      cycleRow = await insertRenewalCycle(supabase, idempotencyInput);
      logBilling("billing", RENEWAL_ENGINE_LOG.CYCLE_CREATED, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        renewal_cycle_id: cycleRow.id,
        renewal_strategy: strategyInfo.strategy,
        plan_key: plan.plan_key,
      });
    } catch (error) {
      const dup = String(/** @type {{ code?: string }} */ (error)?.code) === "23505";
      if (dup) {
        const retry = await reconcileOpenRenewalCyclesForSubscription(supabase, subscriptionId, {
          userId,
          reason: "engine_insert_unique_violation",
        });
        cycleRow =
          retry.canonicalCycle != null
            ? /** @type {Record<string, unknown>} */ (retry.canonicalCycle)
            : await findRenewalCycleByIdempotency(supabase, idempotencyInput);
        if (!cycleRow) throw error;
      } else {
        throw error;
      }
    }
  }

  const daysUntil = daysUntilRenewalDue(renewalDueDate, now);
  const nextStatus = resolveCycleStatusFromTimeline(daysUntil, String(cycleRow.renewal_status));
  if (nextStatus !== cycleRow.renewal_status) {
    const oldStatus = String(cycleRow.renewal_status);
    cycleRow = await updateRenewalCycle(supabase, String(cycleRow.id), { renewal_status: nextStatus });
    if (isBillingRenewalTestAccelerated()) {
      logBillingTestTransition({
        status_transition: "renewal_cycle_status",
        user_id: String(subscription.user_id),
        subscription_id: String(subscription.id),
        renewal_cycle_id: String(cycleRow.id),
        old_status: oldStatus,
        new_status: nextStatus,
      });
    }
  }

  emitRenewalPreAlertHooks(daysUntil, {
    user_id: subscription.user_id,
    subscription_id: subscription.id,
    renewal_cycle_id: cycleRow.id,
    plan_key: plan.plan_key,
    days_until_due: daysUntil,
  });

  return { cycle: cycleRow, strategyInfo, cycleWindow, daysUntil };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 * @param {Record<string, unknown>} cycle
 * @param {import("./billingPlanRepository.js").Suse7PlanRow} plan
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {{ strategy: string; payment_method: string; default_payment_method_id: string | null }} strategyInfo
 * @param {Date} now
 */
async function processRenewalCycleCharges(supabase, subscription, cycle, plan, providerApi, strategyInfo, now) {
  const status = String(cycle.renewal_status);
  if (status === RENEWAL_STATUS.PAID || status === RENEWAL_STATUS.SKIPPED) {
    return { action: "none", reason: status };
  }

  if (cycle.generated_payment_id) {
    return { action: "payment_exists", payment_id: cycle.generated_payment_id };
  }

  const providerSubId =
    typeof subscription.provider_subscription_id === "string" ? subscription.provider_subscription_id.trim() : "";
  if (strategyInfo.strategy === RENEWAL_STRATEGY.AUTO_CARD && providerSubId) {
    await updateRenewalCycle(supabase, String(cycle.id), {
      renewal_status: RENEWAL_STATUS.SKIPPED,
      auto_charge_status: RENEWAL_AUTO_CHARGE_STATUS.SKIPPED,
      metadata: {
        ...asObject(cycle.metadata),
        skip_reason: "asaas_recurring_subscription_handles_billing",
      },
    });
    return { action: "skipped_asaas_recurring" };
  }

  if (isManualRenewalStrategy(strategyInfo.strategy)) {
    return { action: "awaiting_seller_click", status };
  }

  const shouldAttemptAutoCharge =
    status === RENEWAL_STATUS.PRE_RENEWAL ||
    status === RENEWAL_STATUS.PENDING_PAYMENT ||
    status === RENEWAL_STATUS.PAYMENT_FAILED;

  if (!shouldAttemptAutoCharge) {
    return { action: "waiting", status };
  }

  if (strategyInfo.strategy === RENEWAL_STRATEGY.AUTO_CARD) {
    const result = await attemptAutoCardRenewalCharge(supabase, subscription, plan, cycle, providerApi, {
      defaultPaymentMethodId: strategyInfo.default_payment_method_id,
      remoteIp: "127.0.0.1",
    });
    return { action: "auto_card", ...result };
  }

  return { action: "waiting", status, reason: "non_auto_strategy" };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 * @param {Record<string, unknown>} cycle
 * @param {Date} now
 */
async function applyGraceAndSuspension(supabase, subscription, cycle, now) {
  const daysUntil = daysUntilRenewalDue(cycle.renewal_due_date, now);
  if (daysUntil == null || daysUntil >= 0) return { changed: false };

  const graceDays = resolveRenewalGraceDays();
  const daysPastDue = Math.abs(daysUntil);
  const graceEndsAt = new Date(now.getTime() + Math.max(0, graceDays - daysPastDue) * MS_PER_DAY);

  if (daysPastDue <= graceDays) {
    const wasGrace = String(cycle.renewal_status) === RENEWAL_STATUS.GRACE_PERIOD;
    if (!wasGrace) {
      await updateRenewalCycle(supabase, String(cycle.id), {
        renewal_status: RENEWAL_STATUS.GRACE_PERIOD,
        grace_period_until: graceEndsAt.toISOString(),
      });
      await patchSubscriptionRenewalMetadata(supabase, String(subscription.id), {
        renewal_subscription_status: RENEWAL_SUBSCRIPTION_STATUS.GRACE_PERIOD,
        delinquency_status: DELINQUENCY_STATUS.GRACE,
        grace_period_ends_at: graceEndsAt.toISOString(),
      });
      if (isBillingRenewalTestAccelerated()) {
        logBillingTestTransition({
          status_transition: "grace_started",
          user_id: String(subscription.user_id),
          subscription_id: String(subscription.id),
          renewal_cycle_id: String(cycle.id),
          old_status: String(cycle.renewal_status),
          new_status: RENEWAL_STATUS.GRACE_PERIOD,
          extra: { grace_period_until: graceEndsAt.toISOString(), days_overdue: daysPastDue },
        });
      }
      emitRenewalNotificationHook(RENEWAL_NOTIFICATION_EVENT.GRACE_PERIOD_STARTED, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        renewal_cycle_id: cycle.id,
      });
      try {
        await emitBillingFinancialSignal(supabase, {
          userId: String(subscription.user_id),
          subscriptionId: String(subscription.id),
          renewalCycleId: String(cycle.id),
          eventType: BILLING_TIMELINE_EVENT.ENTERED_GRACE,
          title: "Período de tolerância iniciado",
          summary: "Renove seu plano durante o grace period para evitar suspensão.",
          severity: BILLING_TIMELINE_SEVERITY.WARNING,
          source: BILLING_TIMELINE_SOURCE.ENGINE,
          idempotencyKey: `grace_started:${cycle.id}`,
          auditAction: BILLING_AUDIT_ACTION.GRACE_STARTED,
          beforeState: { renewal_status: String(cycle.renewal_status) },
          afterState: { renewal_status: RENEWAL_STATUS.GRACE_PERIOD, grace_period_until: graceEndsAt.toISOString() },
          renewalHookType: RENEWAL_NOTIFICATION_EVENT.GRACE_PERIOD_STARTED,
          notificationVariables: {
            plan_key: subscription.plan_key,
            grace_ends_at: graceEndsAt.toISOString(),
          },
        });
      } catch (phase30Err) {
        logBillingError("billing", "phase30_grace_signal_failed", phase30Err, {
          subscription_id: subscription.id,
        });
      }
      logBilling("billing", RENEWAL_ENGINE_LOG.GRACE_STARTED, {
        user_id: subscription.user_id,
        renewal_cycle_id: cycle.id,
        grace_period_until: graceEndsAt.toISOString(),
        days_overdue: daysPastDue,
      });
    } else {
      logBilling("billing", RENEWAL_ENGINE_LOG.GRACE_ESCALATED, {
        user_id: subscription.user_id,
        renewal_cycle_id: cycle.id,
        days_overdue: daysPastDue,
        grace_period_until: graceEndsAt.toISOString(),
      });
      emitRenewalNotificationHook(RENEWAL_NOTIFICATION_EVENT.GRACE_ESCALATED, {
        user_id: subscription.user_id,
        subscription_id: subscription.id,
        renewal_cycle_id: cycle.id,
        days_overdue: daysPastDue,
      });
    }

    if (daysPastDue >= 10) {
      logBilling("billing", RENEWAL_ENGINE_LOG.CRITICAL_FINAL, {
        user_id: subscription.user_id,
        renewal_cycle_id: cycle.id,
        days_overdue: daysPastDue,
      });
    }

    return { changed: true, state: "grace" };
  }

  const oldCycleStatus = String(cycle.renewal_status);
  await updateRenewalCycle(supabase, String(cycle.id), {
    renewal_status: RENEWAL_STATUS.SUSPENDED,
  });
  await supabase
    .from("billing_subscriptions")
    .update({
      status: SUBSCRIPTION_STATUS.PAST_DUE,
      updated_at: now.toISOString(),
    })
    .eq("id", subscription.id);

  await patchSubscriptionRenewalMetadata(supabase, String(subscription.id), {
    renewal_subscription_status: RENEWAL_SUBSCRIPTION_STATUS.SUSPENDED,
    delinquency_status: DELINQUENCY_STATUS.SUSPENDED,
    access_suspended_at: now.toISOString(),
  });

  if (isBillingRenewalTestAccelerated()) {
    logBillingTestTransition({
      status_transition: "subscription_suspended",
      user_id: String(subscription.user_id),
      subscription_id: String(subscription.id),
      renewal_cycle_id: String(cycle.id),
      old_status: oldCycleStatus,
      new_status: RENEWAL_STATUS.SUSPENDED,
      extra: { days_overdue: daysPastDue },
    });
  }

  emitRenewalNotificationHook(RENEWAL_NOTIFICATION_EVENT.SUBSCRIPTION_SUSPENDED, {
    user_id: subscription.user_id,
    subscription_id: subscription.id,
    renewal_cycle_id: cycle.id,
  });

  try {
    await emitBillingFinancialSignal(supabase, {
      userId: String(subscription.user_id),
      subscriptionId: String(subscription.id),
      renewalCycleId: String(cycle.id),
      eventType: BILLING_TIMELINE_EVENT.SUSPENDED,
      title: "Assinatura suspensa",
      summary: "Regularize o pagamento para reativar o acesso ao Suse7.",
      severity: BILLING_TIMELINE_SEVERITY.CRITICAL,
      source: BILLING_TIMELINE_SOURCE.ENGINE,
      idempotencyKey: `suspended:${cycle.id}`,
      auditAction: BILLING_AUDIT_ACTION.SUSPENSION_APPLIED,
      beforeState: { renewal_status: oldCycleStatus, subscription_status: subscription.status },
      afterState: { renewal_status: RENEWAL_STATUS.SUSPENDED, subscription_status: SUBSCRIPTION_STATUS.PAST_DUE },
      renewalHookType: RENEWAL_NOTIFICATION_EVENT.SUBSCRIPTION_SUSPENDED,
    });
  } catch (phase30Err) {
    logBillingError("billing", "phase30_suspension_signal_failed", phase30Err, {
      subscription_id: subscription.id,
    });
  }

  logBilling("billing", RENEWAL_ENGINE_LOG.SUBSCRIPTION_SUSPENDED, {
    user_id: subscription.user_id,
    renewal_cycle_id: cycle.id,
  });

  return { changed: true, state: "suspended" };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {Date} now
 */
async function processSubscriptionRenewal(supabase, subscription, providerApi, now) {
  const status = String(subscription.status || "").toLowerCase();
  if (![SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.PENDING].includes(status)) {
    return { skipped_reason: "subscription_not_renewable" };
  }

  const plan = await getActivePlanById(supabase, String(subscription.plan_id));
  if (!plan?.id || plan.billing_required === false) {
    return { skipped_reason: "plan_not_billable" };
  }

  assertRenewalPlanMatchesActiveSubscription(subscription, String(plan.id));

  await cancelOrphanAsaasSubscriptionsForUser(
    supabase,
    providerApi,
    String(subscription.user_id),
    subscription,
    "renewal_engine_orphan_cleanup"
  );

  const { cycle, strategyInfo, daysUntil } = await ensureRenewalCycleForSubscription(
    supabase,
    subscription,
    plan,
    now
  );

  logBilling("billing", RENEWAL_ENGINE_LOG.CANDIDATE, {
    user_id: subscription.user_id,
    subscription_id: subscription.id,
    renewal_cycle_id: cycle.id,
    renewal_strategy: strategyInfo.strategy,
    renewal_status: cycle.renewal_status,
    days_until_due: daysUntil,
    plan_key: plan.plan_key,
  });

  const chargeResult = await processRenewalCycleCharges(
    supabase,
    subscription,
    cycle,
    plan,
    providerApi,
    strategyInfo,
    now
  );

  await applyGraceAndSuspension(supabase, subscription, cycle, now);

  return {
    user_id: subscription.user_id,
    subscription_id: subscription.id,
    renewal_cycle_id: cycle.id,
    renewal_strategy: strategyInfo.strategy,
    renewal_status: cycle.renewal_status,
    charge: chargeResult,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   providerApi: import("../providers/BillingProvider.js").BillingProvider;
 *   requestId?: string | null;
 *   jobName?: string;
 *   limit?: number;
 *   now?: Date;
 * }} options
 */
export async function processBillingRenewalEngine(supabase, options) {
  const jobName = options.jobName ?? "billing-renewal-engine";
  const requestId = options.requestId ?? null;
  const now = options.now instanceof Date ? options.now : new Date();
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 200;

  logBilling("billing", RENEWAL_ENGINE_LOG.START, {
    request_id: requestId,
    job_name: jobName,
    started_at: now.toISOString(),
  });

  const subscriptions = await listSubscriptionsApproachingRenewal(supabase, {
    lookaheadDays: resolvePreRenewalDays(),
    limit,
    now,
  });

  let cyclesCreated = 0;
  let paymentsCreated = 0;
  let autoCharges = 0;
  let graceStarted = 0;
  let suspended = 0;
  let skipped = 0;
  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  /** @type {Array<{ subscription_id: string; message: string }>} */
  const failures = [];

  for (const subscription of subscriptions) {
    try {
      const result = await processSubscriptionRenewal(
        supabase,
        /** @type {Record<string, unknown>} */ (subscription),
        options.providerApi,
        now
      );
      results.push(result);
      if (result.charge?.action === "auto_card") {
        paymentsCreated += 1;
      }
      if (result.charge?.action === "auto_card") autoCharges += 1;
      if (result.skipped_reason) skipped += 1;
    } catch (error) {
      failures.push({
        subscription_id: String(subscription.id),
        message: error instanceof Error ? error.message : String(error),
      });
      logBillingError("billing", "renewal_engine_subscription_failed", error, {
        subscription_id: subscription.id,
      });
    }
  }

  logBilling("billing", RENEWAL_ENGINE_LOG.END, {
    request_id: requestId,
    job_name: jobName,
    scanned_subscriptions: subscriptions.length,
    payments_created: paymentsCreated,
    auto_charges: autoCharges,
    grace_started: graceStarted,
    suspended,
    skipped,
    failed_count: failures.length,
  });

  return {
    scanned_subscriptions: subscriptions.length,
    payments_created: paymentsCreated,
    auto_charges: autoCharges,
    grace_started: graceStarted,
    suspended,
    skipped,
    failed_count: failures.length,
    results,
    failures,
  };
}

export { isAsaasPaymentConfirmedStatus };
