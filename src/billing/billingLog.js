// ======================================================================
// Logs padronizados — Billing S7
// ======================================================================

import { buildBillingObservabilityContext } from "./utils/billingObservability.js";
import { isBillingDevDiagnosticsEnabled } from "./utils/billingRuntimeEnv.js";

const PREFIX = {
  billing: "[S7_BILLING]",
  webhook: "[S7_BILLING_WEBHOOK]",
  asaas: "[S7_BILLING_ASAAS]",
  access: "[S7_BILLING_ACCESS]",
  usage: "[S7_BILLING_USAGE]",
};

/**
 * @param {string} scope
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 */
export function logBilling(scope, message, extra) {
  const p = PREFIX[scope] || PREFIX.billing;
  const payload = extra && typeof extra === "object" ? buildBillingObservabilityContext(extra) : extra;
  if (payload && Object.keys(payload).length > 0) {
    console.info(`${p} ${message}`, payload);
  } else {
    console.info(`${p} ${message}`);
  }
}

/**
 * @param {string} scope
 * @param {string} message
 * @param {unknown} [err]
 * @param {Record<string, unknown>} [extra]
 */
/**
 * Log de transição em testes controlados Fase 2.1 (DEV).
 *
 * @param {{
 *   status_transition: string;
 *   user_id: string;
 *   subscription_id: string;
 *   old_status?: string | null;
 *   new_status?: string | null;
 *   renewal_cycle_id?: string | null;
 *   timestamp?: string;
 *   extra?: Record<string, unknown>;
 * }} payload
 */
/**
 * Inconsistência ou reconciliação de ciclos OPEN (Fase 2.1 hardening).
 *
 * @param {Record<string, unknown>} payload
 */
export function logBillingRenewalConsistency(payload) {
  if (!isBillingDevDiagnosticsEnabled()) return;
  console.info("[BILLING RENEWAL CONSISTENCY]", buildBillingObservabilityContext(payload));
}

export function logBillingTestTransition(payload) {
  if (!isBillingDevDiagnosticsEnabled()) return;
  console.info("[BILLING TEST] status_transition", {
    status_transition: payload.status_transition,
    user_id: payload.user_id,
    subscription_id: payload.subscription_id,
    old_status: payload.old_status ?? null,
    new_status: payload.new_status ?? null,
    renewal_cycle_id: payload.renewal_cycle_id ?? null,
    timestamp: payload.timestamp ?? new Date().toISOString(),
    ...(payload.extra ?? {}),
  });
}

export function logBillingError(scope, message, err, extra) {
  const p = PREFIX[scope] || PREFIX.billing;
  const payload = buildBillingObservabilityContext({
    ...(extra && typeof extra === "object" ? extra : {}),
    reason: err instanceof Error ? err.message : String(err ?? ""),
  });
  console.error(`${p} ${message}`, payload);
}
