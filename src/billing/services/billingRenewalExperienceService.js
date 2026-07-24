// ======================================================================
// Experiência de renovação manual — estado e ações canônicos (Bloco B)
// ======================================================================

import {
  BILLING_FINANCIAL_STATE,
  PAYMENT_HISTORY_ACTION_TYPE,
  RENEWAL_EXPERIENCE_ACTION,
  RENEWAL_EXPERIENCE_STATE,
  RENEWAL_STATUS,
  RENEWAL_STRATEGY,
} from "../billingConstants.js";
import { logBilling } from "../billingLog.js";
import { isBillingPaymentPayable, normalizeBillingPaymentStatusKey } from "../utils/billingPaymentPayability.js";
import { decimalToScale2String, toDecimal } from "../utils/moneyDecimal.js";
import { loadCanonicalBillableSubscriptionContext } from "./billingCanonicalSubscriptionService.js";
import { formatBillingCivilDateInSaoPaulo, parseBillingCivilDate } from "./billingCycleService.js";
import { resolveRenewalChargeDueDatePolicy } from "./billingPaymentDueDatePolicy.js";
import { resolveOfficialPaymentMethod } from "./billingSubscriptionRenewalCompletionService.js";
import { resolveEffectiveRenewalPrice, logEffectiveRenewalPriceResolved } from "./billingEffectiveRenewalPriceService.js";
import { getActivePlanById } from "./billingPlanRepository.js";
import { findOpenRenewalCycleForSubscription } from "./billingRenewalCycleRepository.js";
import { isManualRenewalStrategy } from "./billingPendingRenewalPresentationService.js";
import { resolveRenewalStrategyForSubscription } from "./billingRenewalStrategyService.js";
import {
  applyFinancialStateToRenewalExperience,
  resolveBillingSubscriptionFinancialState,
} from "./billingSubscriptionFinancialStateService.js";
import {
  normalizeBillingSubscriptionEntitlementDto,
  resolveBillingSubscriptionEntitlement,
} from "./billingSubscriptionEntitlementService.js";

const PAYABLE_CYCLE_STATUSES = new Set([
  RENEWAL_STATUS.SCHEDULED,
  RENEWAL_STATUS.PRE_RENEWAL,
  RENEWAL_STATUS.PENDING_PAYMENT,
  RENEWAL_STATUS.PAYMENT_FAILED,
  RENEWAL_STATUS.GRACE_PERIOD,
]);

const OPEN_PAYMENT_STATUSES = new Set(["PENDING", "OVERDUE"]);

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} providerPaymentId
 */
function maskProviderPaymentId(providerPaymentId) {
  const raw = asTrimmedString(providerPaymentId);
  if (!raw) return null;
  if (raw.length <= 8) return "***";
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

/**
 * @param {Record<string, unknown>} subscription
 * @param {Date} now
 */
function isSubscriptionPeriodOverdue(subscription, now) {
  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const periodEnd = parseBillingCivilDate(subscription.current_period_end);
  const nextDue = parseBillingCivilDate(subscription.next_due_date ?? subscription.next_billing_at);
  if (periodEnd && civilNow && civilNow > periodEnd) return true;
  if (nextDue && civilNow && civilNow >= nextDue) return true;
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} paymentRow
 * @param {Date} now
 */
function isPaymentExpiredForExperience(paymentRow, now) {
  if (!paymentRow) return false;
  const status = normalizeBillingPaymentStatusKey(paymentRow.status);
  if (status === "paid" || status === "canceled" || status === "failed") return false;
  if (isBillingPaymentPayable(status)) return false;

  const payload =
    paymentRow.raw_payload && typeof paymentRow.raw_payload === "object"
      ? /** @type {Record<string, unknown>} */ (paymentRow.raw_payload)
      : {};
  const duePolicy = resolveRenewalChargeDueDatePolicy({
    cycleDueDate: payload.dueDate ?? payload.originalDueDate,
    paymentMethod: resolveOfficialPaymentMethod(payload),
    now,
  });
  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  if (duePolicy.due_date && civilNow && civilNow > duePolicy.due_date && status !== "pending") {
    return true;
  }

  return !isBillingPaymentPayable(status) && status !== "pending";
}

/**
 * @param {Record<string, unknown>} subscription
 * @param {import("./billingPlanRepository.js").Suse7PlanRow | null} plan
 * @param {Awaited<ReturnType<typeof resolveEffectiveRenewalPrice>>} priceResolution
 */
function resolveCanonicalRenewalAmount(subscription, plan, priceResolution) {
  if (priceResolution?.amount) return priceResolution.amount;
  try {
    const raw = plan?.price_monthly ?? subscription.amount ?? null;
    if (raw == null) return null;
    return decimalToScale2String(toDecimal(raw));
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} cycle
 */
function buildPeriodDto(cycle) {
  return {
    start: String(cycle.cycle_start).slice(0, 10),
    end: String(cycle.cycle_end).slice(0, 10),
  };
}

/**
 * @param {Record<string, unknown> | null} paymentRow
 * @param {string | null} paymentMethod
 * @param {Date} now
 */
function buildPaymentDto(paymentRow, paymentMethod, now) {
  if (!paymentRow?.id) return null;

  const payload =
    paymentRow.raw_payload && typeof paymentRow.raw_payload === "object"
      ? /** @type {Record<string, unknown>} */ (paymentRow.raw_payload)
      : {};
  const duePolicy = resolveRenewalChargeDueDatePolicy({
    cycleDueDate: asTrimmedString(payload.dueDate) ?? asTrimmedString(payload.originalDueDate),
    paymentMethod,
    now,
  });

  return {
    id: String(paymentRow.id),
    method: paymentMethod,
    status: normalizeBillingPaymentStatusKey(paymentRow.status).toUpperCase(),
    due_date: duePolicy.due_date,
    expires_at: duePolicy.expires_at,
    provider_payment_id: maskProviderPaymentId(paymentRow.provider_payment_id),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {unknown} paymentRowOrId
 */
async function loadPaymentRowById(supabase, paymentRowOrId) {
  if (paymentRowOrId && typeof paymentRowOrId === "object" && /** @type {{ id?: unknown }} */ (paymentRowOrId).id) {
    return /** @type {Record<string, unknown>} */ (paymentRowOrId);
  }
  const paymentId = asTrimmedString(paymentRowOrId);
  if (!paymentId) return null;

  const { data, error } = await supabase
    .from("billing_payments")
    .select("id, user_id, subscription_id, provider_payment_id, status, amount, currency, paid_at, created_at, raw_payload")
    .eq("id", paymentId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * @param {string | null} dueDateCivil YYYY-MM-DD
 * @param {string | null} civilNow YYYY-MM-DD
 */
export function resolveRenewalDueState(dueDateCivil, civilNow) {
  if (!dueDateCivil || !civilNow) return null;
  if (dueDateCivil > civilNow) return "UPCOMING";
  if (dueDateCivil === civilNow) return "DUE_TODAY";
  return "OVERDUE";
}

/**
 * Normaliza o DTO canônico exposto ao frontend (contrato runtime 6.4).
 *
 * @param {Record<string, unknown> | null | undefined} raw
 */
export function normalizeBillingRenewalExperienceDto(raw) {
  if (!raw || typeof raw !== "object") return null;
  const primaryActionRaw = raw.primary_action ?? raw.primaryAction;
  const primaryAction =
    typeof primaryActionRaw === "string"
      ? { action: primaryActionRaw, label: null }
      : primaryActionRaw && typeof primaryActionRaw === "object"
        ? {
            action: primaryActionRaw.action != null ? String(primaryActionRaw.action) : null,
            label: primaryActionRaw.label != null ? String(primaryActionRaw.label) : null,
          }
        : null;

  const planRaw = raw.plan && typeof raw.plan === "object" ? raw.plan : null;
  const periodRaw = raw.period && typeof raw.period === "object" ? raw.period : null;

  return {
    renewal_state: raw.renewal_state != null ? String(raw.renewal_state) : null,
    subscription_id: raw.subscription_id != null ? String(raw.subscription_id) : null,
    renewal_cycle_id: raw.renewal_cycle_id != null ? String(raw.renewal_cycle_id) : null,
    plan: planRaw
      ? {
          id: planRaw.id != null ? String(planRaw.id) : null,
          key: planRaw.key != null ? String(planRaw.key) : planRaw.plan_key != null ? String(planRaw.plan_key) : null,
          name: planRaw.name != null ? String(planRaw.name) : null,
          plan_key: planRaw.plan_key != null ? String(planRaw.plan_key) : null,
        }
      : null,
    amount: raw.amount != null ? String(raw.amount) : null,
    amount_source: raw.amount_source != null ? String(raw.amount_source).toUpperCase() : null,
    currency: raw.currency != null ? String(raw.currency) : "BRL",
    due_state: raw.due_state != null ? String(raw.due_state) : null,
    due_date: raw.due_date != null ? String(raw.due_date).slice(0, 10) : null,
    period: periodRaw
      ? {
          start: periodRaw.start != null ? String(periodRaw.start).slice(0, 10) : null,
          end: periodRaw.end != null ? String(periodRaw.end).slice(0, 10) : null,
        }
      : null,
    primary_action: primaryAction,
    available_actions: Array.isArray(raw.available_actions)
      ? raw.available_actions.map((item) => String(item))
      : [],
    available_payment_methods: Array.isArray(raw.available_payment_methods)
      ? raw.available_payment_methods.map((item) => String(item))
      : [],
    payment: raw.payment ?? null,
    renewal_status: raw.renewal_status != null ? String(raw.renewal_status) : null,
    renewal_strategy: raw.renewal_strategy != null ? String(raw.renewal_strategy) : null,
    subscription_lifecycle_status:
      raw.subscription_lifecycle_status != null ? String(raw.subscription_lifecycle_status) : null,
    billing_financial_state: raw.billing_financial_state != null ? String(raw.billing_financial_state) : null,
    access_state: raw.access_state != null ? String(raw.access_state) : null,
    payment_context: raw.payment_context != null ? String(raw.payment_context) : null,
    days_past_due: raw.days_past_due != null ? Number(raw.days_past_due) : null,
    grace_period_start: raw.grace_period_start != null ? String(raw.grace_period_start).slice(0, 10) : null,
    grace_period_end: raw.grace_period_end != null ? String(raw.grace_period_end).slice(0, 10) : null,
    suspension_start: raw.suspension_start != null ? String(raw.suspension_start).slice(0, 10) : null,
    data_retention_days: raw.data_retention_days != null ? Number(raw.data_retention_days) : null,
    contracted_plan_key: raw.contracted_plan_key != null ? String(raw.contracted_plan_key) : null,
    contracted_subscription_state:
      raw.contracted_subscription_state != null ? String(raw.contracted_subscription_state) : null,
    effective_entitlement: raw.effective_entitlement != null ? String(raw.effective_entitlement) : null,
    effective_entitlement_source:
      raw.effective_entitlement_source != null ? String(raw.effective_entitlement_source) : null,
    effective_plan_key: raw.effective_plan_key != null ? String(raw.effective_plan_key) : null,
    effective_plan_label: raw.effective_plan_label != null ? String(raw.effective_plan_label) : null,
    usage_state: raw.usage_state != null ? String(raw.usage_state) : null,
    usage_count: raw.usage_count != null ? Number(raw.usage_count) : null,
    usage_limit: raw.usage_limit != null ? Number(raw.usage_limit) : null,
    limit_reached_at: raw.limit_reached_at != null ? String(raw.limit_reached_at).slice(0, 10) : null,
    usage_grace_end: raw.usage_grace_end != null ? String(raw.usage_grace_end).slice(0, 10) : null,
    fallback_period_start:
      raw.fallback_period_start != null ? String(raw.fallback_period_start).slice(0, 10) : null,
    fallback_period_end: raw.fallback_period_end != null ? String(raw.fallback_period_end).slice(0, 10) : null,
    fallback_next_reset: raw.fallback_next_reset != null ? String(raw.fallback_next_reset).slice(0, 10) : null,
    suspension_fallback_active: Boolean(raw.suspension_fallback_active),
    previous_contracted_plan_key:
      raw.previous_contracted_plan_key != null ? String(raw.previous_contracted_plan_key) : null,
    operational_blocked: raw.operational_blocked != null ? Boolean(raw.operational_blocked) : null,
    access_restrictions: raw.access_restrictions ?? null,
    sync_state: raw.sync_state != null ? String(raw.sync_state) : null,
    capabilities: raw.capabilities ?? null,
    trial_state: raw.trial_state != null ? String(raw.trial_state) : null,
    trial_start_date: raw.trial_start_date != null ? String(raw.trial_start_date).slice(0, 10) : null,
    trial_end_date: raw.trial_end_date != null ? String(raw.trial_end_date).slice(0, 10) : null,
    last_data_updated_at:
      raw.last_data_updated_at != null ? String(raw.last_data_updated_at).slice(0, 10) : null,
    data_gap: raw.data_gap ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ now?: Date; subscription?: Record<string, unknown> | null }} [options]
 */
export async function resolveBillingRenewalExperience(supabase, userId, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();

  const { canonicalSubscription, canonicalSubscriptionId } = await loadCanonicalBillableSubscriptionContext(
    supabase,
    userId
  );

  if (!canonicalSubscription?.id || !canonicalSubscriptionId) {
    const empty = normalizeBillingRenewalExperienceDto({
      renewal_state: RENEWAL_EXPERIENCE_STATE.ACTIVE_NOT_DUE,
      subscription_id: null,
      renewal_cycle_id: null,
      plan: null,
      amount: null,
      currency: "BRL",
      period: null,
      due_date: null,
      due_state: null,
      available_actions: [],
      payment: null,
      primary_action: null,
    });
    logBilling("billing", "BILLING_RENEWAL_EXPERIENCE_RESOLVED", {
      user_id: userId,
      renewal_state: empty?.renewal_state,
      available_actions: empty?.available_actions ?? [],
    });
    return empty;
  }

  const subscription = options.subscription ?? canonicalSubscription;
  const plan = await getActivePlanById(supabase, String(subscription.plan_id));
  const strategyInfo = await resolveRenewalStrategyForSubscription(supabase, subscription, { userId });
  const openCycle = await findOpenRenewalCycleForSubscription(supabase, canonicalSubscriptionId, { userId });

  const priceResolution = await resolveEffectiveRenewalPrice(supabase, {
    subscription,
    openRenewalCycle: openCycle,
    plan,
    now,
  });
  logEffectiveRenewalPriceResolved(priceResolution, {
    user_id: userId,
    subscription_id: canonicalSubscriptionId,
    renewal_cycle_id: openCycle?.id != null ? String(openCycle.id) : null,
  });

  const amount = resolveCanonicalRenewalAmount(subscription, plan, priceResolution);
  const planDto = plan
    ? {
        id: String(plan.id),
        name: asTrimmedString(plan.display_name) ?? asTrimmedString(plan.name) ?? String(plan.plan_key),
        plan_key: String(plan.plan_key),
      }
    : null;

  let renewalState = RENEWAL_EXPERIENCE_STATE.ACTIVE_NOT_DUE;
  /** @type {string[]} */
  let availableActions = [];
  /** @type {ReturnType<typeof buildPaymentDto>} */
  let paymentDto = null;
  let paymentMethod = null;
  let primaryAction = null;

  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const renewalDueCivil = openCycle
    ? parseBillingCivilDate(openCycle.renewal_due_date ?? openCycle.cycle_start)
    : null;

  const autoCardHealthy =
    strategyInfo.strategy === RENEWAL_STRATEGY.AUTO_CARD &&
    (!openCycle ||
      ![RENEWAL_STATUS.PAYMENT_FAILED, RENEWAL_STATUS.GRACE_PERIOD, RENEWAL_STATUS.SUSPENDED].includes(
        String(openCycle.renewal_status)
      ));

  if (autoCardHealthy) {
    renewalState = RENEWAL_EXPERIENCE_STATE.ACTIVE_NOT_DUE;
  } else if (
    openCycle &&
    PAYABLE_CYCLE_STATUSES.has(String(openCycle.renewal_status)) &&
    String(openCycle.renewal_status) !== RENEWAL_STATUS.PAID &&
    !openCycle.generated_payment_id &&
    renewalDueCivil &&
    civilNow &&
    civilNow >= renewalDueCivil
  ) {
    renewalState = RENEWAL_EXPERIENCE_STATE.RENEWAL_AWAITING_GENERATION;
    availableActions = [RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION];
    primaryAction = { action: RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION, label: "Renovar assinatura" };
  } else if (!openCycle) {
    renewalState = RENEWAL_EXPERIENCE_STATE.ACTIVE_NOT_DUE;
  } else if (String(openCycle.renewal_status) === RENEWAL_STATUS.PAID) {
    renewalState = RENEWAL_EXPERIENCE_STATE.RENEWAL_PAID;
  } else if (openCycle.generated_payment_id) {
    const paymentRow = await loadPaymentRowById(supabase, openCycle.generated_payment_id);
    if (paymentRow && String(paymentRow.user_id) !== userId) {
      logBilling("billing", "BILLING_RENEWAL_PAYMENT_OWNERSHIP_DENIED", {
        user_id: userId,
        payment_id: paymentRow.id,
        renewal_cycle_id: openCycle.id,
      });
      renewalState = RENEWAL_EXPERIENCE_STATE.PAYMENT_EXPIRED_OR_INVALID;
      availableActions = [RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION];
      primaryAction = {
        action: RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION,
        label: "Renovar assinatura",
      };
    } else {
      paymentMethod = resolveOfficialPaymentMethod(paymentRow?.raw_payload);
      const status = normalizeBillingPaymentStatusKey(paymentRow?.status);

      if (status === "paid") {
        renewalState = RENEWAL_EXPERIENCE_STATE.RENEWAL_PAID;
      } else if (isPaymentExpiredForExperience(paymentRow, now)) {
        renewalState = RENEWAL_EXPERIENCE_STATE.PAYMENT_EXPIRED_OR_INVALID;
        availableActions = [RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION];
        primaryAction = {
          action: RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION,
          label: "Renovar assinatura",
        };
      } else if (paymentMethod === "PIX" && OPEN_PAYMENT_STATUSES.has(status)) {
        renewalState = RENEWAL_EXPERIENCE_STATE.RENEWAL_PIX_OPEN;
        availableActions = [RENEWAL_EXPERIENCE_ACTION.VIEW_PIX];
        primaryAction = { action: RENEWAL_EXPERIENCE_ACTION.VIEW_PIX, label: "Visualizar QR Code do Pix" };
        paymentDto = buildPaymentDto(paymentRow, "PIX", now);
      } else if (paymentMethod === "BOLETO" && OPEN_PAYMENT_STATUSES.has(status)) {
        renewalState = RENEWAL_EXPERIENCE_STATE.RENEWAL_BOLETO_OPEN;
        availableActions = [RENEWAL_EXPERIENCE_ACTION.REISSUE_BOLETO];
        primaryAction = { action: RENEWAL_EXPERIENCE_ACTION.REISSUE_BOLETO, label: "Gerar 2ª via do boleto" };
        paymentDto = buildPaymentDto(paymentRow, "BOLETO", now);
      } else if (paymentMethod && paymentMethod !== "PIX" && paymentMethod !== "BOLETO") {
        renewalState = RENEWAL_EXPERIENCE_STATE.ACTIVE_NOT_DUE;
      } else {
        renewalState = RENEWAL_EXPERIENCE_STATE.RENEWAL_AWAITING_GENERATION;
        availableActions = [RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION];
        primaryAction = { action: RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION, label: "Renovar assinatura" };
      }
    }
  } else if (
    isManualRenewalStrategy(strategyInfo.strategy) &&
    PAYABLE_CYCLE_STATUSES.has(String(openCycle.renewal_status)) &&
    (isSubscriptionPeriodOverdue(subscription, now) ||
      (parseBillingCivilDate(openCycle.renewal_due_date ?? openCycle.cycle_start) ?? "") <= (civilNow ?? ""))
  ) {
    renewalState = RENEWAL_EXPERIENCE_STATE.RENEWAL_AWAITING_GENERATION;
    availableActions = [RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION];
    primaryAction = { action: RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION, label: "Renovar assinatura" };
  }

  const displayDueDate =
    renewalDueCivil ??
    parseBillingCivilDate(openCycle?.renewal_due_date ?? subscription.next_due_date ?? subscription.next_billing_at);
  const dueState = resolveRenewalDueState(displayDueDate, civilNow);

  const duePolicy = resolveRenewalChargeDueDatePolicy({
    cycleDueDate: displayDueDate,
    paymentMethod,
    now,
  });

  const experience = normalizeBillingRenewalExperienceDto({
    renewal_state: renewalState,
    subscription_id: canonicalSubscriptionId,
    renewal_cycle_id: openCycle?.id != null ? String(openCycle.id) : null,
    plan: planDto
      ? {
          id: planDto.id,
          key: planDto.plan_key,
          name: planDto.name,
          plan_key: planDto.plan_key,
        }
      : null,
    amount,
    amount_source: priceResolution.source,
    currency: asTrimmedString(subscription.currency) ?? "BRL",
    period: openCycle ? buildPeriodDto(openCycle) : null,
    due_date: displayDueDate ?? duePolicy.due_date,
    due_state: dueState,
    payment_method: paymentMethod,
    available_payment_methods:
      renewalState === RENEWAL_EXPERIENCE_STATE.RENEWAL_AWAITING_GENERATION ||
      renewalState === RENEWAL_EXPERIENCE_STATE.REACTIVATION_AWAITING_GENERATION
        ? ["PIX", "CREDIT_CARD", "BOLETO"]
        : paymentMethod
          ? [paymentMethod]
          : [],
    available_actions: availableActions,
    payment: paymentDto,
    primary_action: primaryAction,
    renewal_status: openCycle?.renewal_status ?? null,
    renewal_strategy: strategyInfo.strategy,
  });

  const financialState = resolveBillingSubscriptionFinancialState({
    subscription,
    openCycle,
    civilNow,
    now,
  });
  let enrichedExperience = normalizeBillingRenewalExperienceDto(
    applyFinancialStateToRenewalExperience(experience, financialState)
  );

  try {
    const entitlement = normalizeBillingSubscriptionEntitlementDto(
      await resolveBillingSubscriptionEntitlement(supabase, {
        subscription,
        userId,
        financialState,
        usageLimit: null,
        cycleKey: openCycle ? String(openCycle.cycle_start ?? openCycle.renewal_due_date ?? "").slice(0, 10) : civilNow,
        periodStart: subscription.current_period_start ? String(subscription.current_period_start).slice(0, 10) : null,
        periodEnd: subscription.current_period_end ? String(subscription.current_period_end).slice(0, 10) : null,
        now,
      })
    );
    if (entitlement) {
      enrichedExperience = normalizeBillingRenewalExperienceDto({
        ...enrichedExperience,
        ...entitlement,
        access_state: entitlement.access_state ?? enrichedExperience?.access_state,
        financial_primary_action:
          financialState.financial_primary_action ??
          (entitlement.suspension_fallback_active
            ? {
                action: "RENEW_SUBSCRIPTION",
                label: "Reativar plano Elite",
              }
            : enrichedExperience?.primary_action),
      });
      if (entitlement.suspension_fallback_active && financialState.billing_financial_state === BILLING_FINANCIAL_STATE.SUSPENDED) {
        enrichedExperience.primary_action = {
          action: RENEWAL_EXPERIENCE_ACTION.RENEW_SUBSCRIPTION,
          label: "Reativar plano Elite",
        };
      }
    }
  } catch (entitlementErr) {
    logBilling("billing", "BILLING_ENTITLEMENT_RESOLVE_FAILED", {
      user_id: userId,
      subscription_id: canonicalSubscriptionId,
      message: entitlementErr instanceof Error ? entitlementErr.message : String(entitlementErr),
    });
  }

  logBilling("billing", "BILLING_RENEWAL_EXPERIENCE_RESOLVED", {
    user_id: userId,
    subscription_id: enrichedExperience?.subscription_id,
    renewal_cycle_id: enrichedExperience?.renewal_cycle_id,
    renewal_state: enrichedExperience?.renewal_state,
    billing_financial_state: enrichedExperience?.billing_financial_state,
    access_state: enrichedExperience?.access_state,
    payment_context: enrichedExperience?.payment_context,
    available_actions: enrichedExperience?.available_actions ?? [],
    payment_id: enrichedExperience?.payment?.id ?? null,
  });

  if (enrichedExperience?.primary_action?.action) {
    logBilling("billing", "BILLING_RENEWAL_ACTION_RESOLVED", {
      user_id: userId,
      subscription_id: enrichedExperience?.subscription_id,
      renewal_cycle_id: enrichedExperience?.renewal_cycle_id,
      action: enrichedExperience.primary_action.action,
      label: enrichedExperience.primary_action.label,
    });
  }

  return enrichedExperience;
}

/**
 * @param {Awaited<ReturnType<typeof resolveBillingRenewalExperience>>} experience
 */
export function buildRenewalModalPaymentFromExperience(experience) {
  if (!experience?.renewal_cycle_id) return null;
  const amountNumber = experience.amount != null ? Number(experience.amount) : null;
  const amountCents = Number.isFinite(amountNumber) ? Math.round(amountNumber * 100) : null;

  return {
    renewal_cycle_id: experience.renewal_cycle_id,
    plan_name: experience.plan?.name ?? experience.plan?.plan_key ?? null,
    amount_cents: amountCents,
    due_date: experience.due_date,
    period_start: experience.period?.start ?? null,
    period_end: experience.period?.end ?? null,
    billing_state: "awaiting_generation",
    action_type: PAYMENT_HISTORY_ACTION_TYPE.PAY_MONTHLY,
  };
}
