// ======================================================================
// Contrato × entitlement efetivo — DTO canônico (S1.HF.6.6 + 6.7 read-only)
// ======================================================================

import {
  BILLING_ACCESS_PROFILE,
  BILLING_ACCESS_RESTRICTION_REASON,
  BILLING_ACCESS_STATE,
  BILLING_BACKFILL_STATUS,
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_ENTITLEMENT_SOURCE,
  BILLING_FINANCIAL_STATE,
  BILLING_LIMIT_RESTRICTED_ALLOWED_PATH_PREFIXES,
  BILLING_LIMIT_RESTRICTED_BLOCKED_PATH_PREFIXES,
  BILLING_SUBSCRIPTION_LIFECYCLE_STATUS,
  BILLING_SYNC_METADATA_KEYS,
  BILLING_SYNC_STATE,
  BILLING_TRIAL_LIFECYCLE_STATE,
  BILLING_TRIAL_STATE,
  BILLING_USAGE_STATE,
} from "../billingConstants.js";
import { resolveBillingAccessContext, resolveBillingAccessProfile } from "./billingAccessProfileService.js";
import { formatBillingCivilDateInSaoPaulo } from "./billingCycleService.js";
import { countSellerEcosystemSalesUsage } from "./subscriptionUsageMeter.js";
import {
  readSuspensionFallbackEntitlement,
  rollForwardSuspensionFallbackPeriodIfNeeded,
} from "./billingSuspensionFallbackEntitlementService.js";
import {
  readUsageLimitStateFromMetadata,
  resolveUsageLimitStateMachine,
} from "./billingUsageLimitStateService.js";
import { resolveBabyHardLimitState } from "./billingBabyHardLimitService.js";
import { readSyncPauseAuditFromMetadata } from "./billingSyncPauseAuditService.js";
import { resolveBillingEntitlementCapabilities } from "./billingEntitlementCapabilitiesService.js";
import {
  buildTrialEntitlementDto,
  readSellerTrialState,
  resolveTrialTemporalState,
} from "./billingSellerTrialService.js";
import {
  resolveTrialLifecyclePresentation,
  resolveTrialLifecycleState,
} from "./billingTrialLifecycleService.js";
import { loadSellerEntitlementOverlay } from "./billingSellerEntitlementStoreService.js";
import { loadCanonicalBillableSubscriptionContext } from "./billingCanonicalSubscriptionService.js";
import { resolveBillingSubscriptionFinancialState } from "./billingSubscriptionFinancialStateService.js";
import { findOpenRenewalCycleForSubscription } from "./billingRenewalCycleRepository.js";
import { resolveMonthlySalesUsage } from "./billingUsageService.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} subscription
 */
function resolveContractedPlanKey(subscription) {
  return asTrimmedString(subscription?.plan_key) ?? asTrimmedString(subscription?.plan_id);
}

/**
 * @param {Record<string, unknown> | null | undefined} subscription
 * @param {string | null | undefined} financialState
 */
function resolveContractedSubscriptionState(subscription, financialState) {
  if (financialState === BILLING_FINANCIAL_STATE.SUSPENDED) return "SUSPENDED";
  if (financialState === BILLING_FINANCIAL_STATE.GRACE_PERIOD) return "GRACE";
  const status = String(subscription?.status ?? "").toLowerCase();
  if (status === "past_due") return "PAST_DUE";
  if (status === "active") return "ACTIVE";
  return status ? status.toUpperCase() : null;
}

/**
 * @param {{
 *   usage_state: string;
 *   billing_financial_state: string | null;
 *   fallback_active: boolean;
 *   is_baby: boolean;
 *   sync_state: string | null;
 * }} input
 */
export function resolveOperationalAccessState(input) {
  if (input.usage_state === BILLING_USAGE_STATE.HARD_LIMIT_REACHED && input.is_baby) {
    return {
      access_state: BILLING_ACCESS_STATE.ARCHIVE_READ_ONLY,
      access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
      operational_blocked: false,
      sync_state: BILLING_SYNC_STATE.HARD_PAUSED,
      access_restrictions: {
        operational_blocked: false,
        sync_paused: true,
        archive_read_only: true,
        allowed_path_prefixes: BILLING_LIMIT_RESTRICTED_ALLOWED_PATH_PREFIXES,
        blocked_path_prefixes: [],
        reason: "baby_hard_limit_archive",
      },
    };
  }

  if (input.sync_state === BILLING_SYNC_STATE.HARD_PAUSED && input.is_baby) {
    return {
      access_state: BILLING_ACCESS_STATE.ARCHIVE_READ_ONLY,
      access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
      operational_blocked: false,
      sync_state: BILLING_SYNC_STATE.HARD_PAUSED,
      access_restrictions: {
        operational_blocked: false,
        sync_paused: true,
        archive_read_only: true,
        allowed_path_prefixes: BILLING_LIMIT_RESTRICTED_ALLOWED_PATH_PREFIXES,
        blocked_path_prefixes: [],
        reason: "baby_sync_hard_paused",
      },
    };
  }

  if (input.usage_state === BILLING_USAGE_STATE.LIMIT_RESTRICTED && !input.is_baby) {
    return {
      access_state: BILLING_ACCESS_STATE.DETAILED_ACCESS_RESTRICTED,
      access_profile: BILLING_ACCESS_PROFILE.EXECUTIVE_ONLY,
      operational_blocked: false,
      sync_state: BILLING_SYNC_STATE.FULL,
      access_restrictions: {
        operational_blocked: false,
        detailed_restricted: true,
        allowed_path_prefixes: BILLING_LIMIT_RESTRICTED_ALLOWED_PATH_PREFIXES,
        blocked_path_prefixes: BILLING_LIMIT_RESTRICTED_BLOCKED_PATH_PREFIXES,
        reason: "paid_plan_usage_limit_restricted",
      },
    };
  }

  if (input.usage_state === BILLING_USAGE_STATE.LIMIT_RESTRICTED && input.is_baby) {
    return {
      access_state: BILLING_ACCESS_STATE.ARCHIVE_READ_ONLY,
      access_profile: BILLING_ACCESS_PROFILE.ARCHIVE_READ_ONLY,
      operational_blocked: false,
      sync_state: BILLING_SYNC_STATE.HARD_PAUSED,
      access_restrictions: {
        operational_blocked: false,
        sync_paused: true,
        archive_read_only: true,
        reason: "baby_usage_restricted_legacy",
      },
    };
  }

  if (input.billing_financial_state === BILLING_FINANCIAL_STATE.SUSPENDED && input.fallback_active) {
    return {
      access_state: BILLING_ACCESS_STATE.LIBERATED,
      access_profile: BILLING_ACCESS_PROFILE.FULL_ACCESS,
      operational_blocked: false,
      sync_state: BILLING_SYNC_STATE.FULL,
      access_restrictions: {
        operational_blocked: false,
        allowed_path_prefixes: [],
        blocked_path_prefixes: [],
        reason: "suspension_fallback_baby",
      },
    };
  }

  if (input.billing_financial_state === BILLING_FINANCIAL_STATE.SUSPENDED) {
    return {
      access_state: BILLING_ACCESS_STATE.BLOCKED,
      access_profile: BILLING_ACCESS_PROFILE.FINANCIAL_RECOVERY_ONLY,
      access_restriction_reason: BILLING_ACCESS_RESTRICTION_REASON.FINANCIAL_STATE_WITHOUT_FALLBACK,
      operational_blocked: true,
      sync_state: BILLING_SYNC_STATE.HARD_PAUSED,
      access_restrictions: {
        operational_blocked: true,
        sync_paused: true,
        allowed_path_prefixes: BILLING_LIMIT_RESTRICTED_ALLOWED_PATH_PREFIXES,
        blocked_path_prefixes: BILLING_LIMIT_RESTRICTED_BLOCKED_PATH_PREFIXES,
        reason: "financial_suspended",
      },
    };
  }

  if (input.usage_state === BILLING_USAGE_STATE.LIMIT_REACHED_GRACE) {
    return {
      access_state: BILLING_ACCESS_STATE.LIBERATED,
      access_profile: BILLING_ACCESS_PROFILE.FULL_ACCESS,
      operational_blocked: false,
      sync_state: BILLING_SYNC_STATE.FULL,
      access_restrictions: {
        operational_blocked: false,
        allowed_path_prefixes: [],
        blocked_path_prefixes: [],
        reason: "usage_limit_grace",
      },
    };
  }

  return {
    access_state: BILLING_ACCESS_STATE.LIBERATED,
    access_profile: BILLING_ACCESS_PROFILE.FULL_ACCESS,
    operational_blocked: false,
    sync_state: BILLING_SYNC_STATE.FULL,
    access_restrictions: {
      operational_blocked: false,
      allowed_path_prefixes: [],
      blocked_path_prefixes: [],
      reason: null,
    },
  };
}

/**
 * Snapshot read-only — nunca persiste metadata (S1.HF.6.7).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   subscription?: Record<string, unknown> | null;
 *   financialState?: Record<string, unknown> | null;
 *   usageLimit?: number | null;
 *   cycleKey?: string | null;
 *   periodStart?: string | null;
 *   periodEnd?: string | null;
 *   now?: Date;
 * }} ctx
 */
export async function resolveBillingSubscriptionEntitlementSnapshot(supabase, ctx) {
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const civilNow = formatBillingCivilDateInSaoPaulo(now);

  let subscription = ctx.subscription;
  if (!subscription?.id) {
    const { canonicalSubscription } = await loadCanonicalBillableSubscriptionContext(supabase, ctx.userId);
    subscription = canonicalSubscription ?? {};
  }

  const meta =
    subscription.metadata && typeof subscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (subscription.metadata)
      : {};

  let financialState = ctx.financialState;
  if (!financialState && subscription?.id) {
    const openCycle = await findOpenRenewalCycleForSubscription(supabase, String(subscription.id), {
      userId: ctx.userId,
      reason: "entitlement_snapshot",
    });
    financialState = resolveBillingSubscriptionFinancialState({
      subscription,
      openCycle,
      civilNow,
      now,
    });
  }

  const billingFinancialState = asTrimmedString(financialState?.billing_financial_state);
  const syncAudit = readSyncPauseAuditFromMetadata(meta);
  const overlay = await loadSellerEntitlementOverlay(supabase, ctx.userId);
  const trialRaw = readSellerTrialState(overlay.metadata);
  const trialTemporal = resolveTrialTemporalState(trialRaw, civilNow);
  const trialDto = buildTrialEntitlementDto(trialRaw, civilNow);
  const canonicalPaid =
    Boolean(subscription?.id) &&
    String(subscription?.status ?? "").toLowerCase() === "active" &&
    String(billingFinancialState ?? "") !== BILLING_FINANCIAL_STATE.SUSPENDED;
  const lifecycle = resolveTrialLifecycleState({
    metadata: overlay.metadata,
    now,
    paid_confirmed: canonicalPaid,
    canonical_subscription_active: canonicalPaid,
  });
  const lifecyclePresentation = resolveTrialLifecyclePresentation(lifecycle.warning_key);

  if (
    !canonicalPaid &&
    (lifecycle.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED ||
      trialDto?.effective_entitlement === BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED)
  ) {
    const accessCtx = resolveBillingAccessContext({
      ...(trialDto ?? {}),
      access_restriction_reason: "TRIAL_EXPIRED",
      access_owner: "TRIAL_LIFECYCLE_ENGINE",
      effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED,
      trial_state: BILLING_TRIAL_STATE.EXPIRED,
    });
    const dto = {
      contracted_plan_key: null,
      contracted_subscription_state: null,
      subscription_lifecycle_status: BILLING_SUBSCRIPTION_LIFECYCLE_STATUS.ACTIVE,
      billing_financial_state: trialDto?.billing_financial_state ?? null,
      effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED,
      effective_entitlement_source: BILLING_ENTITLEMENT_SOURCE.TRIAL_LIFECYCLE_EXPIRATION,
      effective_plan_key: "trial_expired_restricted",
      effective_plan_label: "Teste gratuito encerrado",
      trial_state: BILLING_TRIAL_STATE.EXPIRED,
      trial_lifecycle_state: BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED,
      trial_days_remaining: 0,
      trial_warning_key: "TRIAL_EXPIRED",
      trial_presentation: resolveTrialLifecyclePresentation("TRIAL_EXPIRED"),
      trial_start_date: trialRaw.trial_start_date,
      trial_end_date: trialRaw.trial_end_date,
      trial_ends_at: lifecycle.trial_ends_at_exclusive ?? trialRaw.trial_ends_at,
      trial_ends_at_exclusive: lifecycle.trial_ends_at_exclusive ?? null,
      trial_usage_limit: null,
      trial_usage_count: null,
      quota_counting_started_at: null,
      usage_state: BILLING_USAGE_STATE.WITHIN_LIMIT,
      usage_count: 0,
      usage_limit: null,
      sync_state: BILLING_SYNC_STATE.FULL,
      access_state: BILLING_ACCESS_STATE.DETAILED_ACCESS_RESTRICTED,
      access_profile: accessCtx.access_profile,
      access_restriction_reason: BILLING_ACCESS_RESTRICTION_REASON.TRIAL_EXPIRED,
      access_owner: "TRIAL_LIFECYCLE_ENGINE",
      operational_blocked: false,
      access_restrictions: [],
      data_gap: null,
      last_data_updated_at: syncAudit.last_data_updated_at,
      suspension_fallback_active: false,
      baby_fallback: false,
    };
    return { ...dto, capabilities: resolveBillingEntitlementCapabilities(dto) };
  }

  if (
    trialDto &&
    trialDto.effective_entitlement === BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_FULL_ACCESS &&
    !billingFinancialState &&
    lifecycle.lifecycle_state !== BILLING_TRIAL_LIFECYCLE_STATE.PAID_ACTIVE &&
    lifecycle.lifecycle_state !== BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED
  ) {
    const operational = resolveOperationalAccessState({
      usage_state: BILLING_USAGE_STATE.WITHIN_LIMIT,
      billing_financial_state: null,
      fallback_active: false,
      is_baby: false,
      sync_state: BILLING_SYNC_STATE.FULL,
    });
    const dto = {
      contracted_plan_key: null,
      contracted_subscription_state: null,
      subscription_lifecycle_status: BILLING_SUBSCRIPTION_LIFECYCLE_STATUS.ACTIVE,
      billing_financial_state: trialDto.billing_financial_state,
      effective_entitlement: trialDto.effective_entitlement,
      effective_entitlement_source: trialDto.effective_entitlement_source,
      effective_plan_key: "trial_full_access",
      effective_plan_label: "Teste gratuito da SUSE7 — 15 dias grátis, sem cartão",
      trial_state: lifecycle.trial_state_compat ?? trialTemporal,
      trial_lifecycle_state: lifecycle.lifecycle_state,
      trial_days_remaining: lifecycle.trial_days_remaining,
      trial_warning_key: lifecycle.warning_key,
      trial_presentation: lifecyclePresentation,
      trial_start_date: lifecycle.trial_start_date ?? trialDto.trial_start_date,
      trial_end_date: lifecycle.trial_end_date ?? trialDto.trial_end_date,
      trial_usage_limit: null,
      trial_usage_count: null,
      trial_ends_at: lifecycle.trial_ends_at_exclusive ?? trialDto.trial_ends_at ?? null,
      trial_ends_at_exclusive: lifecycle.trial_ends_at_exclusive ?? null,
      operational_cutover_at: trialDto.operational_cutover_at ?? null,
      quota_counting_started_at: null,
      usage_state: BILLING_USAGE_STATE.WITHIN_LIMIT,
      usage_count: 0,
      usage_limit: null,
      sync_state: operational.sync_state,
      access_state: operational.access_state,
      access_profile: lifecycle.access_profile ?? operational.access_profile,
      access_restriction_reason: lifecycle.access_reason,
      access_owner: lifecycle.access_owner,
      operational_blocked: operational.operational_blocked,
      access_restrictions: operational.access_restrictions,
      data_gap: null,
      last_data_updated_at: syncAudit.last_data_updated_at,
      suspension_fallback_active: false,
    };
    return { ...dto, capabilities: resolveBillingEntitlementCapabilities(dto) };
  }

  let fallback = readSuspensionFallbackEntitlement(meta);
  const rolled = rollForwardSuspensionFallbackPeriodIfNeeded(fallback, civilNow);
  fallback = rolled.fallback;

  const contractedPlanKey = resolveContractedPlanKey(subscription);
  const contractedSubscriptionState = resolveContractedSubscriptionState(subscription, billingFinancialState);

  let effectiveEntitlement = BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN;
  let effectiveEntitlementSource = BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE;
  let effectivePlanKey = contractedPlanKey;
  let usageLimit = ctx.usageLimit ?? null;
  let periodStart = ctx.periodStart ?? null;
  let periodEnd = ctx.periodEnd ?? null;
  let cycleKey = ctx.cycleKey ?? periodStart ?? civilNow;
  let isBaby = false;

  if (fallback.active && billingFinancialState === BILLING_FINANCIAL_STATE.SUSPENDED) {
    effectiveEntitlement = BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE;
    effectiveEntitlementSource = BILLING_ENTITLEMENT_SOURCE.SUSPENSION_FALLBACK;
    effectivePlanKey = fallback.effective_plan_key;
    usageLimit = fallback.usage_limit;
    periodStart = fallback.fallback_period_start;
    periodEnd = fallback.fallback_period_end;
    cycleKey = fallback.fallback_period_start ?? cycleKey;
    isBaby = true;
  }

  let usageCount = 0;
  if (periodStart && periodEnd) {
    usageCount = await countSellerEcosystemSalesUsage(supabase, ctx.userId, {
      period_start: periodStart,
      period_end: periodEnd,
    });
  }

  let usageMachine;
  if (isBaby) {
    const baby = resolveBabyHardLimitState({
      usageCount,
      usageLimit,
      persistedUsageState: readUsageLimitStateFromMetadata(meta).usage_state,
      syncState: syncAudit.sync_state,
    });
    usageMachine = {
      usage_state: baby.usage_state,
      usage_count: baby.usage_count,
      usage_limit: baby.usage_limit,
      limit_reached_at: baby.usage_state === BILLING_USAGE_STATE.HARD_LIMIT_REACHED ? civilNow : null,
      usage_grace_end: null,
      grace_consumed_in_cycle: false,
      cycle_key: String(cycleKey ?? ""),
    };
  } else {
    usageMachine = resolveUsageLimitStateMachine({
      usageCount,
      usageLimit,
      civilNow: civilNow ?? "",
      cycleKey: String(cycleKey ?? ""),
      persisted: readUsageLimitStateFromMetadata(meta),
    });
  }

  const operational = resolveOperationalAccessState({
    usage_state: usageMachine.usage_state,
    billing_financial_state: billingFinancialState,
    fallback_active: fallback.active && billingFinancialState === BILLING_FINANCIAL_STATE.SUSPENDED,
    is_baby: isBaby,
    sync_state: syncAudit.sync_state ?? operationalSyncFromUsage(usageMachine.usage_state, syncAudit.sync_state),
  });

  const dto = {
    contracted_plan_key: contractedPlanKey,
    contracted_plan_name: contractedPlanKey,
    contracted_subscription_state: contractedSubscriptionState,
    subscription_lifecycle_status:
      billingFinancialState === BILLING_FINANCIAL_STATE.SUSPENDED
        ? BILLING_SUBSCRIPTION_LIFECYCLE_STATUS.SUSPENDED
        : BILLING_SUBSCRIPTION_LIFECYCLE_STATUS.ACTIVE,
    billing_financial_state: billingFinancialState,
    effective_entitlement: effectiveEntitlement,
    effective_entitlement_source: effectiveEntitlementSource,
    effective_plan_key: effectivePlanKey,
    effective_plan_label:
      effectiveEntitlement === BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE
        ? "Baby gratuito"
        : contractedPlanKey,
    usage_state: usageMachine.usage_state,
    usage_count: usageMachine.usage_count,
    usage_limit: usageMachine.usage_limit,
    limit_reached_at: usageMachine.limit_reached_at,
    usage_grace_end: usageMachine.usage_grace_end,
    fallback_period_start: fallback.fallback_period_start,
    fallback_period_end: fallback.fallback_period_end,
    fallback_next_reset: fallback.fallback_next_reset,
    sync_state: operational.sync_state ?? syncAudit.sync_state ?? BILLING_SYNC_STATE.FULL,
    access_state: operational.access_state,
    access_profile: operational.access_profile,
    access_restriction_reason: operational.access_restriction_reason ?? null,
    operational_blocked: operational.operational_blocked,
    access_restrictions: operational.access_restrictions,
    suspension_fallback_active: fallback.active,
    is_baby: isBaby,
    previous_contracted_plan_key: fallback.contracted_plan_key ?? contractedPlanKey,
    trial_state: trialTemporal,
    last_data_updated_at: syncAudit.last_data_updated_at,
    data_gap:
      syncAudit.data_gap_start || syncAudit.data_gap_end
        ? {
            data_gap_start: syncAudit.data_gap_start,
            data_gap_end: syncAudit.data_gap_end,
            ignored_event_count: syncAudit.ignored_event_count,
            backfill_status: syncAudit.backfill_status ?? BILLING_BACKFILL_STATUS.NOT_REQUESTED,
          }
        : null,
  };

  const accessContext = resolveBillingAccessContext(dto);
  dto.sync_state = accessContext.sync_state;
  dto.access_profile = accessContext.access_profile;
  dto.access_restriction_reason = accessContext.access_restriction_reason;

  return { ...dto, capabilities: resolveBillingEntitlementCapabilities(dto) };
}

/**
 * @param {string | null | undefined} usageState
 * @param {string | null | undefined} persistedSync
 */
function operationalSyncFromUsage(usageState, persistedSync) {
  if (persistedSync === BILLING_SYNC_STATE.HARD_PAUSED) return BILLING_SYNC_STATE.HARD_PAUSED;
  if (usageState === BILLING_USAGE_STATE.HARD_LIMIT_REACHED) return BILLING_SYNC_STATE.HARD_PAUSED;
  return BILLING_SYNC_STATE.FULL;
}

/**
 * Compat — GETs usam snapshot read-only (persist ignorado).
 */
export async function resolveBillingSubscriptionEntitlement(supabase, ctx) {
  return resolveBillingSubscriptionEntitlementSnapshot(supabase, ctx);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ now?: Date }} [options]
 */
export async function resolveBillingAccessEntitlementSnapshot(supabase, userId, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const { canonicalSubscription } = await loadCanonicalBillableSubscriptionContext(supabase, userId);
  let usageResolution = null;
  try {
    usageResolution = await resolveMonthlySalesUsage(
      supabase,
      userId,
      canonicalSubscription?.plan_id != null ? String(canonicalSubscription.plan_id) : null
    );
  } catch {
    usageResolution = null;
  }

  return resolveBillingSubscriptionEntitlementSnapshot(supabase, {
    userId,
    subscription: canonicalSubscription ?? {},
    usageLimit: usageResolution?.monthly_sales_limit ?? null,
    cycleKey: usageResolution?.period_start ?? null,
    periodStart: usageResolution?.period_start ?? null,
    periodEnd: usageResolution?.period_end ?? null,
    now,
  });
}

/**
 * @param {Record<string, unknown> | null | undefined} raw
 */
export function normalizeBillingSubscriptionEntitlementDto(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    contracted_plan_key: raw.contracted_plan_key != null ? String(raw.contracted_plan_key) : null,
    contracted_plan_name: raw.contracted_plan_name != null ? String(raw.contracted_plan_name) : null,
    contracted_subscription_state:
      raw.contracted_subscription_state != null ? String(raw.contracted_subscription_state) : null,
    subscription_lifecycle_status:
      raw.subscription_lifecycle_status != null ? String(raw.subscription_lifecycle_status) : null,
    billing_financial_state: raw.billing_financial_state != null ? String(raw.billing_financial_state) : null,
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
    sync_state: raw.sync_state != null ? String(raw.sync_state) : null,
    access_state: raw.access_state != null ? String(raw.access_state) : null,
    access_profile: raw.access_profile != null ? String(raw.access_profile) : null,
    access_restriction_reason:
      raw.access_restriction_reason != null ? String(raw.access_restriction_reason) : null,
    operational_blocked: Boolean(raw.operational_blocked),
    access_restrictions: raw.access_restrictions ?? null,
    capabilities: raw.capabilities ?? null,
    suspension_fallback_active: Boolean(raw.suspension_fallback_active),
    previous_contracted_plan_key:
      raw.previous_contracted_plan_key != null ? String(raw.previous_contracted_plan_key) : null,
    trial_state: raw.trial_state != null ? String(raw.trial_state) : null,
    trial_start_date: raw.trial_start_date != null ? String(raw.trial_start_date).slice(0, 10) : null,
    trial_end_date: raw.trial_end_date != null ? String(raw.trial_end_date).slice(0, 10) : null,
    trial_usage_limit: raw.trial_usage_limit != null ? Number(raw.trial_usage_limit) : null,
    trial_usage_count: raw.trial_usage_count != null ? Number(raw.trial_usage_count) : null,
    last_data_updated_at:
      raw.last_data_updated_at != null ? String(raw.last_data_updated_at).slice(0, 10) : null,
    data_gap: raw.data_gap ?? null,
  };
}
