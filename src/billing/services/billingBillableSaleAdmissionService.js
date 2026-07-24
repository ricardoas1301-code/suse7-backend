// ======================================================================
// Admissão atômica Baby — RPC Postgres V2 (S1.HF.6.9A.5)
// RESERVE → persist mínima → FINALIZE | RELEASE + reconciliador SSOT
// Limite: sales_limit_snapshot congelado (sem fallback comercial silencioso)
// ======================================================================

import { randomUUID } from "node:crypto";
import { logBilling } from "../billingLog.js";
import {
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_USAGE_LIMIT_METADATA_KEYS,
} from "../billingConstants.js";
import { loadCanonicalBillableSubscriptionContext } from "./billingCanonicalSubscriptionService.js";
import { readSuspensionFallbackEntitlement } from "./billingSuspensionFallbackEntitlementService.js";
import { resolveBillingAccessEntitlementSnapshot } from "./billingSubscriptionEntitlementService.js";
import { evaluateBillableSaleAdmission } from "./billingEntitlementStateTransitionService.js";
import { recordHardPausedIgnoredWebhookEvent } from "./billingSyncPauseAuditService.js";
import { loadSellerEntitlementOverlay } from "./billingSellerEntitlementStoreService.js";
import {
  normalizeBillingSnapshotOrigin,
  shouldBypassAtomicQuotaReservation,
} from "./billingQuotaEligibilityService.js";
import { resolveCanonicalAccessPrecedence } from "./billingAccessPrecedenceService.js";

/**
 * @param {Record<string, unknown>} metadata
 * @param {Record<string, unknown>} snapshot
 */
export function resolveBabyAdmissionCycleKey(metadata, snapshot = {}) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const fallback = readSuspensionFallbackEntitlement(meta);
  return String(
    meta[BILLING_USAGE_LIMIT_METADATA_KEYS.CYCLE_KEY] ??
      fallback.fallback_period_start ??
      snapshot.fallback_period_start ??
      "default",
  );
}

/**
 * Limite congelado do ciclo — fail-closed quando ausente (sem fallback comercial silencioso).
 *
 * @param {Record<string, unknown>} metadata
 * @returns {number | null}
 */
export function resolveSalesLimitSnapshotFromMetadata(metadata) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const raw = meta[BILLING_USAGE_LIMIT_METADATA_KEYS.SALES_LIMIT_SNAPSHOT];
  if (raw == null || String(raw).trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * @param {unknown} value
 */
function mapRpcReservationResult(value) {
  const row = value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
  return {
    admit: Boolean(row.admit),
    reason: String(row.reason ?? ""),
    process_sale: Boolean(row.process_sale),
    activate_hard_pause: Boolean(row.activate_hard_pause),
    pause_applied: Boolean(row.pause_applied),
    duplicate: Boolean(row.duplicate),
    domain_code: row.domain_code != null ? String(row.domain_code) : null,
    admission_id: row.admission_id != null ? String(row.admission_id) : null,
    reservation_id: row.reservation_id != null ? String(row.reservation_id) : null,
    usage_count: row.usage_count != null ? Number(row.usage_count) : null,
    usage_limit: row.usage_limit != null ? Number(row.usage_limit) : null,
    reservation_expires_at: row.reservation_expires_at != null ? String(row.reservation_expires_at) : null,
    atomic: Boolean(row.atomic),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   subscriptionId: string;
 *   cycleKey: string;
 *   externalOrderId: string;
 *   reservationOwnerToken?: string;
 *   marketplace?: string | null;
 *   marketplaceAccountId?: string | null;
 *   usageLimit?: number;
 *   simulateTxFailure?: boolean;
 *   officialOrderAt?: Date | string | null;
 *   snapshotOrigin?: string | null;
 * }} input
 */
export async function reserveBillableSaleV2(supabase, input) {
  const reservationOwnerToken = input.reservationOwnerToken ?? randomUUID();
  const officialIso =
    input.officialOrderAt instanceof Date
      ? input.officialOrderAt.toISOString()
      : input.officialOrderAt != null
        ? String(input.officialOrderAt)
        : null;
  const { data, error } = await supabase.rpc("billing_reserve_billable_sale_v2", {
    p_user_id: input.userId,
    p_subscription_id: input.subscriptionId,
    p_cycle_key: input.cycleKey,
    p_external_order_id: input.externalOrderId,
    p_reservation_owner_token: reservationOwnerToken,
    p_marketplace: input.marketplace ?? null,
    p_marketplace_account_id: input.marketplaceAccountId ?? null,
    p_usage_limit: input.usageLimit ?? null,
    p_simulate_tx_failure: Boolean(input.simulateTxFailure),
    p_official_order_at: officialIso,
    p_snapshot_origin: normalizeBillingSnapshotOrigin(input.snapshotOrigin),
  });

  if (error) {
    if (
      String(error.code ?? "") === "42883" ||
      String(error.message ?? "").includes("billing_reserve_billable_sale_v2")
    ) {
      const err = new Error("BILLING_ATOMIC_ADMISSION_RPC_MISSING");
      err.code = "BILLING_ATOMIC_ADMISSION_RPC_MISSING";
      throw err;
    }
    throw error;
  }

  const mapped = mapRpcReservationResult(data);
  logBilling("billing", "BILLING_BILLABLE_SALE_RESERVE_V2", {
    user_id: input.userId,
    subscription_id: input.subscriptionId,
    external_order_id: input.externalOrderId,
    cycle_key: input.cycleKey,
    admit: mapped.admit,
    process_sale: mapped.process_sale,
    reason: mapped.reason,
    usage_count: mapped.usage_count,
  });

  return {
    ...mapped,
    reservation_owner_token: reservationOwnerToken,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   reservationId: string;
 *   reservationOwnerToken: string;
 *   persistedAt?: string | Date | null;
 * }} input
 */
export async function finalizeBillableSaleV2(supabase, input) {
  const persistedAt =
    input.persistedAt instanceof Date
      ? input.persistedAt.toISOString()
      : input.persistedAt != null
        ? String(input.persistedAt)
        : new Date().toISOString();

  const { data, error } = await supabase.rpc("billing_finalize_billable_sale_v2", {
    p_user_id: input.userId,
    p_reservation_id: input.reservationId,
    p_reservation_owner_token: input.reservationOwnerToken,
    p_persisted_at: persistedAt,
  });

  if (error) throw error;

  const row = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
  logBilling("billing", "BILLING_BILLABLE_SALE_FINALIZE_V2", {
    user_id: input.userId,
    reservation_id: input.reservationId,
    finalized: Boolean(row.finalized),
    reason: row.reason ?? null,
    usage_count: row.usage_count ?? null,
    pause_applied: row.pause_applied ?? null,
  });

  return row;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   reservationId: string;
 *   reservationOwnerToken: string;
 *   reason?: string;
 * }} input
 */
export async function releaseBillableSaleV2(supabase, input) {
  const { data, error } = await supabase.rpc("billing_release_billable_sale_v2", {
    p_user_id: input.userId,
    p_reservation_id: input.reservationId,
    p_reservation_owner_token: input.reservationOwnerToken,
    p_reason: input.reason ?? "persist_failed",
  });

  if (error) throw error;

  const row = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
  logBilling("billing", "BILLING_BILLABLE_SALE_RELEASE_V2", {
    user_id: input.userId,
    reservation_id: input.reservationId,
    released: Boolean(row.released),
    reason: row.reason ?? null,
    usage_count: row.usage_count ?? null,
  });

  return row;
}

/**
 * Reconciliador de reservas expiradas contra SSOT sales_orders.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ batchLimit?: number }} [options]
 */
export async function reconcileExpiredBillableSaleReservations(supabase, options = {}) {
  const { data, error } = await supabase.rpc(
    "billing_reconcile_expired_billable_sale_reservations_v1",
    {
      p_batch_limit: options.batchLimit ?? 100,
    },
  );

  if (error) throw error;

  const row = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
  logBilling("billing", "BILLING_BILLABLE_SALE_RECONCILE", {
    reconciled: row.reconciled ?? 0,
    processed: row.processed ?? 0,
  });

  return row;
}

/**
 * Renova heartbeat/lease de reserva ativa (pipeline longo).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   reservationId: string;
 *   reservationOwnerToken: string;
 * }} input
 */
export async function renewBillableSaleReservationLease(supabase, input) {
  const { data, error } = await supabase.rpc("billing_renew_billable_sale_reservation_lease_v2", {
    p_user_id: input.userId,
    p_reservation_id: input.reservationId,
    p_reservation_owner_token: input.reservationOwnerToken,
  });

  if (error) throw error;

  const row = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
  logBilling("billing", "BILLING_BILLABLE_SALE_LEASE_RENEW", {
    user_id: input.userId,
    reservation_id: input.reservationId,
    renewed: Boolean(row.renewed),
    reason: row.reason ?? null,
  });

  return row;
}

/** Intervalo padrão de heartbeat — inferior a 90s do reconciliador SQL. */
export const BILLABLE_SALE_RESERVATION_HEARTBEAT_INTERVAL_MS = 45_000;

/**
 * Executa pipeline longo com heartbeat periódico + cleanup em finally.
 *
 * @template T
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {Record<string, unknown> | null | undefined} atomicAdmission
 * @param {() => Promise<T>} fn
 * @param {{ intervalMs?: number }} [options]
 */
export async function runWithBillableSaleReservationHeartbeat(
  supabase,
  userId,
  atomicAdmission,
  fn,
  options = {},
) {
  if (!atomicAdmission?.admission_id || !atomicAdmission?.reservation_owner_token) {
    return fn();
  }

  const intervalMs = options.intervalMs ?? BILLABLE_SALE_RESERVATION_HEARTBEAT_INTERVAL_MS;
  const reservationId = String(atomicAdmission.admission_id);
  const reservationOwnerToken = String(atomicAdmission.reservation_owner_token);
  let stop = false;
  /** @type {Promise<unknown> | null} */
  let inFlight = null;
  /** @type {Date | null} */
  let lastValidRenewalAt = null;
  let leaseLost = false;

  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const beatOnce = async () => {
    if (stop || leaseLost) return null;
    try {
      const row = await renewBillableSaleReservationLease(supabase, {
        userId,
        reservationId,
        reservationOwnerToken,
      });
      if (row?.renewed) {
        lastValidRenewalAt = new Date();
        logBilling("billing", "BILLING_BILLABLE_SALE_HEARTBEAT_OK", {
          user_id: userId,
          reservation_id: reservationId,
          last_valid_renewal_at: lastValidRenewalAt.toISOString(),
        });
      } else {
        leaseLost = true;
        stop = true;
        logBilling("billing", "BILLING_BILLABLE_SALE_HEARTBEAT_LEASE_LOST", {
          user_id: userId,
          reservation_id: reservationId,
          reason: row?.reason ?? "renew_rejected",
        });
        try {
          await reportBillableSaleFinalizeFailure(supabase, {
            userId,
            reservationId,
            reservationOwnerToken,
            reason: "heartbeat_lease_lost",
          });
        } catch {
          /* fail-closed já sinalizado */
        }
      }
      return row;
    } catch (leaseErr) {
      leaseLost = true;
      stop = true;
      logBilling("billing", "BILLING_BILLABLE_SALE_HEARTBEAT_FAILED", {
        user_id: userId,
        reservation_id: reservationId,
        message: leaseErr instanceof Error ? leaseErr.message : String(leaseErr),
      });
      try {
        await reportBillableSaleFinalizeFailure(supabase, {
          userId,
          reservationId,
          reservationOwnerToken,
          reason: "heartbeat_failed",
        });
      } catch {
        /* ignore */
      }
      return null;
    }
  };

  // Obrigatório: await no primeiro heartbeat (zero sobreposição).
  inFlight = beatOnce();
  await inFlight;
  inFlight = null;

  const loop = (async () => {
    while (!stop && !leaseLost) {
      await sleep(intervalMs);
      if (stop || leaseLost) break;
      inFlight = beatOnce();
      await inFlight;
      inFlight = null;
    }
  })();

  try {
    const result = await fn();
    if (leaseLost) {
      const err = new Error("BILLING_RESERVATION_LEASE_LOST");
      err.code = "BILLING_RESERVATION_LEASE_LOST";
      err.recovery_required = true;
      err.last_valid_renewal_at = lastValidRenewalAt;
      throw err;
    }
    return result;
  } finally {
    stop = true;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* ignore */
      }
    }
    try {
      await loop;
    } catch {
      /* ignore */
    }
    atomicAdmission.last_valid_renewal_at = lastValidRenewalAt
      ? lastValidRenewalAt.toISOString()
      : null;
    atomicAdmission.lease_lost = leaseLost;
  }
}

/**
 * Marca admissão como RECOVERY_REQUIRED imediatamente após falha de FINALIZE.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   reservationId: string;
 *   reservationOwnerToken: string;
 *   reason?: string;
 * }} input
 */
export async function reportBillableSaleFinalizeFailure(supabase, input) {
  const { data, error } = await supabase.rpc("billing_report_billable_sale_finalize_failure_v2", {
    p_user_id: input.userId,
    p_reservation_id: input.reservationId,
    p_reservation_owner_token: input.reservationOwnerToken,
    p_reason: input.reason ?? "finalize_failed",
  });

  if (error) throw error;

  const row = data && typeof data === "object" ? /** @type {Record<string, unknown>} */ (data) : {};
  logBilling("billing", "BILLING_BILLABLE_SALE_FINALIZE_FAILURE_REPORTED", {
    user_id: input.userId,
    reservation_id: input.reservationId,
    marked: Boolean(row.marked),
    recovery_required: Boolean(row.recovery_required),
    reason: row.reason ?? null,
  });

  return row;
}

/** @deprecated Use reserveBillableSaleV2 — wrapper V1 desabilitado na migration 6.9A.2 */
export async function admitBillableSaleAtomically(supabase, input) {
  return reserveBillableSaleV2(supabase, input);
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   reservationId: string;
 *   reservationOwnerToken: string;
 *   reason?: string;
 * }} input
 */
export async function rollbackBillableSaleAdmission(supabase, input) {
  const reservationId = String(input.reservationId ?? input.admissionId ?? "");
  if (!reservationId || !input.reservationOwnerToken) {
    const err = new Error("BILLING_ADMISSION_OWNER_TOKEN_REQUIRED");
    err.code = "BILLING_ADMISSION_OWNER_TOKEN_REQUIRED";
    throw err;
  }

  return releaseBillableSaleV2(supabase, {
    userId: input.userId,
    reservationId,
    reservationOwnerToken: input.reservationOwnerToken,
    reason: input.reason ?? "rollback_pipeline",
  });
}

/**
 * Avalia admissão — Baby usa RESERVE V2 quando há external_order_id.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   external_order_id?: string | null;
 *   marketplace?: string | null;
 *   marketplace_account_id?: string | null;
 *   reservation_owner_token?: string | null;
 *   is_new_sale?: boolean;
 *   simulate_tx_failure?: boolean;
 *   now?: Date;
 * }} [options]
 */
export async function evaluateBillableSaleBeforeProcessingAtomic(supabase, userId, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const overlay = await loadSellerEntitlementOverlay(supabase, userId);
  const snapshotOrigin = normalizeBillingSnapshotOrigin(options.snapshot_origin);
  const precedence = resolveCanonicalAccessPrecedence(overlay.metadata);

  if (!precedence.allow_process_sale) {
    return {
      admit: false,
      process_sale: false,
      reason: precedence.reason,
      domain_code: precedence.domain_code ?? null,
      precedence_rank: precedence.precedence_rank,
      activate_hard_pause: false,
      atomic: false,
      snapshot_origin: snapshotOrigin,
      webhook_ok: true,
    };
  }

  const trialBypass = shouldBypassAtomicQuotaReservation(overlay.metadata, now);
  if (trialBypass.bypass && precedence.allow_quota_bypass_trial) {
    logBilling("billing", "BILLING_TRIAL_QUOTA_BYPASS", {
      user_id: userId,
      reason: trialBypass.reason,
      trial_state: trialBypass.trial_state,
      external_order_id: options.external_order_id ?? null,
      snapshot_origin: snapshotOrigin,
    });
    return {
      admit: true,
      process_sale: true,
      reason: "trial_unlimited",
      trial_state: trialBypass.trial_state,
      atomic: false,
      quota_bypassed: true,
      activate_hard_pause: false,
      snapshot_origin: snapshotOrigin,
    };
  }

  const snapshot = await resolveBillingAccessEntitlementSnapshot(supabase, userId, { now });
  const isTrialEntitlement =
    snapshot.effective_entitlement === BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_FULL_ACCESS;
  if (isTrialEntitlement && precedence.allow_quota_bypass_trial) {
    return {
      admit: true,
      process_sale: true,
      reason: "trial_unlimited",
      atomic: false,
      quota_bypassed: true,
      activate_hard_pause: false,
      snapshot_origin: snapshotOrigin,
    };
  }

  const isBaby = snapshot.effective_entitlement === BILLING_EFFECTIVE_ENTITLEMENT.BABY_INTERNAL_FREE;
  const usageCount = Number(snapshot.usage_count ?? 0);
  const usageLimit = snapshot.usage_limit != null ? Number(snapshot.usage_limit) : null;

  if (!isBaby) {
    return {
      ...evaluateBillableSaleAdmission({
        effective_entitlement: snapshot.effective_entitlement,
        sync_state: snapshot.sync_state,
        usage_count: usageCount,
        usage_limit: usageLimit,
        projected_count: usageCount + 1,
        is_baby: false,
      }),
      atomic: false,
      snapshot_origin: snapshotOrigin,
    };
  }

  const externalOrderId =
    options.external_order_id != null ? String(options.external_order_id).trim() : "";
  if (!options.is_new_sale || !externalOrderId) {
    return {
      ...evaluateBillableSaleAdmission({
        effective_entitlement: snapshot.effective_entitlement,
        sync_state: snapshot.sync_state,
        usage_count: usageCount,
        usage_limit: usageLimit,
        projected_count: usageCount + 1,
        is_baby: true,
      }),
      atomic: false,
      snapshot_origin: snapshotOrigin,
    };
  }

  const { canonicalSubscription } = await loadCanonicalBillableSubscriptionContext(supabase, userId);
  if (!canonicalSubscription?.id) {
    return {
      admit: false,
      reason: "subscription_not_found",
      process_sale: false,
      activate_hard_pause: false,
      atomic: false,
      snapshot_origin: snapshotOrigin,
    };
  }

  const meta =
    canonicalSubscription.metadata && typeof canonicalSubscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (canonicalSubscription.metadata)
      : {};
  const salesLimitSnapshot = resolveSalesLimitSnapshotFromMetadata(meta);
  const officialOrderAt =
    options.official_order_at instanceof Date
      ? options.official_order_at
      : options.official_order_at != null
        ? new Date(String(options.official_order_at))
        : null;

  return reserveBillableSaleV2(supabase, {
    userId,
    subscriptionId: String(canonicalSubscription.id),
    cycleKey: resolveBabyAdmissionCycleKey(meta, snapshot),
    externalOrderId,
    marketplace: options.marketplace ?? null,
    marketplaceAccountId: options.marketplace_account_id ?? null,
    reservationOwnerToken: options.reservation_owner_token ?? undefined,
    usageLimit: salesLimitSnapshot,
    simulateTxFailure: Boolean(options.simulate_tx_failure),
    officialOrderAt,
    snapshotOrigin,
  });
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {{
 *   marketplace?: string | null;
 *   marketplace_account_id?: string | null;
 *   reason?: string | null;
 * }} [options]
 */
export async function recordBillableSaleIgnoredAtHardLimit(supabase, userId, options = {}) {
  const { canonicalSubscription } = await loadCanonicalBillableSubscriptionContext(supabase, userId);
  if (!canonicalSubscription?.id) return { acknowledged: false, reason: "subscription_not_found" };
  const meta =
    canonicalSubscription.metadata && typeof canonicalSubscription.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (canonicalSubscription.metadata)
      : {};
  return recordHardPausedIgnoredWebhookEvent(supabase, {
    subscriptionId: String(canonicalSubscription.id),
    metadata: meta,
    marketplace: options.marketplace ?? null,
    marketplaceAccountId: options.marketplace_account_id ?? null,
    reason: options.reason ?? "BABY_HARD_LIMIT_REACHED",
  });
}
