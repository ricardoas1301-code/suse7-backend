// ======================================================================
// Transições canônicas de entitlement — única camada de escrita (S1.HF.6.7)
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_ENTITLEMENT_SOURCE,
  BILLING_FINANCIAL_STATE,
  BILLING_SYNC_METADATA_KEYS,
  BILLING_USAGE_STATE,
  BILLING_USAGE_LIMIT_METADATA_KEYS,
} from "../billingConstants.js";
import { formatBillingCivilDateInSaoPaulo } from "./billingCycleService.js";
import {
  buildSuspensionFallbackActivationPatch,
  readSuspensionFallbackEntitlement,
  rollForwardSuspensionFallbackPeriodIfNeeded,
} from "./billingSuspensionFallbackEntitlementService.js";
import {
  patchSubscriptionEntitlementMetadata,
} from "./billingSellerEntitlementStoreService.js";
import {
  buildHardPausedSyncPatch,
  buildSyncResumePatch,
} from "./billingSyncPauseAuditService.js";
import {
  buildUsageLimitCycleResetPatch,
  buildUsageLimitStatePatch,
  resolveUsageLimitStateMachine,
} from "./billingUsageLimitStateService.js";
import { resolveBabyHardLimitState } from "./billingBabyHardLimitService.js";

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {{ idempotency_key?: string | null; source?: string | null }} [options]
 */
async function loadSubscriptionForTransition(supabase, subscriptionId, options = {}) {
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("id, user_id, plan_id, plan_key, status, metadata")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { subscription: null, metadata: {}, idempotent: false };
  return {
    subscription: data,
    metadata: asObject(data.metadata),
    idempotency_key: options.idempotency_key ?? null,
    source: options.source ?? null,
  };
}

/**
 * Ativa fallback Baby pós-suspensão financeira (idempotente).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 * @param {{ suspension_start?: string | null; now?: Date; financial_state?: string | null; idempotency_key?: string | null; source?: string | null }} [options]
 */
export async function transitionActivateSuspensionFallback(supabase, subscription, options = {}) {
  const financialState = String(options.financial_state ?? "");
  if (financialState !== BILLING_FINANCIAL_STATE.SUSPENDED) {
    return { activated: false, reason: "not_suspended" };
  }

  const subscriptionId = String(subscription.id);
  const meta = asObject(subscription.metadata);
  const existing = readSuspensionFallbackEntitlement(meta);
  if (existing.active) {
    return { activated: false, idempotent: true, fallback: existing };
  }

  const patch = buildSuspensionFallbackActivationPatch(subscription, options);
  if (!patch) return { activated: false, reason: "period_unresolved" };

  await patchSubscriptionEntitlementMetadata(supabase, subscriptionId, meta, patch, {
    idempotency_key: options.idempotency_key,
    source: options.source ?? "transition_activate_suspension_fallback",
  });

  logBilling("billing", "BILLING_SUSPENSION_FALLBACK_ACTIVATED", {
    user_id: subscription.user_id,
    subscription_id: subscriptionId,
    source: options.source ?? "transition_service",
  });

  return { activated: true, fallback: readSuspensionFallbackEntitlement({ ...meta, ...patch }) };
}

/**
 * Desativa fallback Baby (reativação/upgrade pago).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {{ payment_id?: string | null; idempotency_key?: string | null; source?: string | null }} [options]
 */
export async function transitionDeactivateSuspensionFallback(supabase, subscriptionId, options = {}) {
  const loaded = await loadSubscriptionForTransition(supabase, subscriptionId, options);
  if (!loaded.subscription) return { deactivated: false, reason: "subscription_not_found" };
  const meta = loaded.metadata;
  if (!meta.suspension_fallback_active) {
    return { deactivated: false, idempotent: true, reason: "fallback_not_active" };
  }

  const resumePatch = buildSyncResumePatch(formatBillingCivilDateInSaoPaulo(new Date()) ?? "", new Date());
  await patchSubscriptionEntitlementMetadata(
    supabase,
    subscriptionId,
    meta,
    {
      suspension_fallback_active: false,
      suspension_fallback_deactivated_at: new Date().toISOString(),
      suspension_fallback_deactivated_payment_id: options.payment_id ?? null,
      ...resumePatch,
      [BILLING_USAGE_LIMIT_METADATA_KEYS.USAGE_STATE]: BILLING_USAGE_STATE.WITHIN_LIMIT,
      [BILLING_USAGE_LIMIT_METADATA_KEYS.GRACE_CONSUMED_IN_CYCLE]: false,
    },
    { idempotency_key: options.idempotency_key, source: options.source ?? "transition_deactivate_fallback" }
  );

  return { deactivated: true };
}

/**
 * Persiste transição de uso (grace/restricted) — plano pago.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {Awaited<ReturnType<typeof resolveUsageLimitStateMachine>>} machine
 * @param {Record<string, unknown>} metadata
 * @param {{ idempotency_key?: string | null; source?: string | null }} [options]
 */
export async function transitionApplyPaidUsageMachine(
  supabase,
  subscriptionId,
  machine,
  metadata,
  options = {}
) {
  if (!machine.metadata_patch) return { applied: false, idempotent: true };
  await patchSubscriptionEntitlementMetadata(supabase, subscriptionId, metadata, machine.metadata_patch, {
    idempotency_key: options.idempotency_key,
    source: options.source ?? "transition_paid_usage",
  });
  return { applied: true, usage_state: machine.usage_state };
}

/**
 * 60ª venda Baby — HARD_LIMIT_REACHED + HARD_PAUSED (idempotente).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {{ usage_count: number; usage_limit: number; idempotency_key?: string | null; source?: string | null; now?: Date }} ctx
 */
export async function transitionActivateBabyHardPaused(supabase, subscriptionId, ctx) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const civilNow = formatBillingCivilDateInSaoPaulo(now) ?? "";
  const loaded = await loadSubscriptionForTransition(supabase, subscriptionId, ctx);
  if (!loaded.subscription) return { activated: false, reason: "subscription_not_found" };

  const meta = loaded.metadata;
  if (meta[BILLING_SYNC_METADATA_KEYS.SYNC_STATE] === "HARD_PAUSED") {
    return { activated: false, idempotent: true, sync_state: "HARD_PAUSED" };
  }

  const usagePatch = {
    [BILLING_USAGE_LIMIT_METADATA_KEYS.USAGE_STATE]: BILLING_USAGE_STATE.HARD_LIMIT_REACHED,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.BILLED_COUNT]: ctx.usage_count,
    [BILLING_SYNC_METADATA_KEYS.LAST_DATA_UPDATED_AT]: civilNow,
  };
  const syncPatch = buildHardPausedSyncPatch({}, civilNow, now);

  await patchSubscriptionEntitlementMetadata(supabase, subscriptionId, meta, { ...usagePatch, ...syncPatch }, {
    idempotency_key: ctx.idempotency_key,
    source: ctx.source ?? "transition_baby_hard_paused",
  });

  logBilling("billing", "BILLING_BABY_HARD_PAUSED_ACTIVATED", {
    subscription_id: subscriptionId,
    usage_count: ctx.usage_count,
    usage_limit: ctx.usage_limit,
  });

  return { activated: true, sync_state: "HARD_PAUSED", usage_state: BILLING_USAGE_STATE.HARD_LIMIT_REACHED };
}

/**
 * Virada de ciclo Baby — retoma sync sem backfill.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {{ cycle_key: string; idempotency_key?: string | null; source?: string | null; now?: Date }} ctx
 */
export async function transitionRollForwardBabyCycle(supabase, subscriptionId, ctx) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const civilNow = formatBillingCivilDateInSaoPaulo(now) ?? "";
  const loaded = await loadSubscriptionForTransition(supabase, subscriptionId, ctx);
  if (!loaded.subscription) return { rolled: false, reason: "subscription_not_found" };

  const meta = loaded.metadata;
  const fallback = readSuspensionFallbackEntitlement(meta);
  const rolled = rollForwardSuspensionFallbackPeriodIfNeeded(fallback, civilNow);
  if (!rolled.metadata_patch) return { rolled: false, idempotent: true };

  const resumePatch = buildSyncResumePatch(civilNow, now);
  const resetPatch = buildUsageLimitCycleResetPatch(ctx.cycle_key);

  await patchSubscriptionEntitlementMetadata(
    supabase,
    subscriptionId,
    meta,
    { ...rolled.metadata_patch, ...resetPatch, ...resumePatch },
    { idempotency_key: ctx.idempotency_key, source: ctx.source ?? "transition_baby_cycle_roll" }
  );

  return { rolled: true, fallback: rolled.fallback, sync_state: "FULL" };
}

/**
 * Avalia admissão de venda faturável com projeção de contagem (Baby concorrência).
 *
 * @param {{
 *   effective_entitlement: string | null;
 *   sync_state: string | null;
 *   usage_count: number;
 *   usage_limit: number | null;
 *   projected_count: number;
 *   is_baby: boolean;
 * }} input
 */
export function evaluateBillableSaleAdmission(input) {
  if (input.sync_state === "HARD_PAUSED") {
    return { admit: false, reason: "hard_paused", process_sale: false, activate_hard_pause: false };
  }

  if (!input.is_baby) {
    return { admit: true, reason: "paid_plan", process_sale: true, activate_hard_pause: false };
  }

  const limit = input.usage_limit ?? 60;
  const projected = input.projected_count;

  if (projected > limit) {
    return {
      admit: false,
      reason: "baby_hard_limit_reached",
      domain_code: "BABY_HARD_LIMIT_REACHED",
      process_sale: false,
      activate_hard_pause: false,
    };
  }

  if (projected === limit) {
    return { admit: true, reason: "baby_last_slot", process_sale: true, activate_hard_pause: true };
  }

  return { admit: true, reason: "baby_within_limit", process_sale: true, activate_hard_pause: false };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {{ projected_count: number; usage_limit: number; idempotency_key?: string; source?: string; now?: Date }} ctx
 */
export async function transitionOnBillableSaleRecorded(supabase, subscriptionId, ctx) {
  const babyState = resolveBabyHardLimitState({
    usageCount: ctx.projected_count,
    usageLimit: ctx.usage_limit,
  });
  if (!babyState.should_hard_pause) {
    return { hard_paused: false };
  }
  return transitionActivateBabyHardPaused(supabase, subscriptionId, {
    usage_count: ctx.projected_count,
    usage_limit: ctx.usage_limit,
    idempotency_key: ctx.idempotency_key,
    source: ctx.source ?? "billable_sale_recorded",
    now: ctx.now,
  });
}

/**
 * Encerrar tolerância civil expirada (job/maintenance).
 */
export async function transitionExpirePaidUsageGraceIfDue(
  supabase,
  subscriptionId,
  machine,
  metadata,
  options = {}
) {
  if (machine.usage_state !== BILLING_USAGE_STATE.LIMIT_RESTRICTED || !machine.metadata_patch) {
    return { expired: false, idempotent: true };
  }
  return transitionApplyPaidUsageMachine(supabase, subscriptionId, machine, metadata, options);
}

// Re-export para compatibilidade com serviços legados
export {
  transitionActivateSuspensionFallback as ensureSuspensionFallbackEntitlementTransition,
  transitionDeactivateSuspensionFallback as deactivateSuspensionFallbackEntitlementTransition,
};
