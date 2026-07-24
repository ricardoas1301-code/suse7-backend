// ======================================================================
// Atomicidade multi-instância do ciclo pago (S1.HF.6.9A.12)
// Padrão 6.9A.11A: ledger UNIQUE + RPC + advisory lock.
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  BILLING_PAYMENT_DELINQUENCY_OWNER,
  BILLING_PAID_LIFECYCLE_STATE,
} from "../billingConstants.js";
import {
  clearPaymentDelinquencyOwnerFromMetadata,
  resolvePaidLifecycleState,
} from "./billingPaidLifecycleService.js";
import { buildCompetenceKey } from "./billingPaidCivilCycleService.js";
import { isEarlyRenewalPaymentWithinCurrentPeriod } from "./billingCycleService.js";

export const BILLING_PAID_TRANSITION_KIND = Object.freeze({
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  COMPETENCE_SCHEDULED: "COMPETENCE_SCHEDULED",
  PERIOD_ROLLOVER: "PERIOD_ROLLOVER",
  ENTER_GRACE: "ENTER_GRACE",
  SUSPEND: "SUSPEND",
  BABY_FALLBACK: "BABY_FALLBACK",
  REACTIVATE: "REACTIVATE",
  ALERT: "ALERT",
});

/**
 * @param {Map<string, Record<string, unknown>>} ledgerStore
 * @param {{
 *   provider: string;
 *   provider_event_id?: string | null;
 *   provider_payment_id?: string | null;
 *   canonical_subscription_id: string;
 *   competence_key: string;
 *   event_type: string;
 * }} entry
 */
export function claimPaidLifecycleLedger(ledgerStore, entry) {
  const provider = String(entry.provider ?? "").trim();
  const subId = String(entry.canonical_subscription_id ?? "").trim();
  const competence = String(entry.competence_key ?? "").trim();
  const eventType = String(entry.event_type ?? "").trim();
  const paymentId = String(entry.provider_payment_id ?? "").trim();
  const eventId = String(entry.provider_event_id ?? "").trim();
  if (!provider || !subId || !competence || !eventType) {
    return { ok: false, claimed: false, error: "invalid_ledger_entry" };
  }
  const key = [provider, eventId || paymentId || "none", subId, competence, eventType].join("|");
  if (ledgerStore.has(key)) {
    return { ok: true, claimed: false, idempotent: true, conflict: true, existing: ledgerStore.get(key), key };
  }
  const row = { ...entry, key, created_at: new Date().toISOString() };
  ledgerStore.set(key, row);
  return { ok: true, claimed: true, idempotent: false, conflict: false, existing: row, key };
}

/**
 * @param {{
 *   userId: string;
 *   canonicalSubscriptionId: string;
 *   competenceKey: string;
 *   eventType: string;
 *   processCount?: number;
 * }} input
 */
export function simulateMultiInstancePaidClaims(input) {
  /** @type {Map<string, Record<string, unknown>>} */
  const ledger = new Map();
  const n = Math.max(2, Number(input.processCount) || 2);
  const results = [];
  for (let i = 0; i < n; i += 1) {
    results.push(
      claimPaidLifecycleLedger(ledger, {
        provider: "asaas",
        provider_event_id: `evt-${input.eventType}`,
        provider_payment_id: `pay-${input.competenceKey}`,
        canonical_subscription_id: input.canonicalSubscriptionId,
        competence_key: input.competenceKey,
        event_type: input.eventType,
      }),
    );
  }
  return {
    claimed_count: results.filter((r) => r.claimed).length,
    idempotent_count: results.filter((r) => r.idempotent).length,
    unique_ok: results.filter((r) => r.claimed).length === 1,
    ledger_size: ledger.size,
    results,
  };
}

/**
 * Corrida: cron suspende × webhook confirma pagamento.
 *
 * @param {{
 *   payment_confirmed: boolean;
 *   intended: 'SUSPEND' | 'REACTIVATE' | 'CONFIRM';
 *   metadata: Record<string, unknown>;
 * }} input
 */
export function resolveSuspendVsPaymentRace(input) {
  if (input.payment_confirmed) {
    const cleared = clearPaymentDelinquencyOwnerFromMetadata(input.metadata);
    return {
      winner: BILLING_PAID_LIFECYCLE_STATE.PAID_REACTIVATED,
      apply_suspend: false,
      apply_reactivate: true,
      clear_owner: BILLING_PAYMENT_DELINQUENCY_OWNER.PAYMENT_DELINQUENCY_ENGINE,
      metadata_next: cleared.metadata,
      preserve_other_owners: true,
    };
  }
  if (input.intended === "SUSPEND") {
    return {
      winner: BILLING_PAID_LIFECYCLE_STATE.PAID_SUSPENDED,
      apply_suspend: true,
      apply_reactivate: false,
      clear_owner: null,
      metadata_next: input.metadata,
      preserve_other_owners: true,
    };
  }
  return {
    winner: null,
    apply_suspend: false,
    apply_reactivate: false,
    clear_owner: null,
    metadata_next: input.metadata,
    preserve_other_owners: true,
  };
}

/**
 * Pagamento antecipado: não avança current_period; agenda next competence.
 *
 * @param {{
 *   subscription: Record<string, unknown>;
 *   paidAtIso: string;
 *   nextPeriodStartCivil: string;
 *   nextPeriodEndExclusiveCivil: string;
 *   paymentId: string;
 * }} input
 */
export function resolveEarlyPaymentScheduling(input) {
  const early = isEarlyRenewalPaymentWithinCurrentPeriod(input.subscription, input.paidAtIso);
  if (!early) {
    return { early: false, schedule_next: false, advance_current_period: false };
  }
  const competenceKey = buildCompetenceKey(
    String(input.subscription.id),
    input.nextPeriodStartCivil,
    input.nextPeriodEndExclusiveCivil,
  );
  return {
    early: true,
    schedule_next: true,
    advance_current_period: false,
    competence_key: competenceKey,
    scheduled_renewal: {
      payment_id: input.paymentId,
      paid_at: input.paidAtIso,
      period_start: input.nextPeriodStartCivil,
      next_due_date: input.nextPeriodEndExclusiveCivil,
      activated_at: null,
    },
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   provider: string;
 *   providerEventId?: string | null;
 *   providerPaymentId?: string | null;
 *   canonicalSubscriptionId: string;
 *   competenceKey: string;
 *   eventType: string;
 *   paidConfirmed?: boolean;
 *   correlationId?: string | null;
 * }} input
 */
export async function applyPaidLifecycleTransitionAtomic(supabase, input) {
  const { data, error } = await supabase.rpc("billing_paid_lifecycle_apply_transition", {
    p_provider: input.provider,
    p_provider_event_id: input.providerEventId ?? null,
    p_provider_payment_id: input.providerPaymentId ?? null,
    p_canonical_subscription_id: input.canonicalSubscriptionId,
    p_competence_key: input.competenceKey,
    p_event_type: input.eventType,
    p_paid_confirmed: Boolean(input.paidConfirmed),
    p_correlation_id: input.correlationId ?? null,
  });
  if (error) {
    logBilling("billing", "PAID_TRANSITION_FAILED", {
      subscription_id: input.canonicalSubscriptionId,
      event_type: input.eventType,
      reason: error.message,
      code: error.code ?? null,
    });
    const rpcMissing = true;
    if (process.env.BILLING_PAID_LIFECYCLE_ATOMIC_REQUIRED === "true") {
      logBilling("billing", "PAID_ATOMIC_REQUIRED_RPC_MISSING", {
        subscription_id: input.canonicalSubscriptionId,
        event_type: input.eventType,
        reason: error.message,
      });
      return {
        ok: false,
        error: error.message,
        rpc_missing: true,
        fail_closed: true,
        code: "BILLING_PAID_LIFECYCLE_ATOMIC_REQUIRED",
      };
    }
    return { ok: false, error: error.message, rpc_missing: rpcMissing };
  }
  const row = data && typeof data === "object" ? data : {};
  return {
    ok: true,
    claimed: Boolean(row.claimed),
    idempotent: Boolean(row.idempotent),
    winner: row.winner ?? null,
    result: row,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ owner: string; ttlSeconds?: number }} input
 */
export async function tryAcquirePaidLifecycleJobLock(supabase, input) {
  const owner = String(input.owner ?? "").trim();
  if (!owner) return { ok: false, acquired: false, error: "missing_owner" };
  const { data, error } = await supabase.rpc("billing_paid_lifecycle_try_acquire_job_lock", {
    p_lock_key: "paid_lifecycle_reconciler",
    p_owner: owner,
    p_ttl_seconds: Number(input.ttlSeconds) > 0 ? Number(input.ttlSeconds) : 120,
  });
  if (error) return { ok: false, acquired: false, error: error.message, rpc_missing: true };
  const row = data && typeof data === "object" ? data : {};
  return { ok: true, acquired: Boolean(row.acquired), reason: row.reason ?? null, owner: row.owner ?? null };
}

/**
 * Snapshot de prova de estado a partir do resolver puro.
 *
 * @param {Parameters<typeof resolvePaidLifecycleState>[0]} input
 */
export function evaluatePaidLifecycleDeterministic(input) {
  return resolvePaidLifecycleState(input);
}
