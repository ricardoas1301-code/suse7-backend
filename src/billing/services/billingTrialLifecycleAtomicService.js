// ======================================================================
// Boundary atômico multi-instância do trial lifecycle (S1.HF.6.9A.11A)
// Garantia principal: ledger UNIQUE + RPC transacional (não lock in-process).
// ======================================================================

import { logBilling } from "../billingLog.js";
import {
  BILLING_EFFECTIVE_ENTITLEMENT,
  BILLING_ENTITLEMENT_OVERLAY_PROVIDER,
  BILLING_ENTITLEMENT_OVERLAY_STATUS,
  BILLING_ENTITLEMENT_SOURCE,
  BILLING_TRIAL_METADATA_KEYS,
  BILLING_TRIAL_STATE,
} from "../billingConstants.js";
import {
  BILLING_TRIAL_ACCESS_OWNER,
  buildTrialAlertIdempotencyKey,
  buildTrialExpiredRestrictionPatch,
  clearTrialLifecycleRestrictionFromMetadata,
} from "./billingTrialLifecycleService.js";
import { normalizeTrialEndsAtExclusive } from "./billingTrialEndsAtNormalizationService.js";

export const BILLING_TRIAL_TRANSITION_KIND = Object.freeze({
  ALERT_D3: "ALERT_D3",
  ALERT_D2: "ALERT_D2",
  ALERT_D1: "ALERT_D1",
  ALERT_EXPIRED: "ALERT_EXPIRED",
  EXPIRE_RESTRICTED: "EXPIRE_RESTRICTED",
  RESTORE_PAID: "RESTORE_PAID",
});

/**
 * @param {string} alertKind D3|D2|D1|EXPIRED
 */
export function alertKindToTransitionKind(alertKind) {
  const map = {
    D3: BILLING_TRIAL_TRANSITION_KIND.ALERT_D3,
    D2: BILLING_TRIAL_TRANSITION_KIND.ALERT_D2,
    D1: BILLING_TRIAL_TRANSITION_KIND.ALERT_D1,
    EXPIRED: BILLING_TRIAL_TRANSITION_KIND.ALERT_EXPIRED,
  };
  return map[String(alertKind)] ?? null;
}

/**
 * Simula ledger persistente (UNIQUE user_id + trial_end_civil + kind).
 * Usado em testes multi-processo — NÃO é o lock in-process do job.
 *
 * @param {Map<string, Record<string, unknown>>} ledgerStore
 * @param {{ user_id: string; trial_end_civil: string; kind: string; payload?: Record<string, unknown> }} entry
 */
export function claimTrialLifecycleTransitionLedger(ledgerStore, entry) {
  const userId = String(entry.user_id ?? "").trim();
  const trialEnd = String(entry.trial_end_civil ?? "").trim().slice(0, 10);
  const kind = String(entry.kind ?? "").trim();
  if (!userId || !trialEnd || !kind) {
    return { ok: false, claimed: false, error: "invalid_ledger_entry" };
  }
  const key = `${userId}|${trialEnd}|${kind}`;
  if (ledgerStore.has(key)) {
    return {
      ok: true,
      claimed: false,
      idempotent: true,
      conflict: true,
      existing: ledgerStore.get(key),
      key,
    };
  }
  const row = {
    user_id: userId,
    trial_end_civil: trialEnd,
    kind,
    payload: entry.payload ?? {},
    created_at: new Date().toISOString(),
  };
  ledgerStore.set(key, row);
  return { ok: true, claimed: true, idempotent: false, conflict: false, existing: row, key };
}

/**
 * Resolve corrida expiração × pagamento sem depender de ordem de chegada do Node.
 *
 * @param {{
 *   paid_confirmed: boolean;
 *   metadata: Record<string, unknown>;
 *   intended: 'EXPIRE_RESTRICTED' | 'RESTORE_PAID';
 * }} input
 */
export function resolveExpireVsPaidRace(input) {
  const meta = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const paid = Boolean(input.paid_confirmed);

  if (paid) {
    const cleared = clearTrialLifecycleRestrictionFromMetadata(meta);
    return {
      winner: "PAID_ACTIVE",
      action: BILLING_TRIAL_TRANSITION_KIND.RESTORE_PAID,
      apply_expire: false,
      clear_trial_owner_only: true,
      metadata_next: {
        ...cleared.metadata,
        [BILLING_TRIAL_METADATA_KEYS.TRIAL_STATE]: BILLING_TRIAL_STATE.CONVERTED,
        effective_entitlement: BILLING_EFFECTIVE_ENTITLEMENT.PAID_PLAN,
        effective_entitlement_source: BILLING_ENTITLEMENT_SOURCE.SUBSCRIPTION_ACTIVE,
        suspension_fallback_active: false,
        access_profile: "FULL_ACCESS",
        sync_state: "FULL",
      },
      preserve_other_owners: true,
    };
  }

  if (input.intended === BILLING_TRIAL_TRANSITION_KIND.RESTORE_PAID) {
    return {
      winner: "NO_PAID_CONFIRMATION",
      action: null,
      apply_expire: false,
      clear_trial_owner_only: false,
      metadata_next: meta,
      preserve_other_owners: true,
    };
  }

  const already =
    String(meta[BILLING_TRIAL_METADATA_KEYS.TRIAL_STATE] ?? "") === BILLING_TRIAL_STATE.EXPIRED &&
    String(meta.effective_entitlement ?? "") === BILLING_EFFECTIVE_ENTITLEMENT.TRIAL_EXPIRED_RESTRICTED;

  if (already) {
    return {
      winner: "TRIAL_EXPIRED_RESTRICTED",
      action: BILLING_TRIAL_TRANSITION_KIND.EXPIRE_RESTRICTED,
      apply_expire: false,
      idempotent: true,
      metadata_next: meta,
      preserve_other_owners: true,
    };
  }

  const patch = buildTrialExpiredRestrictionPatch(meta, new Date());
  return {
    winner: "TRIAL_EXPIRED_RESTRICTED",
    action: BILLING_TRIAL_TRANSITION_KIND.EXPIRE_RESTRICTED,
    apply_expire: true,
    idempotent: false,
    metadata_next: { ...meta, ...patch },
    preserve_other_owners: true,
  };
}

/**
 * Dois “processos” distintos competindo pelo mesmo ledger (DB simulado).
 * Não compartilha lockState in-process do reconciliador.
 *
 * @param {{
 *   userId: string;
 *   trialEndCivil: string;
 *   kind: string;
 *   processCount?: number;
 * }} input
 */
export function simulateMultiInstanceTransitionClaims(input) {
  /** @type {Map<string, Record<string, unknown>>} */
  const sharedLedger = new Map();
  const processCount = Math.max(2, Number(input.processCount) || 2);
  const results = [];
  for (let i = 0; i < processCount; i += 1) {
    results.push(
      claimTrialLifecycleTransitionLedger(sharedLedger, {
        user_id: input.userId,
        trial_end_civil: input.trialEndCivil,
        kind: input.kind,
        payload: { process_index: i },
      }),
    );
  }
  const claimed = results.filter((r) => r.claimed).length;
  const idempotent = results.filter((r) => r.idempotent).length;
  return {
    claimed_count: claimed,
    idempotent_count: idempotent,
    unique_ok: claimed === 1 && idempotent === processCount - 1,
    results,
    ledger_size: sharedLedger.size,
  };
}

/**
 * Chama RPC atômica quando disponível; falha fechada se RPC ausente em produção.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{
 *   userId: string;
 *   kind: string;
 *   trialEndCivil: string;
 *   paidConfirmed?: boolean;
 *   correlationId?: string | null;
 *   now?: Date;
 * }} input
 */
export async function applyTrialLifecycleTransitionAtomic(supabase, input) {
  const userId = String(input.userId ?? "").trim();
  const kind = String(input.kind ?? "").trim();
  const trialEndCivil = String(input.trialEndCivil ?? "").trim().slice(0, 10);
  if (!userId || !kind || !/^\d{4}-\d{2}-\d{2}$/.test(trialEndCivil)) {
    return { ok: false, error: "invalid_input" };
  }

  const { data, error } = await supabase.rpc("billing_trial_lifecycle_apply_transition", {
    p_user_id: userId,
    p_kind: kind,
    p_trial_end_civil: trialEndCivil,
    p_paid_confirmed: Boolean(input.paidConfirmed),
    p_correlation_id: input.correlationId ?? null,
    p_overlay_provider: BILLING_ENTITLEMENT_OVERLAY_PROVIDER,
    p_overlay_status: BILLING_ENTITLEMENT_OVERLAY_STATUS,
  });

  if (error) {
    // Migration ainda não aplicada — fail-closed para mutações críticas.
    logBilling("billing", "TRIAL_TRANSITION_FAILED", {
      user_id: userId,
      kind,
      reason: error.message,
      code: error.code ?? null,
      correlation_id: input.correlationId ?? null,
    });
    return { ok: false, error: error.message, code: error.code ?? null, rpc_missing: true };
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
 * Adquire lock distribuído do job (cron × HTTP). In-process continua só como otimização.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ owner: string; ttlSeconds?: number }} input
 */
export async function tryAcquireTrialLifecycleJobLock(supabase, input) {
  const owner = String(input.owner ?? "").trim();
  if (!owner) return { ok: false, acquired: false, error: "missing_owner" };
  const ttl = Number(input.ttlSeconds) > 0 ? Number(input.ttlSeconds) : 120;
  const { data, error } = await supabase.rpc("billing_trial_lifecycle_try_acquire_job_lock", {
    p_lock_key: "trial_lifecycle_reconciler",
    p_owner: owner,
    p_ttl_seconds: ttl,
  });
  if (error) {
    return { ok: false, acquired: false, error: error.message, rpc_missing: true };
  }
  const row = data && typeof data === "object" ? data : {};
  return {
    ok: true,
    acquired: Boolean(row.acquired),
    reason: row.reason ?? null,
    owner: row.owner ?? null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {{ owner: string }} input
 */
export async function releaseTrialLifecycleJobLock(supabase, input) {
  const owner = String(input.owner ?? "").trim();
  const { error } = await supabase.rpc("billing_trial_lifecycle_release_job_lock", {
    p_lock_key: "trial_lifecycle_reconciler",
    p_owner: owner,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Helper de prova: chave de alerta + kind de transição alinhados.
 *
 * @param {string} userId
 * @param {string} trialEndCivil
 * @param {string} alertKind
 */
export function buildAlertPersistenceContract(userId, trialEndCivil, alertKind) {
  const clock = normalizeTrialEndsAtExclusive({ trial_end_date: trialEndCivil });
  return {
    table: "s7_notification_events",
    columns: ["seller_id", "idempotency_key"],
    unique_index: "s7_notification_events_seller_idempotency_uq",
    idempotency_key: buildTrialAlertIdempotencyKey(userId, trialEndCivil, alertKind),
    transition_ledger_table: "billing_trial_lifecycle_transitions",
    transition_kind: alertKindToTransitionKind(alertKind),
    trial_ends_at_exclusive: clock.trial_ends_at_exclusive_iso,
    access_owner: BILLING_TRIAL_ACCESS_OWNER.TRIAL_LIFECYCLE_ENGINE,
  };
}
