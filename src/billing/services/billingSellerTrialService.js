// ======================================================================
// Trial 15 dias — fundação canônica (S1.HF.6.7)
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_ENTITLEMENT_SOURCE,
  BILLING_FINANCIAL_STATE_NOT_APPLICABLE,
  BILLING_SYNC_STATE,
  BILLING_TRIAL_ACTIVATION_EVENT,
  BILLING_TRIAL_METADATA_KEYS,
  BILLING_TRIAL_STATE,
  BILLING_ACCESS_STATE,
} from "../billingConstants.js";
import {
  addBillingCivilDays,
  diffBillingCivilDays,
  formatBillingCivilDateInSaoPaulo,
  parseBillingCivilDate,
} from "./billingCycleService.js";
import {
  ensureSellerEntitlementOverlay,
  loadSellerEntitlementOverlay,
  patchSellerEntitlementOverlayMetadata,
} from "./billingSellerEntitlementStoreService.js";
import { resolveTrialDurationDays } from "./billingTrialConfigService.js";
import { buildSuspensionFallbackPeriodFromStart } from "./billingSuspensionFallbackEntitlementService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} metadata
 */
export function readSellerTrialState(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  return {
    trial_state: asTrimmedString(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_STATE]) ?? BILLING_TRIAL_STATE.NOT_STARTED,
    trial_started_at: asTrimmedString(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_STARTED_AT]),
    trial_start_date: parseBillingCivilDate(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_START_DATE]),
    trial_end_date: parseBillingCivilDate(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_END_DATE]),
    trial_ends_at: asTrimmedString(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_ENDS_AT]),
    trial_activation_source: asTrimmedString(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_ACTIVATION_SOURCE]),
    trial_usage_limit: null,
    trial_usage_count: meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_USAGE_COUNT] != null ? Number(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_USAGE_COUNT]) : 0,
    trial_converted_at: asTrimmedString(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_CONVERTED_AT]),
    trial_selected_plan_id: asTrimmedString(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_SELECTED_PLAN_ID]),
    trial_fingerprint: asTrimmedString(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_FINGERPRINT]),
    trial_eligibility_expires_at: parseBillingCivilDate(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_ELIGIBILITY_EXPIRES_AT]),
    trial_original_end_date: parseBillingCivilDate(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_ORIGINAL_END_DATE]),
    trial_extended_end_date: parseBillingCivilDate(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_EXTENDED_END_DATE]),
    trial_consumed: Boolean(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_CONSUMED]),
    operational_cutover_at: asTrimmedString(meta[BILLING_TRIAL_METADATA_KEYS.OPERATIONAL_CUTOVER_AT]),
    quota_counting_started_at: asTrimmedString(meta[BILLING_TRIAL_METADATA_KEYS.QUOTA_COUNTING_STARTED_AT]),
  };
}

/**
 * Contagem inclusiva: ativação 22/07 + 15 dias => termina 05/08 (dia 15 inclusive).
 *
 * @param {string} startCivil
 * @param {number} [durationDays]
 */
export function computeTrialEndDateInclusive(startCivil, durationDays = resolveTrialDurationDays()) {
  const start = parseBillingCivilDate(startCivil);
  if (!start) return null;
  return addBillingCivilDays(start, Math.max(0, durationDays - 1));
}

/**
 * @param {ReturnType<typeof readSellerTrialState>} trial
 * @param {string | null} civilNow
 */
export function resolveTrialTemporalState(trial, civilNow) {
  const now = parseBillingCivilDate(civilNow);
  const endDate = trial.trial_extended_end_date ?? trial.trial_end_date;
  const startDate = trial.trial_start_date;

  if (trial.trial_state === BILLING_TRIAL_STATE.CONVERTED) return BILLING_TRIAL_STATE.CONVERTED;
  if (trial.trial_state === BILLING_TRIAL_STATE.REVOKED) return BILLING_TRIAL_STATE.REVOKED;
  if (trial.trial_state === BILLING_TRIAL_STATE.EXPIRED) return BILLING_TRIAL_STATE.EXPIRED;
  if (trial.trial_state === BILLING_TRIAL_STATE.NOT_STARTED) return BILLING_TRIAL_STATE.NOT_STARTED;

  if (!startDate || !endDate || !now) return trial.trial_state;

  if (now < startDate) return BILLING_TRIAL_STATE.NOT_STARTED;
  if (now > endDate) return BILLING_TRIAL_STATE.EXPIRED;
  if (now === endDate) return BILLING_TRIAL_STATE.ENDS_TODAY;

  const daysLeft = diffBillingCivilDays(now, endDate);
  if (daysLeft != null && daysLeft <= 5) return BILLING_TRIAL_STATE.ENDING_SOON;
  return BILLING_TRIAL_STATE.ACTIVE;
}

/**
 * @param {{
 *   userId: string;
 *   cnpj?: string | null;
 *   marketplace?: string | null;
 *   marketplaceSellerId?: string | null;
 * }} input
 */
export function buildTrialFingerprint(input) {
  const parts = [
    String(input.userId),
    String(input.cnpj ?? "").replace(/\D/g, ""),
    String(input.marketplace ?? ""),
    String(input.marketplaceSellerId ?? ""),
  ];
  return parts.filter(Boolean).join(":");
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ fingerprint: string; activation_source?: string; now?: Date; idempotency_key?: string | null }} ctx
 */
export async function transitionActivateTrial(supabase, userId, ctx) {
  const overlay = await ensureSellerEntitlementOverlay(supabase, userId);
  const trial = readSellerTrialState(overlay.metadata);

  // Trial único na vida da titularidade — não reinicia por reconexão/CNPJ/plano.
  if (
    trial.trial_consumed ||
    trial.trial_started_at ||
    [
      BILLING_TRIAL_STATE.ACTIVE,
      BILLING_TRIAL_STATE.ENDING_SOON,
      BILLING_TRIAL_STATE.ENDS_TODAY,
      BILLING_TRIAL_STATE.CONVERTED,
      BILLING_TRIAL_STATE.EXPIRED,
      BILLING_TRIAL_STATE.REVOKED,
    ].includes(String(trial.trial_state))
  ) {
    return { activated: false, idempotent: true, reason: "trial_already_consumed", trial };
  }

  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const startDate = formatBillingCivilDateInSaoPaulo(now);
  const endDate = computeTrialEndDateInclusive(startDate ?? "");
  if (!startDate || !endDate) return { activated: false, reason: "dates_unresolved" };

  const startedAtIso = now.toISOString();
  const trialEndsAtIso = `${endDate}T23:59:59.999-03:00`;

  const patch = {
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_STATE]: BILLING_TRIAL_STATE.ACTIVE,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_STARTED_AT]: startedAtIso,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_START_DATE]: startDate,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_END_DATE]: endDate,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_ENDS_AT]: trialEndsAtIso,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_ORIGINAL_END_DATE]: endDate,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_ACTIVATION_SOURCE]:
      ctx.activation_source ?? BILLING_TRIAL_ACTIVATION_EVENT.FIRST_MARKETPLACE_SYNC_READY,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_FINGERPRINT]: ctx.fingerprint,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_CONSUMED]: true,
    [BILLING_TRIAL_METADATA_KEYS.OPERATIONAL_CUTOVER_AT]: startedAtIso,
    [BILLING_TRIAL_METADATA_KEYS.QUOTA_COUNTING_STARTED_AT]: null,
    // 6.9A.8 — trial ilimitado por volume; não materializar limite de franquia.
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_USAGE_LIMIT]: null,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_USAGE_COUNT]: 0,
    effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_FULL_ACCESS,
    effective_entitlement_source: BILLING_ENTITLEMENT_SOURCE.NEW_SELLER_TRIAL,
    sync_state: BILLING_SYNC_STATE.FULL,
    access_profile: "FULL_ACCESS",
  };

  const patched = await patchSellerEntitlementOverlayMetadata(supabase, overlay.overlay_id, overlay.metadata, patch, {
    idempotency_key: ctx.idempotency_key,
    source: "transition_activate_trial",
  });

  logBilling("billing", "BILLING_TRIAL_ACTIVATED", {
    user_id: userId,
    trial_start_date: startDate,
    trial_end_date: endDate,
    operational_cutover_at: startedAtIso,
    event: BILLING_TRIAL_ACTIVATION_EVENT.FIRST_MARKETPLACE_SYNC_READY,
  });
  return { activated: true, trial: readSellerTrialState(patched.metadata) };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ now?: Date; idempotency_key?: string | null }} [ctx]
 */
/**
 * @deprecated 6.9A.11 — trial NÃO migra para Baby. Use transitionExpireTrialToRestricted.
 */
export async function transitionExpireTrialToBaby(supabase, userId, ctx = {}) {
  logBilling("billing", "BILLING_TRIAL_EXPIRE_TO_BABY_BLOCKED", {
    user_id: userId,
    reason: "trial_must_not_fallback_to_baby",
  });
  return transitionExpireTrialToRestricted(supabase, userId, ctx);
}

/**
 * Expira trial → restrição TRIAL_LIFECYCLE_ENGINE (sem Baby, sem apagar dados).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ now?: Date; idempotency_key?: string | null }} [ctx]
 */
export async function transitionExpireTrialToRestricted(supabase, userId, ctx = {}) {
  const { buildTrialExpiredRestrictionPatch } = await import("./billingTrialLifecycleService.js");
  const {
    BILLING_TRIAL_TRANSITION_KIND,
    applyTrialLifecycleTransitionAtomic,
    resolveExpireVsPaidRace,
  } = await import("./billingTrialLifecycleAtomicService.js");
  const { normalizeTrialEndsAtExclusive } = await import("./billingTrialEndsAtNormalizationService.js");

  const overlay = await loadSellerEntitlementOverlay(supabase, userId);
  if (!overlay.overlay_id) return { expired: false, reason: "overlay_missing" };
  const trial = readSellerTrialState(overlay.metadata);
  const clock = normalizeTrialEndsAtExclusive({
    trial_end_date: trial.trial_end_date,
    trial_extended_end_date: trial.trial_extended_end_date,
    trial_ends_at: trial.trial_ends_at,
    trial_start_date: trial.trial_start_date,
    trial_started_at: trial.trial_started_at,
  });
  if (!clock.ok || !clock.trial_end_date) {
    return { expired: false, reason: "clock_fail_closed", error: clock.error };
  }

  const race = resolveExpireVsPaidRace({
    paid_confirmed: Boolean(ctx.paid_confirmed),
    metadata: overlay.metadata,
    intended: BILLING_TRIAL_TRANSITION_KIND.EXPIRE_RESTRICTED,
  });

  if (race.winner === "PAID_ACTIVE") {
    const paidAtomic = await applyTrialLifecycleTransitionAtomic(supabase, {
      userId,
      kind: BILLING_TRIAL_TRANSITION_KIND.RESTORE_PAID,
      trialEndCivil: clock.trial_end_date,
      paidConfirmed: true,
      correlationId: ctx.idempotency_key ?? null,
    });
    if (paidAtomic.ok) {
      logBilling("billing", "TRIAL_ACCESS_RESTORED", {
        user_id: userId,
        reason: "expire_raced_paid_wins",
        access_owner_cleared: "TRIAL_LIFECYCLE_ENGINE",
      });
      return { expired: false, paid_wins: true, atomic: paidAtomic };
    }
  }

  if (race.idempotent) {
    return { expired: false, idempotent: true };
  }

  const atomic = await applyTrialLifecycleTransitionAtomic(supabase, {
    userId,
    kind: BILLING_TRIAL_TRANSITION_KIND.EXPIRE_RESTRICTED,
    trialEndCivil: clock.trial_end_date,
    paidConfirmed: Boolean(ctx.paid_confirmed),
    correlationId: ctx.idempotency_key ?? null,
  });

  if (atomic.ok) {
    if (atomic.result?.winner === "PAID_ACTIVE") {
      return { expired: false, paid_wins: true, atomic };
    }
    logBilling("billing", "TRIAL_ACCESS_RESTRICTED", {
      user_id: userId,
      access_owner: "TRIAL_LIFECYCLE_ENGINE",
      access_reason: "TRIAL_EXPIRED",
      trial_ends_at: clock.trial_ends_at_exclusive_iso,
      atomic_idempotent: Boolean(atomic.idempotent),
    });
    return {
      expired: Boolean(atomic.claimed) || atomic.result?.winner === "TRIAL_EXPIRED_RESTRICTED",
      baby: false,
      restricted: true,
      idempotent: Boolean(atomic.idempotent),
      atomic: true,
    };
  }

  // Fallback local só quando RPC ainda não aplicada e flag não exige atomic.
  if (process.env.BILLING_TRIAL_LIFECYCLE_ATOMIC_REQUIRED === "true") {
    return { expired: false, reason: "atomic_required", error: atomic.error };
  }

  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const patch = buildTrialExpiredRestrictionPatch(overlay.metadata, now);
  await patchSellerEntitlementOverlayMetadata(supabase, overlay.overlay_id, overlay.metadata, patch, {
    idempotency_key: ctx.idempotency_key,
    source: "transition_expire_trial_to_restricted_legacy_fallback",
  });
  logBilling("billing", "TRIAL_ACCESS_RESTRICTED", {
    user_id: userId,
    access_owner: "TRIAL_LIFECYCLE_ENGINE",
    access_reason: "TRIAL_EXPIRED",
    trial_ends_at: clock.trial_ends_at_exclusive_iso,
    legacy_fallback: true,
  });
  return { expired: true, baby: false, restricted: true, legacy_fallback: true };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ plan_id: string; payment_id?: string | null; idempotency_key?: string | null; now?: Date }} ctx
 */
export async function transitionConvertTrialToPaid(supabase, userId, ctx) {
  const overlay = await loadSellerEntitlementOverlay(supabase, userId);
  if (!overlay.overlay_id) return { converted: false, reason: "overlay_missing" };
  const trial = readSellerTrialState(overlay.metadata);
  if (trial.trial_state === BILLING_TRIAL_STATE.CONVERTED && trial.quota_counting_started_at) {
    return { converted: false, idempotent: true };
  }

  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const quotaStartedAt = now.toISOString();
  const civilNow = formatBillingCivilDateInSaoPaulo(now);
  const { clearTrialLifecycleRestrictionFromMetadata } = await import("./billingTrialLifecycleService.js");
  const { normalizeTrialEndsAtExclusive } = await import("./billingTrialEndsAtNormalizationService.js");
  const {
    BILLING_TRIAL_TRANSITION_KIND,
    applyTrialLifecycleTransitionAtomic,
  } = await import("./billingTrialLifecycleAtomicService.js");

  const clock = normalizeTrialEndsAtExclusive({
    trial_end_date: trial.trial_end_date,
    trial_extended_end_date: trial.trial_extended_end_date,
    trial_ends_at: trial.trial_ends_at,
    trial_start_date: trial.trial_start_date,
    trial_started_at: trial.trial_started_at,
  });

  if (clock.ok && clock.trial_end_date) {
    const atomic = await applyTrialLifecycleTransitionAtomic(supabase, {
      userId,
      kind: BILLING_TRIAL_TRANSITION_KIND.RESTORE_PAID,
      trialEndCivil: clock.trial_end_date,
      paidConfirmed: true,
      correlationId: ctx.idempotency_key ?? null,
    });
    if (atomic.ok && atomic.result?.winner === "PAID_ACTIVE") {
      // Completa campos de conversão (plan_id / quota) via patch local idempotente.
      const reloaded = await loadSellerEntitlementOverlay(supabase, userId);
      const patch = {
        [BILLING_TRIAL_METADATA_KEYS.TRIAL_STATE]: BILLING_TRIAL_STATE.CONVERTED,
        [BILLING_TRIAL_METADATA_KEYS.TRIAL_CONVERTED_AT]: quotaStartedAt,
        [BILLING_TRIAL_METADATA_KEYS.TRIAL_SELECTED_PLAN_ID]: ctx.plan_id,
        [BILLING_TRIAL_METADATA_KEYS.TRIAL_CONSUMED]: true,
        [BILLING_TRIAL_METADATA_KEYS.QUOTA_COUNTING_STARTED_AT]:
          reloaded.metadata?.[BILLING_TRIAL_METADATA_KEYS.QUOTA_COUNTING_STARTED_AT] ?? quotaStartedAt,
        trial_converted_payment_id: ctx.payment_id ?? null,
        usage_billed_count: 0,
        usage_limit_cycle_key: civilNow,
      };
      if (reloaded.overlay_id) {
        await patchSellerEntitlementOverlayMetadata(
          supabase,
          reloaded.overlay_id,
          reloaded.metadata,
          patch,
          { idempotency_key: ctx.idempotency_key, source: "transition_convert_trial_to_paid_atomic" },
        );
      }
      logBilling("billing", "TRIAL_ACCESS_RESTORED", {
        user_id: userId,
        plan_id: ctx.plan_id,
        access_owner_cleared: "TRIAL_LIFECYCLE_ENGINE",
        atomic: true,
      });
      return { converted: true, quota_counting_started_at: quotaStartedAt, usage_count: 0, atomic: true };
    }
    if (process.env.BILLING_TRIAL_LIFECYCLE_ATOMIC_REQUIRED === "true" && !atomic.ok) {
      return { converted: false, reason: "atomic_required", error: atomic.error };
    }
  }

  const cleared = clearTrialLifecycleRestrictionFromMetadata(overlay.metadata);
  const patch = {
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_STATE]: BILLING_TRIAL_STATE.CONVERTED,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_CONVERTED_AT]: quotaStartedAt,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_SELECTED_PLAN_ID]: ctx.plan_id,
    [BILLING_TRIAL_METADATA_KEYS.TRIAL_CONSUMED]: true,
    [BILLING_TRIAL_METADATA_KEYS.QUOTA_COUNTING_STARTED_AT]: quotaStartedAt,
    trial_converted_payment_id: ctx.payment_id ?? null,
    suspension_fallback_active: false,
    usage_billed_count: 0,
    usage_limit_cycle_key: civilNow,
    sync_state: BILLING_SYNC_STATE.FULL,
    access_profile: "FULL_ACCESS",
    effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN,
    effective_entitlement_source: BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE,
  };

  const baseMeta = cleared.cleared ? cleared.metadata : overlay.metadata;
  await patchSellerEntitlementOverlayMetadata(supabase, overlay.overlay_id, baseMeta, patch, {
    idempotency_key: ctx.idempotency_key,
    source: "transition_convert_trial_to_paid",
  });

  logBilling("billing", "TRIAL_ACCESS_RESTORED", {
    user_id: userId,
    plan_id: ctx.plan_id,
    access_owner_cleared: cleared.cleared ? "TRIAL_LIFECYCLE_ENGINE" : null,
    quota_counting_started_at: quotaStartedAt,
  });
  logBilling("billing", "BILLING_TRIAL_CONVERTED_TO_PAID", {
    user_id: userId,
    plan_id: ctx.plan_id,
    quota_counting_started_at: quotaStartedAt,
  });

  return { converted: true, quota_counting_started_at: quotaStartedAt, usage_count: 0 };
}

/**
 * @param {ReturnType<typeof readSellerTrialState>} trial
 * @param {string | null} civilNow
 */
export function buildTrialEntitlementDto(trial, civilNow) {
  const temporal = resolveTrialTemporalState(trial, civilNow);
  const active =
    temporal === BILLING_TRIAL_STATE.ACTIVE ||
    temporal === BILLING_TRIAL_STATE.ENDING_SOON ||
    temporal === BILLING_TRIAL_STATE.ENDS_TODAY;

  if (!active && temporal !== BILLING_TRIAL_STATE.EXPIRED) {
    return null;
  }

  if (temporal === BILLING_TRIAL_STATE.EXPIRED) {
    return {
      effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED,
      effective_entitlement_source: BILLING_ENTITLEMENT_SOURCE.TRIAL_LIFECYCLE_EXPIRATION,
      billing_financial_state: BILLING_FINANCIAL_STATE_NOT_APPLICABLE,
      trial_state: temporal,
      access_state: BILLING_ACCESS_STATE.DETAILED_ACCESS_RESTRICTED,
      sync_state: BILLING_SYNC_STATE.FULL,
      access_profile: "EXECUTIVE_ONLY",
      access_restriction_reason: "TRIAL_EXPIRED",
      access_owner: "TRIAL_LIFECYCLE_ENGINE",
      baby_fallback: false,
    };
  }

  return {
    effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_FULL_ACCESS,
    effective_entitlement_source: BILLING_ENTITLEMENT_SOURCE.NEW_SELLER_TRIAL,
    billing_financial_state: BILLING_FINANCIAL_STATE_NOT_APPLICABLE,
    trial_state: temporal,
    access_state: BILLING_ACCESS_STATE.LIBERATED,
    sync_state: BILLING_SYNC_STATE.FULL,
    access_profile: "FULL_ACCESS",
    trial_start_date: trial.trial_start_date,
    trial_end_date: trial.trial_end_date,
    trial_ends_at: trial.trial_ends_at,
    operational_cutover_at: trial.operational_cutover_at,
    quota_counting_started_at: null,
    // 6.9A.8 — trial ilimitado por volume; métricas observáveis via sales_orders.
    trial_usage_limit: null,
    trial_usage_count: null,
    usage_limit: null,
  };
}

/**
 * Ponte opcional — FIRST_MARKETPLACE_SYNC_READY (não ativa em produção por flag).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ fingerprint: string; enabled?: boolean }} ctx
 */
export async function maybeActivateTrialOnFirstMarketplaceSyncReady(supabase, userId, ctx) {
  if (process.env.BILLING_TRIAL_ACTIVATION_ENABLED !== "true" && ctx.enabled !== true) {
    return { activated: false, reason: "trial_activation_disabled" };
  }
  return transitionActivateTrial(supabase, userId, {
    fingerprint: ctx.fingerprint,
    activation_source: BILLING_TRIAL_ACTIVATION_EVENT.FIRST_MARKETPLACE_SYNC_READY,
  });
}
