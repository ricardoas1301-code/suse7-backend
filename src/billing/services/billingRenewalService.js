// ======================================================================
// Motor de renovação — somente assinatura ativa (nunca catálogo de planos)
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";
import { SUBSCRIPTION_STATUS } from "../billingConstants.js";
import { resolveSubscriptionBillingCycle } from "./billingCycleService.js";
import { getActivePlanById } from "./billingPlanRepository.js";
import { cancelOrphanAsaasSubscriptionsForUser } from "./billingOrphanAsaasSubscriptionService.js";
import {
  buildRenewalChargeIdempotencyKey,
  findExistingRenewalCyclePayment,
} from "./billingRenewalIdempotencyService.js";
import {
  listUserBillingSubscriptions,
  pickActiveSubscription,
  pickPaidManagedSubscription,
} from "./billingSubscriptionQueryService.js";
import { normalizeCheckoutPaymentMethod } from "./billingSubscriptionService.js";

const RENEWAL_ELIGIBLE_STATUSES = new Set([SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE]);

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {Record<string, unknown>} metadata
 */
function readSubscriptionPaymentMethod(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  return normalizeCheckoutPaymentMethod(meta.payment_method);
}

/**
 * @param {Record<string, unknown> | null | undefined} activeSubscription
 * @param {string} attemptedPlanId
 */
export function logRenewalPlanMismatchBlocked(activeSubscription, attemptedPlanId) {
  logBilling("billing", "S7_BILLING_RENEWAL_BLOCKED_PLAN_MISMATCH", {
    user_id: activeSubscription?.user_id ?? null,
    subscription_id: activeSubscription?.id ?? null,
    active_plan_id: activeSubscription?.plan_id ?? null,
    active_plan_key: activeSubscription?.plan_key ?? null,
    attempted_plan_id: attemptedPlanId,
    reason: "attempted_charge_for_non_active_plan",
  });
}

/**
 * @param {Record<string, unknown> | null | undefined} activeSubscription
 * @param {string} attemptedPlanId
 */
export function assertRenewalPlanMatchesActiveSubscription(activeSubscription, attemptedPlanId) {
  if (!activeSubscription?.plan_id) {
    const err = new Error("ACTIVE_SUBSCRIPTION_PLAN_MISSING");
    /** @type {any} */ (err).code = "ACTIVE_SUBSCRIPTION_PLAN_MISSING";
    throw err;
  }
  if (String(activeSubscription.plan_id) !== String(attemptedPlanId)) {
    logRenewalPlanMismatchBlocked(activeSubscription, attemptedPlanId);
    const err = new Error("RENEWAL_PLAN_MISMATCH");
    /** @type {any} */ (err).code = "RENEWAL_PLAN_MISMATCH";
    throw err;
  }
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {number} [limit]
 */
async function listRenewalCandidateUserIds(supabase, limit = 200) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("user_id")
    .eq("provider", "asaas")
    .in("status", [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.PENDING])
    .order("updated_at", { ascending: false })
    .limit(Math.max(limit * 3, limit));
  if (error) throw error;

  const ids = [];
  const seen = new Set();
  for (const row of data ?? []) {
    const userId = row.user_id != null ? String(row.user_id) : "";
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    ids.push(userId);
    if (ids.length >= limit) break;
  }
  return ids;
}

/**
 * Assinatura fonte de verdade para cobrança automática.
 *
 * @param {Record<string, unknown>[]} list
 */
function resolveRenewalSourceSubscription(list) {
  return pickPaidManagedSubscription(list) ?? pickActiveSubscription(list);
}

/**
 * Sincroniza cobranças do Asaas para a assinatura ativa (somente leitura no gateway + upsert local via webhook path).
 * Não cria assinatura nova. Assinaturas MONTHLY no Asaas já geram parcelas automaticamente.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {Record<string, unknown>} activeSubscription
 * @param {import("./billingPlanRepository.js").Suse7PlanRow} plan
 * @param {{ billing_cycle_start: string; current_period_end: string | null }} cycle
 */
async function evaluateRenewalChargeForActiveSubscription(supabase, providerApi, activeSubscription, plan, cycle) {
  const userId = String(activeSubscription.user_id);
  const subscriptionId = String(activeSubscription.id);
  const planId = String(plan.id);
  const paymentMethod = readSubscriptionPaymentMethod(
    activeSubscription.metadata && typeof activeSubscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (activeSubscription.metadata)
      : {}
  );

  assertRenewalPlanMatchesActiveSubscription(activeSubscription, planId);

  const existing = await findExistingRenewalCyclePayment(supabase, {
    userId,
    subscriptionId,
    planId,
    billingCycleStart: cycle.billing_cycle_start,
    paymentMethod,
  });

  if (existing?.payment) {
    return {
      should_create_charge: false,
      skipped_reason: "existing_cycle_payment",
      idempotency_key: existing.idempotency_key,
      payment_id: existing.payment.id,
    };
  }

  const providerSubId = asTrimmedString(activeSubscription.provider_subscription_id);
  if (!providerSubId || typeof providerApi.listSubscriptionPayments !== "function") {
    return {
      should_create_charge: false,
      skipped_reason: "asaas_subscription_handles_billing",
      idempotency_key: buildRenewalChargeIdempotencyKey(
        userId,
        subscriptionId,
        planId,
        cycle.billing_cycle_start,
        paymentMethod
      ),
    };
  }

  /** Não chama createPayment: evita duplicar cobrança que o Asaas já agenda na assinatura. */
  return {
    should_create_charge: false,
    skipped_reason: "asaas_recurring_subscription",
    idempotency_key: buildRenewalChargeIdempotencyKey(
      userId,
      subscriptionId,
      planId,
      cycle.billing_cycle_start,
      paymentMethod
    ),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {string} userId
 * @param {Date} now
 */
async function processRenewalForUser(supabase, providerApi, userId, now) {
  const list = await listUserBillingSubscriptions(supabase, userId, 50);
  const activeSubscription = resolveRenewalSourceSubscription(list);

  if (!activeSubscription?.id) {
    const orphanOnly = await cancelOrphanAsaasSubscriptionsForUser(
      supabase,
      providerApi,
      userId,
      null,
      "renewal_job_no_active_subscription"
    );
    return {
      user_id: userId,
      should_create_charge: false,
      skipped_reason: "no_active_subscription",
      orphans_canceled: orphanOnly.canceled,
    };
  }

  const status = String(activeSubscription.status || "").toLowerCase();
  const provider = String(activeSubscription.provider || "").toLowerCase();
  if (provider !== "asaas" || !RENEWAL_ELIGIBLE_STATUSES.has(status)) {
    const orphanOnly = await cancelOrphanAsaasSubscriptionsForUser(
      supabase,
      providerApi,
      userId,
      activeSubscription,
      "renewal_job_ineligible_active_subscription"
    );
    return {
      user_id: userId,
      subscription_id: String(activeSubscription.id),
      active_plan_id: activeSubscription.plan_id ?? null,
      active_plan_key: activeSubscription.plan_key ?? null,
      should_create_charge: false,
      skipped_reason: "active_subscription_not_renewable",
      orphans_canceled: orphanOnly.canceled,
    };
  }

  const plan = await getActivePlanById(supabase, String(activeSubscription.plan_id));
  if (!plan?.id || plan.billing_required === false) {
    return {
      user_id: userId,
      subscription_id: String(activeSubscription.id),
      should_create_charge: false,
      skipped_reason: "plan_not_billable",
    };
  }

  const cycle = resolveSubscriptionBillingCycle(activeSubscription, now);
  const billingCycleStart =
    cycle.current_period_start != null ? String(cycle.current_period_start).slice(0, 10) : now.toISOString().slice(0, 10);

  const orphanCleanup = await cancelOrphanAsaasSubscriptionsForUser(
    supabase,
    providerApi,
    userId,
    activeSubscription,
    "renewal_job_orphan_cleanup"
  );

  const chargeEval = await evaluateRenewalChargeForActiveSubscription(
    supabase,
    providerApi,
    activeSubscription,
    plan,
    {
      billing_cycle_start: billingCycleStart,
      current_period_end: cycle.current_period_end != null ? String(cycle.current_period_end) : null,
    }
  );

  logBilling("billing", "S7_BILLING_RENEWAL_CANDIDATE", {
    user_id: userId,
    subscription_id: String(activeSubscription.id),
    active_plan_key: plan.plan_key,
    active_plan_id: plan.id,
    current_period_start: cycle.current_period_start ?? null,
    current_period_end: cycle.current_period_end ?? null,
    should_create_charge: chargeEval.should_create_charge,
    skipped_reason: chargeEval.skipped_reason ?? null,
    orphans_canceled: orphanCleanup.canceled,
    idempotency_key: chargeEval.idempotency_key ?? null,
  });

  return {
    user_id: userId,
    subscription_id: String(activeSubscription.id),
    active_plan_id: plan.id,
    active_plan_key: plan.plan_key,
    current_period_start: cycle.current_period_start ?? null,
    current_period_end: cycle.current_period_end ?? null,
    should_create_charge: chargeEval.should_create_charge,
    skipped_reason: chargeEval.skipped_reason ?? null,
    orphans_canceled: orphanCleanup.canceled,
    blocked: false,
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
/**
 * Job legado — delega ao motor oficial Fase 2 (`billingRenewalEngine`).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   providerApi: import("../providers/BillingProvider.js").BillingProvider;
 *   requestId?: string | null;
 *   jobName?: string;
 *   limit?: number;
 *   now?: Date;
 * }} options
 */
export async function processBillingRenewals(supabase, options) {
  const { processBillingRenewalEngine } = await import("./billingRenewalEngine.js");
  return processBillingRenewalEngine(supabase, {
    ...options,
    jobName: options.jobName ?? "billing-process-renewals",
  });
}
