// ======================================================================
// Fallback Baby gratuito pós-suspensão financeira (entitlement interno — S1.HF.6.6)
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_ENTITLEMENT_SOURCE,
  BILLING_FINANCIAL_STATE,
  BILLING_SUSPENSION_FALLBACK_METADATA_KEYS,
  BILLING_SUSPENSION_FALLBACK_PLAN_KEY,
  BILLING_SUSPENSION_FALLBACK_SALES_LIMIT_DEFAULT,
  BILLING_TRIAL_METADATA_KEYS,
  BILLING_USAGE_LIMIT_METADATA_KEYS,
} from "../billingConstants.js";
import { buildSalesLimitSnapshotPatchFromCatalog } from "./billingSalesLimitSnapshotService.js";
import {
  addBillingCivilDays,
  addUtcMonthsKeepingAnchorDay,
  deriveInclusivePeriodEndBeforeNextBilling,
  formatBillingCivilDateInSaoPaulo,
  formatUtcDateOnly,
  isoBillingPeriodStartFromCivil,
  parseBillingCivilDate,
  startOfUtcDay,
} from "./billingCycleService.js";

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

export function resolveSuspensionFallbackSalesLimit() {
  const raw = Number(
    process.env.BILLING_SUSPENSION_FALLBACK_SALES_LIMIT ?? BILLING_SUSPENSION_FALLBACK_SALES_LIMIT_DEFAULT
  );
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : BILLING_SUSPENSION_FALLBACK_SALES_LIMIT_DEFAULT;
}

/**
 * @param {string | null | undefined} suspensionStartCivil
 */
export function buildSuspensionFallbackPeriodFromStart(suspensionStartCivil) {
  const startCivil = parseBillingCivilDate(suspensionStartCivil);
  if (!startCivil) return null;

  const periodStartIso = isoBillingPeriodStartFromCivil(startCivil);
  const periodStart = startOfUtcDay(periodStartIso);
  if (!periodStart) return null;

  const anchorDay = Number(startCivil.split("-")[2]);
  const safeAnchorDay = Number.isFinite(anchorDay) && anchorDay >= 1 && anchorDay <= 31 ? anchorDay : periodStart.getUTCDate();
  const nextBillingAt = addUtcMonthsKeepingAnchorDay(periodStart, 1, safeAnchorDay);
  const periodEnd = deriveInclusivePeriodEndBeforeNextBilling(nextBillingAt);

  return {
    fallback_period_start: startCivil,
    fallback_period_end: formatUtcDateOnly(periodEnd),
    fallback_next_reset: formatUtcDateOnly(nextBillingAt),
    fallback_period_start_iso: periodStartIso,
    fallback_period_end_iso: periodEnd.toISOString(),
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
export function readSuspensionFallbackEntitlement(metadata) {
  const meta = asObject(metadata);
  const active = Boolean(meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.ACTIVE]);
  if (!active) {
    return {
      active: false,
      effective_entitlement: null,
      effective_entitlement_source: null,
      effective_plan_key: null,
      fallback_period_start: null,
      fallback_period_end: null,
      fallback_next_reset: null,
      activated_at: null,
      usage_limit: null,
      contracted_plan_key: asTrimmedString(meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.CONTRACTED_PLAN_KEY]),
    };
  }

  return {
    active: true,
    effective_entitlement:
      asTrimmedString(meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.ENTITLEMENT]) ??
      BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE,
    effective_entitlement_source:
      asTrimmedString(meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.SOURCE]) ??
      BILLING_ENTITLEMENT_SOURCE.SUSPENSION_FALLBACK,
    effective_plan_key:
      asTrimmedString(meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PLAN_KEY]) ?? BILLING_SUSPENSION_FALLBACK_PLAN_KEY,
    fallback_period_start: parseBillingCivilDate(meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PERIOD_START]),
    fallback_period_end: parseBillingCivilDate(meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PERIOD_END]),
    fallback_next_reset: parseBillingCivilDate(meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.NEXT_RESET]),
    activated_at: asTrimmedString(meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.ACTIVATED_AT]),
    usage_limit: resolveSuspensionFallbackSalesLimit(),
    contracted_plan_key: asTrimmedString(meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.CONTRACTED_PLAN_KEY]),
  };
}

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Rola o ciclo do fallback quando a data civil ultrapassa o fim do período.
 *
 * @param {ReturnType<typeof readSuspensionFallbackEntitlement>} fallback
 * @param {string | null} civilNow
 */
export function rollForwardSuspensionFallbackPeriodIfNeeded(fallback, civilNow) {
  if (!fallback.active) return { fallback, metadata_patch: null };
  const nowCivil = parseBillingCivilDate(civilNow);
  const periodEnd = parseBillingCivilDate(fallback.fallback_period_end);
  if (!nowCivil || !periodEnd || nowCivil <= periodEnd) {
    return { fallback, metadata_patch: null };
  }

  const nextStart = addBillingCivilDays(fallback.fallback_next_reset ?? addBillingCivilDays(periodEnd, 1), 0);
  const rebuilt = buildSuspensionFallbackPeriodFromStart(nextStart ?? fallback.fallback_next_reset);
  if (!rebuilt) return { fallback, metadata_patch: null };

  const nextFallback = {
    ...fallback,
    fallback_period_start: rebuilt.fallback_period_start,
    fallback_period_end: rebuilt.fallback_period_end,
    fallback_next_reset: rebuilt.fallback_next_reset,
  };

  return {
    fallback: nextFallback,
    metadata_patch: {
      [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PERIOD_START]: rebuilt.fallback_period_start,
      [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PERIOD_END]: rebuilt.fallback_period_end,
      [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.NEXT_RESET]: rebuilt.fallback_next_reset,
    },
  };
}

/**
 * @param {Record<string, unknown>} subscription
 * @param {{ suspension_start?: string | null; now?: Date }} [options]
 */
export function buildSuspensionFallbackActivationPatch(subscription, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const suspensionStart =
    parseBillingCivilDate(options.suspension_start) ??
    formatBillingCivilDateInSaoPaulo(now);
  const period = buildSuspensionFallbackPeriodFromStart(suspensionStart);
  if (!period) return null;

  const contractedPlanKey = asTrimmedString(subscription.plan_key) ?? asTrimmedString(subscription.plan_id);

  const activatedAt = now.toISOString();
  return {
    [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.ACTIVE]: true,
    [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.SOURCE]: BILLING_ENTITLEMENT_SOURCE.BABY_FALLBACK,
    [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.ENTITLEMENT]: BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE,
    [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PLAN_KEY]: BILLING_SUSPENSION_FALLBACK_PLAN_KEY,
    [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.CONTRACTED_PLAN_KEY]: contractedPlanKey,
    [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PERIOD_START]: period.fallback_period_start,
    [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PERIOD_END]: period.fallback_period_end,
    [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.NEXT_RESET]: period.fallback_next_reset,
    [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.ACTIVATED_AT]: activatedAt,
    // 6.9A.8 — franquia nasce 0 no instante efetivo da ativação Baby.
    [BILLING_TRIAL_METADATA_KEYS.QUOTA_COUNTING_STARTED_AT]: activatedAt,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.BILLED_COUNT]: 0,
    [BILLING_USAGE_LIMIT_METADATA_KEYS.CYCLE_KEY]: period.fallback_period_start,
    // 6.9A.12 — owner financeiro; não sobrescrever plan_id/preço/anchor da assinatura.
    access_restriction_reason: "PAYMENT_DELINQUENCY",
    access_owner: "PAYMENT_DELINQUENCY_ENGINE",
    paid_subscription_status: "SUSPENDED",
    entitlement_source: BILLING_ENTITLEMENT_SOURCE.BABY_FALLBACK,
    baby_usage_grace_days: 0,
    sync_state: "FULL",
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {Record<string, unknown>} subscription
 * @param {{ suspension_start?: string | null; now?: Date; financial_state?: string | null }} [options]
 */
export async function ensureSuspensionFallbackEntitlement(supabase, subscription, options = {}) {
  const financialState = String(options.financial_state ?? "");
  if (financialState !== BILLING_FINANCIAL_STATE.SUSPENDED) {
    return { activated: false, reason: "not_suspended" };
  }

  const subscriptionId = String(subscription.id);
  const meta = asObject(subscription.metadata);
  const existing = readSuspensionFallbackEntitlement(meta);
  if (existing.active) {
    const civilNow = formatBillingCivilDateInSaoPaulo(options.now ?? new Date());
    const rolled = rollForwardSuspensionFallbackPeriodIfNeeded(existing, civilNow);
    if (rolled.metadata_patch) {
      const cycleKey = rolled.metadata_patch[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PERIOD_START];
      const snapshotPatch =
        cycleKey != null
          ? await buildSalesLimitSnapshotPatchFromCatalog(
              supabase,
              BILLING_SUSPENSION_FALLBACK_PLAN_KEY,
              String(cycleKey),
            )
          : {};
      await patchSubscriptionMetadata(supabase, subscriptionId, meta, {
        ...rolled.metadata_patch,
        ...snapshotPatch,
      });
    }
    return { activated: false, idempotent: true, fallback: rolled.fallback };
  }

  const patch = buildSuspensionFallbackActivationPatch(subscription, options);
  if (!patch) return { activated: false, reason: "period_unresolved" };

  const cycleKey = patch[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PERIOD_START];
  const snapshotPatch = await buildSalesLimitSnapshotPatchFromCatalog(
    supabase,
    BILLING_SUSPENSION_FALLBACK_PLAN_KEY,
    String(cycleKey),
  );

  await patchSubscriptionMetadata(supabase, subscriptionId, meta, { ...patch, ...snapshotPatch });
  logBilling("billing", "BILLING_SUSPENSION_FALLBACK_ACTIVATED", {
    user_id: subscription.user_id,
    subscription_id: subscriptionId,
    fallback_period_start: patch[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PERIOD_START],
    fallback_period_end: patch[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.PERIOD_END],
    usage_limit: resolveSuspensionFallbackSalesLimit(),
  });

  return {
    activated: true,
    fallback: readSuspensionFallbackEntitlement({ ...meta, ...patch }),
  };
}

/**
 * Desativa fallback Baby após reativação do plano pago (idempotente).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {{ payment_id?: string | null; source?: string }} [options]
 */
export async function deactivateSuspensionFallbackEntitlement(supabase, subscriptionId, options = {}) {
  const { data: row, error } = await supabase
    .from("billing_subscriptions")
    .select("metadata, user_id")
    .eq("id", subscriptionId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { deactivated: false, reason: "subscription_not_found" };

  const meta = asObject(row.metadata);
  if (!meta[BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.ACTIVE]) {
    return { deactivated: false, idempotent: true, reason: "fallback_not_active" };
  }

  const patch = {
    [BILLING_SUSPENSION_FALLBACK_METADATA_KEYS.ACTIVE]: false,
    suspension_fallback_deactivated_at: new Date().toISOString(),
    suspension_fallback_deactivated_payment_id: options.payment_id ?? null,
  };

  await patchSubscriptionMetadata(supabase, subscriptionId, meta, patch);
  logBilling("billing", "BILLING_SUSPENSION_FALLBACK_DEACTIVATED", {
    user_id: row.user_id,
    subscription_id: subscriptionId,
    payment_id: options.payment_id ?? null,
    source: options.source ?? "reactivation",
  });

  return { deactivated: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} subscriptionId
 * @param {Record<string, unknown>} currentMeta
 * @param {Record<string, unknown>} patch
 */
async function patchSubscriptionMetadata(supabase, subscriptionId, currentMeta, patch) {
  const nextMeta = { ...currentMeta, ...patch };
  const { error } = await supabase
    .from("billing_subscriptions")
    .update({ metadata: nextMeta, updated_at: new Date().toISOString() })
    .eq("id", subscriptionId);
  if (error) throw error;
}
