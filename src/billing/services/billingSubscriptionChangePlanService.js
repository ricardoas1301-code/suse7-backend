// ======================================================================
// Troca de plano — upgrade via checkout e downgrade agendado
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { recordBillingEvent } from "../billingEventService.js";
import {
  emitBillingFinancialSignal,
  BILLING_TIMELINE_EVENT,
  BILLING_TIMELINE_SOURCE,
  BILLING_AUDIT_ACTION,
} from "./billingPhase30Integration.js";
import { enqueueBillingNotification } from "./billingNotificationCenterService.js";
import { getActivePlanById, getActivePlanByKey, getActivePlanBySlug, listActivePlans } from "./billingPlanRepository.js";
import { resolveSubscriptionBillingCycle } from "./billingCycleService.js";
import { resolveBillingAccess } from "./resolveBillingAccess.js";
import { startBillingCheckout } from "./billingCheckoutStartService.js";
import { enrichSubscriptionCancellationFields } from "./billingSubscriptionCancelService.js";
import {
  findPendingCheckoutForPlan,
  loadBillingSubscriptionSnapshot,
  summarizeSubscriptionRow,
} from "./billingSubscriptionQueryService.js";

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {import("./billingPlanRepository.js").Suse7PlanRow | null | undefined} plan
 */
function isEnterprisePlanRow(plan) {
  if (!plan) return false;
  const key = String(plan.plan_key || plan.slug || "").trim().toLowerCase();
  return key === "enterprise";
}

/**
 * @param {import("./billingPlanRepository.js").Suse7PlanRow | null | undefined} plan
 */
function resolvePlanSlug(plan) {
  if (!plan) return null;
  return asTrimmedString(plan.slug) ?? asTrimmedString(plan.plan_key);
}

/**
 * @param {import("./billingPlanRepository.js").Suse7PlanRow | null | undefined} plan
 */
function resolvePlanSortOrder(plan) {
  const sortOrder = Number(plan?.sort_order);
  return Number.isFinite(sortOrder) ? sortOrder : null;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} targetPlanSlug
 */
async function resolveTargetPlan(supabase, targetPlanSlug) {
  const slug = String(targetPlanSlug || "").trim();
  if (!slug) return null;
  const bySlug = await getActivePlanBySlug(supabase, slug);
  if (bySlug) return bySlug;
  return getActivePlanByKey(supabase, slug);
}

/**
 * @param {Record<string, unknown>} metadata
 */
export function readSubscriptionPlanChange(metadata) {
  const meta = asObject(metadata) ?? {};
  return {
    plan_change_at_period_end: meta.plan_change_at_period_end === true,
    plan_change_requested_at: asTrimmedString(meta.plan_change_requested_at),
    plan_change_target_plan_slug:
      asTrimmedString(meta.plan_change_target_plan_slug) ?? asTrimmedString(meta.plan_change_target_plan_key),
    plan_change_target_plan_id: asTrimmedString(meta.plan_change_target_plan_id),
  };
}

/**
 * @param {Record<string, unknown>} subscription
 */
export function enrichSubscriptionPlanChangeFields(subscription) {
  const planChange = readSubscriptionPlanChange(subscription.metadata);
  return {
    ...subscription,
    ...planChange,
    plan_change_access_ends_at: subscription.current_period_end ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} subscriptionId
 * @param {Record<string, unknown>} rawPayload
 */
async function recordPlanChangeEvent(supabase, userId, subscriptionId, rawPayload) {
  try {
    await recordBillingEvent(supabase, {
      provider: "suse7",
      providerEventId: `plan_change:${userId}:${subscriptionId}:${Date.now()}`,
      eventType: "PLAN_CHANGE_REQUESTED",
      rawPayload,
    });
    const changeKind = String(rawPayload.change_kind ?? "plan_change");
    await emitBillingFinancialSignal(supabase, {
      userId,
      subscriptionId,
      eventType: BILLING_TIMELINE_EVENT.PLAN_CHANGED,
      title: "Mudança de plano solicitada",
      summary: `Alteração registrada (${changeKind}).`,
      source: BILLING_TIMELINE_SOURCE.SELLER,
      payload: rawPayload,
      idempotencyKey: `plan_change:${subscriptionId}:${rawPayload.target_plan_slug ?? "unknown"}:${changeKind}`,
      auditAction: BILLING_AUDIT_ACTION.PLAN_CHANGE_REQUESTED,
      notificationVariables: {
        target_plan_name: rawPayload.target_plan_slug ?? "",
        change_mode: changeKind,
      },
    });
    await enqueueBillingNotification(supabase, {
      userId,
      templateKey: "plan.changed",
      subscriptionId,
      variables: {
        target_plan_name: rawPayload.target_plan_slug ?? "",
        change_mode: changeKind,
      },
    });
  } catch (error) {
    logBillingError("billing", "plan_change_event_failed", error, { user_id: userId, subscription_id: subscriptionId });
  }
}

/**
 * @param {{
 *   supabase: import("@supabase/supabase-js").SupabaseClient;
 *   user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> };
 *   targetPlanSlug: string;
 *   paymentMethod?: string | null;
 *   providerKey?: string;
 *   explicitUserAction?: boolean;
 *   auditRoute?: string | null;
 *   auditRequestId?: string | null;
 * }} ctx
 */
export async function requestSubscriptionPlanChange(ctx) {
  const targetPlanSlug = String(ctx.targetPlanSlug || "").trim();
  if (!targetPlanSlug) {
    const err = new Error("TARGET_PLAN_SLUG_REQUIRED");
    /** @type {any} */ (err).code = "TARGET_PLAN_SLUG_REQUIRED";
    throw err;
  }

  const targetPlan = await resolveTargetPlan(ctx.supabase, targetPlanSlug);
  if (!targetPlan) {
    const err = new Error("PLAN_NOT_FOUND");
    /** @type {any} */ (err).code = "PLAN_NOT_FOUND";
    throw err;
  }
  if (isEnterprisePlanRow(targetPlan)) {
    const err = new Error("ENTERPRISE_PLAN_REQUIRES_SALES");
    /** @type {any} */ (err).code = "ENTERPRISE_PLAN_REQUIRES_SALES";
    throw err;
  }

  const snapshot = await loadBillingSubscriptionSnapshot(ctx.supabase, ctx.user.id);
  const { activeSubscription, pendingCheckout, paidManagedSubscription, list: subscriptionList } = snapshot;

  logBilling("billing", "[S7_BILLING_CHANGE_PLAN]", {
    user_id: ctx.user.id,
    target_plan_slug: targetPlanSlug,
    subscriptions_count: subscriptionList.length,
    active_subscription: activeSubscription ? summarizeSubscriptionRow(activeSubscription) : null,
    pending_checkout: pendingCheckout ? summarizeSubscriptionRow(pendingCheckout) : null,
    paid_managed_subscription: paidManagedSubscription ? summarizeSubscriptionRow(paidManagedSubscription) : null,
  });

  const catalogPlans = await listActivePlans(ctx.supabase);
  const currentSubscriptionForPlan = activeSubscription ?? paidManagedSubscription ?? null;
  const currentPlan =
    catalogPlans.find((plan) => currentSubscriptionForPlan?.plan_id && String(plan.id) === String(currentSubscriptionForPlan.plan_id)) ??
    catalogPlans.find(
      (plan) =>
        currentSubscriptionForPlan?.plan_key &&
        String(plan.plan_key).toLowerCase() === String(currentSubscriptionForPlan.plan_key).toLowerCase()
    ) ??
    null;

  const currentSlug = resolvePlanSlug(currentPlan) ?? asTrimmedString(currentSubscriptionForPlan?.plan_key);
  const targetSlug = resolvePlanSlug(targetPlan);
  if (currentSlug && targetSlug && currentSlug.toLowerCase() === targetSlug.toLowerCase()) {
    const err = new Error("TARGET_PLAN_IS_CURRENT");
    /** @type {any} */ (err).code = "TARGET_PLAN_IS_CURRENT";
    throw err;
  }

  const existingPendingForTarget = findPendingCheckoutForPlan(subscriptionList, targetSlug ?? targetPlanSlug);
  if (existingPendingForTarget) {
    const err = new Error("PENDING_CHECKOUT_EXISTS");
    /** @type {any} */ (err).code = "PENDING_CHECKOUT_EXISTS";
    /** @type {any} */ (err).pending_subscription_id = existingPendingForTarget.id;
    throw err;
  }

  const currentSort = resolvePlanSortOrder(currentPlan);
  const targetSort = resolvePlanSortOrder(targetPlan);
  const isUpgrade = currentSort != null && targetSort != null ? targetSort > currentSort : targetPlan.billing_required === true;

  const paidManagedForDowngrade = paidManagedSubscription;

  if (isUpgrade) {
    const checkout = await startBillingCheckout({
      supabase: ctx.supabase,
      user: ctx.user,
      planSlug: targetSlug,
      paymentMethod: ctx.paymentMethod ?? null,
      providerKey: ctx.providerKey,
      supersedeMode: "defer",
      explicitUserAction: ctx.explicitUserAction === true,
      auditRoute: ctx.auditRoute ?? null,
      auditRequestId: ctx.auditRequestId ?? null,
    });
    await recordPlanChangeEvent(ctx.supabase, ctx.user.id, currentSubscriptionForPlan?.id ?? "upgrade", {
      user_id: ctx.user.id,
      current_subscription_id: currentSubscriptionForPlan?.id ?? null,
      target_plan_slug: targetSlug,
      target_plan_id: targetPlan.id,
      change_kind: "upgrade_checkout",
    });
    logBilling("billing", "plan_change_upgrade_checkout", {
      user_id: ctx.user.id,
      target_plan_slug: targetSlug,
    });
    return {
      kind: "upgrade_checkout",
      change_kind: "upgrade",
      target_plan_slug: targetSlug,
      ...checkout,
    };
  }

  if (!paidManagedForDowngrade?.id) {
    const checkout = await startBillingCheckout({
      supabase: ctx.supabase,
      user: ctx.user,
      planSlug: targetSlug,
      paymentMethod: ctx.paymentMethod ?? null,
      providerKey: ctx.providerKey,
      explicitUserAction: ctx.explicitUserAction === true,
      auditRoute: ctx.auditRoute ?? null,
      auditRequestId: ctx.auditRequestId ?? null,
    });
    return {
      kind: "checkout",
      change_kind: "activate",
      target_plan_slug: targetSlug,
      ...checkout,
    };
  }

  const now = new Date();
  const cycle = resolveSubscriptionBillingCycle(paidManagedForDowngrade, now);
  const metadata = {
    ...(asObject(paidManagedForDowngrade.metadata) ?? {}),
    plan_change_at_period_end: true,
    plan_change_requested_at: now.toISOString(),
    plan_change_target_plan_slug: targetSlug,
    plan_change_target_plan_id: targetPlan.id,
    plan_change_target_plan_key: targetPlan.plan_key,
  };

  const { data, error } = await ctx.supabase
    .from("billing_subscriptions")
    .update({
      metadata,
      current_period_start: paidManagedForDowngrade.current_period_start ?? cycle.current_period_start,
      current_period_end: paidManagedForDowngrade.current_period_end ?? cycle.current_period_end,
      updated_at: now.toISOString(),
    })
    .eq("id", paidManagedForDowngrade.id)
    .eq("user_id", ctx.user.id)
    .select(
      "id, plan_id, plan_key, provider, status, amount, currency, current_period_start, current_period_end, next_due_date, canceled_at, metadata, created_at, updated_at"
    )
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error("SUBSCRIPTION_NOT_FOUND");
    /** @type {any} */ (err).code = "SUBSCRIPTION_NOT_FOUND";
    throw err;
  }

  await recordPlanChangeEvent(ctx.supabase, ctx.user.id, String(paidManagedForDowngrade.id), {
    user_id: ctx.user.id,
    subscription_id: paidManagedForDowngrade.id,
    target_plan_slug: targetSlug,
    target_plan_id: targetPlan.id,
    change_kind: "scheduled_downgrade",
    effective_at: data.current_period_end ?? null,
  });

  const billing = await resolveBillingAccess(ctx.supabase, ctx.user.id, { ensureBaby: false });
  logBilling("billing", "plan_change_scheduled_downgrade", {
    user_id: ctx.user.id,
    subscription_id: paidManagedForDowngrade.id,
    target_plan_slug: targetSlug,
  });

  return {
    kind: "scheduled_downgrade",
    change_kind: "downgrade",
    target_plan_slug: targetSlug,
    subscription: enrichSubscriptionPlanChangeFields(enrichSubscriptionCancellationFields(data)),
    access: billing.access,
    can_access: billing.can_access,
    current_period_start: billing.current_period_start ?? data.current_period_start ?? null,
    current_period_end: billing.current_period_end ?? data.current_period_end ?? null,
    next_billing_at: billing.next_billing_at ?? null,
    plan_change_at_period_end: true,
    plan_change_access_ends_at: data.current_period_end ?? null,
  };
}
