// ======================================================================
// Reconciliador do ciclo de vida do trial (S1.HF.6.9A.11)
// Avalia estados, emite alertas IN_APP e aplica restrição pós-trial.
// Lock in-process fail-closed (padrão 6.9A.10) — sem setInterval por usuário.
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  BILLING_ENTITLEMENT_OVERLAY_PROVIDER,
  BILLING_ENTITLEMENT_OVERLAY_STATUS,
  BILLING_TRIAL_LIFECYCLE_STATE,
  BILLING_TRIAL_STATE,
} from "../billingConstants.js";
import { loadSellerEntitlementOverlay } from "../services/billingSellerEntitlementStoreService.js";
import { transitionExpireTrialToRestricted } from "../services/billingSellerTrialService.js";
import { publishTrialLifecycleAlertIfNeeded } from "../services/billingTrialLifecycleAlertsService.js";
import { resolveTrialLifecycleState } from "../services/billingTrialLifecycleService.js";
import { loadCanonicalBillableSubscriptionContext } from "../services/billingCanonicalSubscriptionService.js";

export const BILLING_TRIAL_LIFECYCLE_RECONCILER_DEFAULTS = {
  batch_limit: 100,
  max_retries: 3,
};

/** @type {{ running: boolean; lastStartedAt: string | null; lastFinishedAt: string | null; lastError: string | null }} */
const lockState = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null,
};

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ userId: string; now?: Date; correlation_id?: string | null }} input
 */
export async function reconcileSellerTrialLifecycle(supabase, input) {
  const userId = String(input.userId ?? "").trim();
  if (!userId) return { ok: false, reason: "missing_user" };

  const now = input.now instanceof Date ? input.now : new Date();
  const overlay = await loadSellerEntitlementOverlay(supabase, userId);
  if (!overlay.overlay_id) return { ok: true, skipped: true, reason: "overlay_missing" };

  let paidConfirmed = false;
  /** @type {string | null} */
  let subscriptionId = null;
  try {
    const canonical = await loadCanonicalBillableSubscriptionContext(supabase, userId);
    const sub = canonical?.canonicalSubscription ?? null;
    subscriptionId = canonical?.canonicalSubscriptionId ?? (sub?.id != null ? String(sub.id) : null);
    paidConfirmed =
      Boolean(subscriptionId) && String(sub?.status ?? "").toLowerCase() === "active";
  } catch {
    paidConfirmed = false;
  }

  const before = resolveTrialLifecycleState({
    metadata: overlay.metadata,
    now,
    paid_confirmed: paidConfirmed,
    canonical_subscription_active: paidConfirmed,
  });

  let expiredResult = null;
  if (
    before.lifecycle_state === BILLING_TRIAL_LIFECYCLE_STATE.TRIAL_EXPIRED_RESTRICTED &&
    String(overlay.metadata?.trial_state ?? "") !== BILLING_TRIAL_STATE.EXPIRED &&
    !paidConfirmed
  ) {
    expiredResult = await transitionExpireTrialToRestricted(supabase, userId, {
      now,
      paid_confirmed: paidConfirmed,
      idempotency_key: `trial-expire:${userId}:${String(before.trial_end_date ?? "")}`,
    });
  }

  const overlayAfter = expiredResult?.expired
    ? await loadSellerEntitlementOverlay(supabase, userId)
    : overlay;

  const alertResult = await publishTrialLifecycleAlertIfNeeded(supabase, {
    userId,
    metadata: overlayAfter.metadata,
    now,
    paid_confirmed: paidConfirmed,
    canonical_subscription_active: paidConfirmed,
    subscription_id: subscriptionId,
    correlation_id: input.correlation_id ?? null,
  });

  const after = alertResult.lifecycle ?? before;

  logBilling("billing", "TRIAL_STATE_EVALUATED", {
    user_id: userId,
    subscription_id: subscriptionId,
    previous_state: before.lifecycle_state,
    next_state: after.lifecycle_state,
    trial_ends_at: after.trial_ends_at,
    reason: after.access_reason,
    owner: after.access_owner,
    correlation_id: input.correlation_id ?? null,
  });

  return {
    ok: true,
    user_id: userId,
    previous_state: before.lifecycle_state,
    next_state: after.lifecycle_state,
    expired: Boolean(expiredResult?.expired),
    expired_idempotent: Boolean(expiredResult?.idempotent),
    alert: {
      created: Boolean(alertResult.created),
      skipped: Boolean(alertResult.skipped),
      idempotent: Boolean(alertResult.idempotent),
      reason: alertResult.reason ?? null,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userIds?: string[];
 *   batchLimit?: number;
 *   maxRetries?: number;
 *   source?: string;
 *   now?: Date;
 * }} [options]
 */
export async function runBillingTrialLifecycleReconcilerJob(supabase, options = {}) {
  // Otimização local apenas — NÃO é garantia multi-instância.
  if (lockState.running && options.bypass_in_process_lock !== true) {
    logBilling("billing", "TRIAL_TRANSITION_RETRY", {
      reason: "in_process_lock_held",
      source: options.source ?? "cron",
    });
    return { ok: false, skipped: true, reason: "in_process_lock_held" };
  }

  const owner = `trial-job:${options.source ?? "cron"}:${process.pid}:${Date.now()}`;
  const {
    tryAcquireTrialLifecycleJobLock,
    releaseTrialLifecycleJobLock,
  } = await import("../services/billingTrialLifecycleAtomicService.js");

  const distributed = await tryAcquireTrialLifecycleJobLock(supabase, {
    owner,
    ttlSeconds: 120,
  });
  if (distributed.ok && !distributed.acquired) {
    logBilling("billing", "TRIAL_TRANSITION_RETRY", {
      reason: "distributed_lock_held",
      source: options.source ?? "cron",
      lock_owner: distributed.owner ?? null,
    });
    return {
      ok: false,
      skipped: true,
      reason: "distributed_lock_held",
      active_owner: distributed.owner ?? null,
    };
  }
  // rpc_missing: segue com in-process (deploy gate documentado).

  if (options.bypass_in_process_lock !== true) {
    lockState.running = true;
  }
  lockState.lastStartedAt = new Date().toISOString();
  lockState.lastError = null;

  const batchLimit = options.batchLimit ?? BILLING_TRIAL_LIFECYCLE_RECONCILER_DEFAULTS.batch_limit;
  const maxRetries = options.maxRetries ?? BILLING_TRIAL_LIFECYCLE_RECONCILER_DEFAULTS.max_retries;
  const now = options.now instanceof Date ? options.now : new Date();

  try {
    let attempt = 0;
    while (attempt < maxRetries) {
      attempt += 1;
      try {
        /** @type {string[]} */
        let userIds = Array.isArray(options.userIds) ? options.userIds.map(String) : [];
        if (userIds.length === 0) {
          // Overlay de trial vive em billing_subscriptions (provider interno).
          const { data, error } = await supabase
            .from("billing_subscriptions")
            .select("user_id, metadata")
            .eq("provider", BILLING_ENTITLEMENT_OVERLAY_PROVIDER)
            .eq("status", BILLING_ENTITLEMENT_OVERLAY_STATUS)
            .limit(Math.max(batchLimit * 3, 100));
          if (error) throw error;
          const candidates = [];
          for (const row of data ?? []) {
            const state = String(row?.metadata?.trial_state ?? "");
            if (
              state === BILLING_TRIAL_STATE.ACTIVE ||
              state === BILLING_TRIAL_STATE.ENDING_SOON ||
              state === BILLING_TRIAL_STATE.ENDS_TODAY ||
              state === BILLING_TRIAL_STATE.EXPIRED
            ) {
              const id = String(row.user_id ?? "");
              if (id) candidates.push(id);
            }
          }
          userIds = [...new Set(candidates)].slice(0, batchLimit);
        }

        const results = [];
        for (const userId of userIds.slice(0, batchLimit)) {
          results.push(
            await reconcileSellerTrialLifecycle(supabase, {
              userId,
              now,
              correlation_id: `trial-lifecycle:${options.source ?? "cron"}:${now.toISOString()}`,
            }),
          );
        }

        lockState.lastFinishedAt = new Date().toISOString();
        return {
          ok: true,
          attempt,
          processed: results.length,
          results,
        };
      } catch (err) {
        lockState.lastError = err instanceof Error ? err.message : String(err);
        logBilling("billing", "TRIAL_TRANSITION_RETRY", {
          source: options.source ?? "cron",
          attempt,
          max_retries: maxRetries,
          message: lockState.lastError,
        });
        if (attempt >= maxRetries) {
          logBilling("billing", "TRIAL_TRANSITION_FAILED", {
            source: options.source ?? "cron",
            attempt,
            message: lockState.lastError,
          });
          throw err;
        }
      }
    }
    return { ok: false, attempt };
  } finally {
    lockState.running = false;
    if (distributed.ok && distributed.acquired) {
      await releaseTrialLifecycleJobLock(supabase, { owner });
    }
  }
}

export function getBillingTrialLifecycleReconcilerLockState() {
  return { ...lockState };
}
