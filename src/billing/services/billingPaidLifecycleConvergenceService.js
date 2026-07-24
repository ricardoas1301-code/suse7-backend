// ======================================================================
// Convergência de estados transitórios do ciclo pago (S1.HF.6.9A.12A)
// ======================================================================

import { BILLING_PAID_LIFECYCLE_STATE } from "../billingConstants.js";
import { resolvePaidLifecycleState } from "./billingPaidLifecycleService.js";

/**
 * Classificação: persistente | derivado | auditoria | transitório
 */
export const BILLING_PAID_STATE_KIND = Object.freeze({
  [BILLING_PAID_LIFECYCLE_STATE.PAID_ACTIVE]: "persistent",
  [BILLING_PAID_LIFECYCLE_STATE.RENEWAL_AVAILABLE]: "derived",
  [BILLING_PAID_LIFECYCLE_STATE.PAYMENT_PENDING]: "derived",
  [BILLING_PAID_LIFECYCLE_STATE.RENEWAL_PAID_SCHEDULED]: "persistent_metadata",
  [BILLING_PAID_LIFECYCLE_STATE.PAYMENT_DUE]: "derived",
  [BILLING_PAID_LIFECYCLE_STATE.FINANCIAL_GRACE]: "derived",
  [BILLING_PAID_LIFECYCLE_STATE.PAID_SUSPENDED]: "persistent",
  [BILLING_PAID_LIFECYCLE_STATE.BABY_FALLBACK_ACTIVE]: "persistent_metadata",
  [BILLING_PAID_LIFECYCLE_STATE.REACTIVATION_PENDING]: "derived",
  [BILLING_PAID_LIFECYCLE_STATE.PAID_REACTIVATED]: "transient_audit",
  NEXT_PERIOD_ACTIVE: "audit_alias",
});

/**
 * Após reativação/confirmação, PAID_REACTIVATED não fica preso —
 * reconverge para o estado determinado pela precedência/resolver.
 *
 * @param {Parameters<typeof resolvePaidLifecycleState>[0]} input
 */
export function convergePaidLifecycleAfterMutation(input) {
  const resolved = resolvePaidLifecycleState({
    ...input,
    // Pós-mutação: confirmação já aplicada; não manter flag transitória.
    payment_confirmed_for_competence: false,
    reactivation_checkout_open: false,
  });

  if (resolved.lifecycle_state === BILLING_PAID_LIFECYCLE_STATE.PAID_REACTIVATED) {
    return {
      ...resolved,
      lifecycle_state: BILLING_PAID_LIFECYCLE_STATE.PAID_ACTIVE,
      transient_converged_from: BILLING_PAID_LIFECYCLE_STATE.PAID_REACTIVATED,
      state_kind: BILLING_PAID_STATE_KIND[BILLING_PAID_LIFECYCLE_STATE.PAID_ACTIVE],
    };
  }

  return {
    ...resolved,
    transient_converged_from: null,
    state_kind: BILLING_PAID_STATE_KIND[String(resolved.lifecycle_state ?? "")] ?? "unknown",
  };
}

/**
 * @param {string | null | undefined} state
 */
export function isPaidLifecycleTransientState(state) {
  const kind = BILLING_PAID_STATE_KIND[String(state ?? "")];
  return kind === "transient_audit" || kind === "derived";
}
