// ======================================================================
// Preflight de franquia — sem criar admission (S1.HF.6.9A.10)
// A) antes do GET  B) após date_created oficial
// ======================================================================

import { BILLING_EFFECTIVE_ENTITLEMENT, BILLING_SALE_PERIOD_CLASS } from "../billingConstants.js";
import { resolveBillingAccessEntitlementSnapshot } from "./billingSubscriptionEntitlementService.js";
import { loadSellerEntitlementOverlay } from "./billingSellerEntitlementStoreService.js";
import {
  classifySalePeriodForQuota,
  normalizeBillingSnapshotOrigin,
  resolveOfficialOrderAt,
  shouldBypassAtomicQuotaReservation,
} from "./billingQuotaEligibilityService.js";
import { evaluateBillableSaleBeforeProcessingAtomic } from "./billingBillableSaleAdmissionService.js";
import { loadCanonicalBillableSubscriptionContext } from "./billingCanonicalSubscriptionService.js";
import { resolveCanonicalAccessPrecedence } from "./billingAccessPrecedenceService.js";

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{ now?: Date; snapshot_origin?: string | null }} [options]
 */
export async function preflightBillableSaleEntitlementState(supabase, userId, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const snapshotOrigin = normalizeBillingSnapshotOrigin(options.snapshot_origin);
  const overlay = await loadSellerEntitlementOverlay(supabase, userId);
  const precedence = resolveCanonicalAccessPrecedence(overlay.metadata);

  if (!precedence.allow_process_sale) {
    return {
      proceed: false,
      reserve_after_official_date: false,
      reason: precedence.reason,
      domain_code: precedence.domain_code ?? null,
      precedence_rank: precedence.precedence_rank,
      preflight: true,
      webhook_ok: true,
      snapshot_origin: snapshotOrigin,
      ml_api_calls: 0,
    };
  }

  const trialBypass = shouldBypassAtomicQuotaReservation(overlay.metadata, now);
  if (trialBypass.bypass && precedence.allow_quota_bypass_trial) {
    return {
      proceed: true,
      reserve_after_official_date: false,
      reason: "trial_unlimited",
      trial_state: trialBypass.trial_state,
      quota_bypassed: true,
      period_class: BILLING_SALE_PERIOD_CLASS.TRIAL_OBSERVADO,
      preflight: true,
      snapshot_origin: snapshotOrigin,
    };
  }

  const snapshot = await resolveBillingAccessEntitlementSnapshot(supabase, userId, { now });
  if (
    snapshot.effective_entitlement === BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_FULL_ACCESS &&
    precedence.allow_quota_bypass_trial
  ) {
    return {
      proceed: true,
      reserve_after_official_date: false,
      reason: "trial_unlimited",
      quota_bypassed: true,
      period_class: BILLING_SALE_PERIOD_CLASS.TRIAL_OBSERVADO,
      preflight: true,
      snapshot_origin: snapshotOrigin,
    };
  }

  const isBaby = snapshot.effective_entitlement === BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE;
  if (isBaby) {
    return {
      proceed: true,
      reserve_after_official_date: true,
      reason: "awaiting_official_order_date",
      preflight: true,
      snapshot_origin: snapshotOrigin,
    };
  }

  return {
    proceed: true,
    reserve_after_official_date: false,
    reason: "non_baby_no_atomic_reserve",
    preflight: true,
    snapshot_origin: snapshotOrigin,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   external_order_id: string;
 *   marketplace: string;
 *   marketplace_account_id: string;
 *   date_created_marketplace?: unknown;
 *   official_order_at?: unknown;
 *   snapshot_origin?: string | null;
 *   reservation_owner_token?: string | null;
 *   now?: Date;
 * }} input
 */
export async function reserveBillableSaleAfterOfficialDate(supabase, userId, input) {
  const now = input.now instanceof Date ? input.now : new Date();
  const snapshotOrigin = normalizeBillingSnapshotOrigin(input.snapshot_origin);
  const overlay = await loadSellerEntitlementOverlay(supabase, userId);
  const { canonicalSubscription } = await loadCanonicalBillableSubscriptionContext(supabase, userId);
  const canonMeta =
    canonicalSubscription?.metadata && typeof canonicalSubscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (canonicalSubscription.metadata)
      : {};
  const mergedMeta = { ...canonMeta, ...overlay.metadata };

  const precedence = resolveCanonicalAccessPrecedence(mergedMeta);
  if (!precedence.allow_process_sale) {
    return {
      admit: false,
      process_sale: false,
      reason: precedence.reason,
      domain_code: precedence.domain_code ?? null,
      precedence_rank: precedence.precedence_rank,
      atomic: false,
      webhook_ok: true,
      snapshot_origin: snapshotOrigin,
    };
  }

  const official = resolveOfficialOrderAt({
    date_created_marketplace: input.date_created_marketplace,
    official_order_at: input.official_order_at,
  });

  const classified = classifySalePeriodForQuota({
    metadata: mergedMeta,
    official_order_at: official,
    snapshot_origin: snapshotOrigin,
    now,
  });

  if (classified.manual_review_required || classified.class === BILLING_SALE_PERIOD_CLASS.MANUAL_REVIEW) {
    if (classified.reason === "official_order_at_missing") {
      return {
        admit: false,
        process_sale: false,
        reason: "manual_review_required",
        period_class: classified.class,
        official_order_at: null,
        snapshot_origin: snapshotOrigin,
        atomic: false,
        quota_bypassed: false,
        webhook_ok: true,
        schedule_reconciliation: true,
        manual_review_required: true,
      };
    }
    return {
      admit: false,
      process_sale: false,
      reason: "manual_review_required",
      period_class: classified.class,
      classification_reason: classified.reason,
      official_order_at: classified.official_order_at ?? null,
      snapshot_origin: snapshotOrigin,
      atomic: false,
      quota_bypassed: false,
      webhook_ok: true,
      manual_review_required: true,
    };
  }

  if (!classified.quota_eligible) {
    const trialBypass = shouldBypassAtomicQuotaReservation(mergedMeta, now);
    if (trialBypass.bypass && !precedence.allow_quota_bypass_trial) {
      return {
        admit: false,
        process_sale: false,
        reason: precedence.reason,
        atomic: false,
        webhook_ok: true,
        snapshot_origin: snapshotOrigin,
      };
    }
    return {
      admit: true,
      process_sale: true,
      reason: classified.reason,
      period_class: classified.class,
      official_order_at: classified.official_order_at ?? official?.toISOString() ?? null,
      snapshot_origin: snapshotOrigin,
      atomic: false,
      quota_bypassed: true,
    };
  }

  if (!input.marketplace || !input.marketplace_account_id || !input.external_order_id) {
    return {
      admit: false,
      process_sale: false,
      reason: "incomplete_marketplace_identity",
      atomic: false,
      snapshot_origin: snapshotOrigin,
    };
  }

  return evaluateBillableSaleBeforeProcessingAtomic(supabase, userId, {
    external_order_id: input.external_order_id,
    marketplace: input.marketplace,
    marketplace_account_id: input.marketplace_account_id,
    reservation_owner_token: input.reservation_owner_token ?? undefined,
    official_order_at: official,
    snapshot_origin: snapshotOrigin,
    is_new_sale: true,
    now,
  });
}
