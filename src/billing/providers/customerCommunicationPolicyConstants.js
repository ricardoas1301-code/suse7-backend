// ======================================================================
// Política de comunicação do customer no provider financeiro (agnóstica)
// S1.HF.ASAAS-NOTIFICATIONS.1
// ======================================================================

/** Regra de produto: customer no provider NÃO recebe comunicação automática tarifada. */
export const CUSTOMER_PROVIDER_COMMUNICATION_DISABLED = true;

/** Versão da política — invalida confirmações em cache quando muda. */
export const CUSTOMER_PROVIDER_COMMUNICATION_POLICY_VERSION = "asaas-notification-cost-guard-1";

/**
 * Contrato Asaas canônico (congelado).
 * Valor obrigatório: boolean true — nunca string/"1"/yes.
 */
export const ASAAS_CUSTOMER_NOTIFICATION_POLICY = Object.freeze({
  notificationDisabled: true,
});

export const ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED =
  "ASAAS_CUSTOMER_NOTIFICATION_POLICY_UNCONFIRMED";

export const POLICY_STATUS = Object.freeze({
  UNKNOWN: "UNKNOWN",
  PENDING_CONFIRMATION: "PENDING_CONFIRMATION",
  CONFIRMED_DISABLED: "CONFIRMED_DISABLED",
  DIVERGENT: "DIVERGENT",
  RETRYABLE_ERROR: "RETRYABLE_ERROR",
  PERMANENT_ERROR: "PERMANENT_ERROR",
  MANUAL_REVIEW: "MANUAL_REVIEW",
});

/** TTL padrão da confirmação remota (ms). Override: ASAAS_NOTIFICATION_POLICY_TTL_MS */
export const DEFAULT_NOTIFICATION_POLICY_TTL_MS = 6 * 60 * 60 * 1000;
