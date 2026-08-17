import { SUBSCRIPTION_STATUS } from "../../billing/billingConstants.js";
import { resolveSellerBillingCycle } from "../../billing/services/billingCycleService.js";
import {
  pickActiveSubscription,
  pickLatestSubscription,
} from "../../billing/services/billingSubscriptionQueryService.js";
import { resolveMonthlySalesUsage } from "../../billing/services/billingUsageService.js";
import {
  DEV_CENTER_TOOLBOX_DEFAULTS,
  DEV_CENTER_TOOLBOX_METADATA_KEYS,
  isDevCenterToolboxSubscriptionActionId,
} from "./devCenterToolboxOperationalConstants.js";
import { registrarAuditoriaOperacionalToolbox } from "./devCenterToolboxOperationalAuditService.js";
import {
  buildSubscriptionAfterSnapshot,
  buildSubscriptionBeforeSnapshot,
} from "./devCenterToolboxOperationalTimelineService.js";
import { buildDevCenterSellerSubscriptionUsageBlock } from "./devCenterSellerSubscriptionUsageHelper.js";

const SUBSCRIPTION_SELECT =
  "id, user_id, plan_id, plan_key, status, current_period_start, current_period_end, next_due_date, metadata, updated_at";

/**
 * @param {Record<string, unknown> | null | undefined} sub
 */
function readSubscriptionMeta(sub) {
  return sub?.metadata && typeof sub.metadata === "object"
    ? /** @type {Record<string, unknown>} */ ({ ...sub.metadata })
    : {};
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 */
async function loadPrimarySubscription(supabase, sellerId) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select(SUBSCRIPTION_SELECT)
    .eq("user_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) throw error;

  const list = Array.isArray(data) ? data : [];
  return pickActiveSubscription(list) ?? pickLatestSubscription(list);
}

/**
 * @param {string | null | undefined} iso
 * @param {number} days
 */
function addDaysToIso(iso, days) {
  const base = iso ? new Date(String(iso)) : new Date();
  const date = Number.isNaN(base.getTime()) ? new Date() : base;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {Record<string, unknown>} patch
 */
async function persistSubscriptionPatch(supabase, subscriptionId, patch) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", subscriptionId)
    .select(SUBSCRIPTION_SELECT)
    .single();

  if (error) throw error;
  return data;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {{ period_start: string; period_end: string; window_kind: string }} window
 */
async function resetMonthlyUsageForWindow(supabase, sellerId, window) {
  const row = {
    user_id: sellerId,
    period_start: window.period_start,
    period_end: window.period_end,
    window_kind: window.window_kind,
    sales_count: 0,
    metadata: {
      admin_reset: true,
      aggregation_scope: "seller_ecosystem",
      reset_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("billing_monthly_usage").upsert(row, {
    onConflict: "user_id,period_start,period_end,window_kind",
  });

  if (error) throw error;
}

/**
 * @param {string} reason
 */
function shouldSimulateDevFailure(reason) {
  return (
    process.env.NODE_ENV !== "production" &&
    String(reason ?? "").includes("[DEV:FORCE_ERROR]")
  );
}

/**
 * @param {Record<string, unknown>} sub
 * @param {Record<string, unknown>} meta
 */
function buildEnableTrialPatch(sub, meta) {
  const trialEndsAt = addDaysToIso(new Date().toISOString(), DEV_CENTER_TOOLBOX_DEFAULTS.TRIAL_DAYS);
  const nextMeta = {
    ...meta,
    [DEV_CENTER_TOOLBOX_METADATA_KEYS.TRIAL_ENDS_AT]: trialEndsAt,
    [DEV_CENTER_TOOLBOX_METADATA_KEYS.TRIAL_STARTED_AT]: new Date().toISOString(),
    [DEV_CENTER_TOOLBOX_METADATA_KEYS.TRIAL_ENDED_AT]: null,
  };

  const status = String(sub.status ?? "").toLowerCase();
  const nextStatus =
    status === SUBSCRIPTION_STATUS.CANCELED || status === SUBSCRIPTION_STATUS.REFUNDED
      ? SUBSCRIPTION_STATUS.PENDING
      : sub.status ?? SUBSCRIPTION_STATUS.PENDING;

  return {
    status: nextStatus,
    current_period_end: trialEndsAt,
    next_due_date: trialEndsAt.slice(0, 10),
    metadata: nextMeta,
    result: {
      trialStatus: "active",
      trialDaysGranted: DEV_CENTER_TOOLBOX_DEFAULTS.TRIAL_DAYS,
      trialEndsAt,
    },
  };
}

/**
 * @param {Record<string, unknown>} sub
 * @param {Record<string, unknown>} meta
 */
function buildEndTrialPatch(sub, meta) {
  const nextMeta = {
    ...meta,
    [DEV_CENTER_TOOLBOX_METADATA_KEYS.TRIAL_ENDS_AT]: null,
    [DEV_CENTER_TOOLBOX_METADATA_KEYS.TRIAL_ENDED_AT]: new Date().toISOString(),
  };

  const status = String(sub.status ?? "").toLowerCase();
  const nextStatus = status === SUBSCRIPTION_STATUS.PENDING ? SUBSCRIPTION_STATUS.ACTIVE : sub.status;

  return {
    status: nextStatus,
    metadata: nextMeta,
    result: {
      trialStatus: "ended",
    },
  };
}

/**
 * @param {Record<string, unknown>} sub
 * @param {Record<string, unknown>} meta
 */
function buildAddDaysPatch(sub, meta) {
  const days = DEV_CENTER_TOOLBOX_DEFAULTS.ADDED_DAYS;
  const baseEnd = sub.current_period_end ?? meta[DEV_CENTER_TOOLBOX_METADATA_KEYS.TRIAL_ENDS_AT] ?? null;
  const nextEnd = addDaysToIso(baseEnd, days);
  const nextMeta = {
    ...meta,
    [DEV_CENTER_TOOLBOX_METADATA_KEYS.EXTRA_DAYS_TOTAL]:
      (Number(meta[DEV_CENTER_TOOLBOX_METADATA_KEYS.EXTRA_DAYS_TOTAL]) || 0) + days,
  };

  if (meta[DEV_CENTER_TOOLBOX_METADATA_KEYS.TRIAL_ENDS_AT]) {
    nextMeta[DEV_CENTER_TOOLBOX_METADATA_KEYS.TRIAL_ENDS_AT] = nextEnd;
  }

  return {
    current_period_end: nextEnd,
    next_due_date: nextEnd.slice(0, 10),
    metadata: nextMeta,
    result: {
      addedDays: days,
      currentPeriodEnd: nextEnd,
    },
  };
}

/**
 * @param {Record<string, unknown>} meta
 */
function buildAddSalesPatch(meta) {
  const sales = DEV_CENTER_TOOLBOX_DEFAULTS.ADDED_SALES;
  const previousBonus = Number(meta[DEV_CENTER_TOOLBOX_METADATA_KEYS.EXTRA_SALES_BONUS]) || 0;
  const nextBonus = previousBonus + sales;

  return {
    metadata: {
      ...meta,
      [DEV_CENTER_TOOLBOX_METADATA_KEYS.EXTRA_SALES_BONUS]: nextBonus,
    },
    result: {
      addedSales: sales,
      extraSalesBonus: nextBonus,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {Record<string, unknown>} meta
 */
async function buildResetConsumptionPatch(supabase, sellerId, meta) {
  const cycle = await resolveSellerBillingCycle(supabase, sellerId);
  await resetMonthlyUsageForWindow(supabase, sellerId, cycle.cycle);

  const resetAt = new Date().toISOString();
  return {
    metadata: {
      ...meta,
      [DEV_CENTER_TOOLBOX_METADATA_KEYS.USAGE_RESET_AT]: resetAt,
    },
    result: {
      previousConsumed: null,
      newConsumed: 0,
      consumed: 0,
      resetAt,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {Record<string, unknown>} sub
 * @param {Record<string, unknown>} meta
 */
async function buildRecalculateConsumptionPatch(supabase, sellerId, sub, meta) {
  const usageResolution = await resolveMonthlySalesUsage(
    supabase,
    sellerId,
    sub.plan_id != null ? String(sub.plan_id) : null,
  );
  const usageBlock = await buildDevCenterSellerSubscriptionUsageBlock(supabase, sellerId, sub);
  const recalculatedAt = new Date().toISOString();
  const previousConsumed = usageBlock?.previous_consumed ?? null;
  const newConsumed = usageBlock?.current ?? usageResolution.current_month_sales ?? 0;

  return {
    metadata: {
      ...meta,
      [DEV_CENTER_TOOLBOX_METADATA_KEYS.USAGE_RECALCULATED_AT]: recalculatedAt,
    },
    result: {
      previousConsumed,
      newConsumed,
      consumed: newConsumed,
      monthlyLimit: usageBlock?.limit ?? usageResolution.monthly_sales_limit ?? null,
      recalculatedAt,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} sellerId
 * @param {{
 *   actionId: string;
 *   reason: string;
 *   operatorUserId: string;
 *   operatorEmail?: string | null;
 *   metadata?: Record<string, unknown> | null;
 * }} input
 */
export async function executarOperacaoAssinaturaSellerDevCenter(supabase, sellerId, input) {
  const actionId = String(input.actionId ?? "").trim();
  const reason = String(input.reason ?? "").trim();

  if (!isDevCenterToolboxSubscriptionActionId(actionId)) {
    const error = { code: "INVALID_ACTION", message: "Operação de assinatura inválida." };
    return { ok: false, status: "error", error };
  }

  if (reason.length < DEV_CENTER_TOOLBOX_DEFAULTS.REASON_MIN_LENGTH) {
    const error = {
      code: "INVALID_REASON",
      message: `Motivo operacional deve ter ao menos ${DEV_CENTER_TOOLBOX_DEFAULTS.REASON_MIN_LENGTH} caracteres.`,
    };
    return { ok: false, status: "error", error };
  }

  if (shouldSimulateDevFailure(reason)) {
    const audit = await registrarAuditoriaOperacionalToolbox(supabase, {
      sellerId,
      operatorUserId: input.operatorUserId,
      operatorEmail: input.operatorEmail ?? null,
      operationType: actionId,
      reason,
      payload: { simulated: true, dev_force_error: true },
      status: "error",
      errorCode: "DEV_FORCE_ERROR",
    });

    return {
      ok: false,
      status: "error",
      error: { code: "DEV_FORCE_ERROR", message: "Falha simulada via [DEV:FORCE_ERROR]." },
      auditId: audit?.id ?? null,
    };
  }

  const subscription = await loadPrimarySubscription(supabase, sellerId);
  if (!subscription?.id) {
    const audit = await registrarAuditoriaOperacionalToolbox(supabase, {
      sellerId,
      operatorUserId: input.operatorUserId,
      operatorEmail: input.operatorEmail ?? null,
      operationType: actionId,
      reason,
      payload: { blocked: true },
      status: "blocked",
      errorCode: "SUBSCRIPTION_NOT_FOUND",
    });

    return {
      ok: false,
      status: "blocked",
      error: { code: "SUBSCRIPTION_NOT_FOUND", message: "Seller não possui assinatura para operar." },
      auditId: audit?.id ?? null,
    };
  }

  const subscriptionId = String(subscription.id);
  const meta = readSubscriptionMeta(subscription);
  const beforeState = buildSubscriptionBeforeSnapshot(subscription, meta);

  /** @type {{ patch: Record<string, unknown>; result: Record<string, unknown> }} */
  let operation;

  switch (actionId) {
    case "enable_trial":
      operation = buildEnableTrialPatch(subscription, meta);
      break;
    case "end_trial":
      operation = buildEndTrialPatch(subscription, meta);
      break;
    case "add_subscription_days":
      operation = buildAddDaysPatch(subscription, meta);
      break;
    case "add_subscription_sales":
      operation = buildAddSalesPatch(meta);
      break;
    case "reset_consumption":
      operation = await buildResetConsumptionPatch(supabase, sellerId, meta);
      break;
    case "recalculate_consumption":
      operation = await buildRecalculateConsumptionPatch(supabase, sellerId, subscription, meta);
      break;
    default:
      return {
        ok: false,
        status: "error",
        error: { code: "INVALID_ACTION", message: "Operação não suportada." },
      };
  }

  try {
    const { result, ...patch } = operation;
    await persistSubscriptionPatch(supabase, subscriptionId, patch);

    const afterState = buildSubscriptionAfterSnapshot(beforeState, result, actionId);

    const audit = await registrarAuditoriaOperacionalToolbox(supabase, {
      sellerId,
      subscriptionId,
      operatorUserId: input.operatorUserId,
      operatorEmail: input.operatorEmail ?? null,
      operationType: actionId,
      reason,
      payload: {
        actionId,
        result,
        operator_metadata: input.metadata ?? null,
      },
      beforeState,
      afterState,
      status: "success",
    });

    if (!audit?.id) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "AUDIT_PERSISTENCE_FAILED",
          message: "Operação persistida, mas auditoria operacional não foi registrada.",
        },
        subscriptionId,
        result,
        auditId: null,
      };
    }

    return {
      ok: true,
      status: "success",
      operationId: actionId,
      subscriptionId,
      result,
      auditId: audit.id,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Erro ao persistir operação.";

    const audit = await registrarAuditoriaOperacionalToolbox(supabase, {
      sellerId,
      subscriptionId,
      operatorUserId: input.operatorUserId,
      operatorEmail: input.operatorEmail ?? null,
      operationType: actionId,
      reason,
      payload: { actionId },
      status: "error",
      errorCode: "PERSISTENCE_FAILED",
    });

    return {
      ok: false,
      status: "error",
      error: { code: "PERSISTENCE_FAILED", message },
      auditId: audit?.id ?? null,
    };
  }
}
