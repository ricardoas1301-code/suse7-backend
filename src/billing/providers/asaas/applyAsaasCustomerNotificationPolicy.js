// ======================================================================
// Aplica política canônica Asaas por ÚLTIMO no payload do customer
// S1.HF.ASAAS-NOTIFICATIONS.1
// ======================================================================

import {
  ASAAS_CUSTOMER_NOTIFICATION_POLICY,
  CUSTOMER_PROVIDER_COMMUNICATION_DISABLED,
} from "../customerCommunicationPolicyConstants.js";

/**
 * Precedência obrigatória:
 * 1) dados validados do customer
 * 2) normalização/sanitização (já aplicadas pelo caller)
 * 3) política canônica SUSE7 por último
 *
 * Qualquer notificationDisabled vindo de frontend/request/cache/caller é sobrescrito.
 *
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {Record<string, unknown>}
 */
export function applyAsaasCustomerNotificationPolicy(payload) {
  const base =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload }
      : {};

  // Remove tentativas de string/"1"/false antes de forçar boolean true
  delete base.notificationDisabled;

  void CUSTOMER_PROVIDER_COMMUNICATION_DISABLED;

  return {
    ...base,
    ...ASAAS_CUSTOMER_NOTIFICATION_POLICY,
  };
}

/**
 * @param {unknown} value
 * @returns {value is true}
 */
export function isCanonicalNotificationDisabled(value) {
  return value === true;
}
