// ======================================================================
// AsaasCustomerCommunicationPolicyStrategy
// Traduz a regra agnóstica → contrato Asaas (notificationDisabled: true)
// S1.HF.ASAAS-NOTIFICATIONS.1
// ======================================================================

import {
  ASAAS_CUSTOMER_NOTIFICATION_POLICY,
  CUSTOMER_PROVIDER_COMMUNICATION_DISABLED,
  CUSTOMER_PROVIDER_COMMUNICATION_POLICY_VERSION,
  POLICY_STATUS,
} from "../customerCommunicationPolicyConstants.js";
import {
  applyAsaasCustomerNotificationPolicy,
  isCanonicalNotificationDisabled,
} from "./applyAsaasCustomerNotificationPolicy.js";

/**
 * @typedef {{
 *   provider: string;
 *   policyVersion: string;
 *   productRule: boolean;
 *   asaasContract: Readonly<{ notificationDisabled: true }>;
 *   buildCreatePayload: (validated: Record<string, unknown>) => Record<string, unknown>;
 *   buildUpdatePayload: (validated: Record<string, unknown>) => Record<string, unknown>;
 *   classifyRemoteCustomer: (remote: Record<string, unknown> | null | undefined) => {
 *     status: string;
 *     notificationDisabled: boolean | null;
 *     confirmed: boolean;
 *   };
 * }} CustomerCommunicationPolicyStrategy
 */

/** @type {CustomerCommunicationPolicyStrategy} */
export const AsaasCustomerCommunicationPolicyStrategy = Object.freeze({
  provider: "asaas",
  policyVersion: CUSTOMER_PROVIDER_COMMUNICATION_POLICY_VERSION,
  productRule: CUSTOMER_PROVIDER_COMMUNICATION_DISABLED,
  asaasContract: ASAAS_CUSTOMER_NOTIFICATION_POLICY,

  buildCreatePayload(validated) {
    return applyAsaasCustomerNotificationPolicy(validated);
  },

  buildUpdatePayload(validated) {
    return applyAsaasCustomerNotificationPolicy(validated);
  },

  classifyRemoteCustomer(remote) {
    if (!remote || typeof remote !== "object") {
      return {
        status: POLICY_STATUS.UNKNOWN,
        notificationDisabled: null,
        confirmed: false,
      };
    }
    const raw = /** @type {{ notificationDisabled?: unknown }} */ (remote).notificationDisabled;
    if (isCanonicalNotificationDisabled(raw)) {
      return {
        status: POLICY_STATUS.CONFIRMED_DISABLED,
        notificationDisabled: true,
        confirmed: true,
      };
    }
    if (raw === false) {
      return {
        status: POLICY_STATUS.DIVERGENT,
        notificationDisabled: false,
        confirmed: false,
      };
    }
    return {
      status: POLICY_STATUS.PENDING_CONFIRMATION,
      notificationDisabled: raw == null ? null : Boolean(raw),
      confirmed: false,
    };
  },
});

/**
 * @returns {CustomerCommunicationPolicyStrategy}
 */
export function getCustomerCommunicationPolicyStrategy(provider = "asaas") {
  const key = String(provider || "asaas").trim().toLowerCase();
  if (key === "asaas") return AsaasCustomerCommunicationPolicyStrategy;
  throw new Error(`CustomerCommunicationPolicyStrategy não suportada: ${key}`);
}
