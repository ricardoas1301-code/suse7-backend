// ======================================================================
// Ações dinâmicas do histórico de pagamentos (backend only)
// ======================================================================

import { PAYMENT_HISTORY_ACTION_TYPE, RENEWAL_STATUS } from "../billingConstants.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} rawPayload
 */
function readPayload(rawPayload) {
  return rawPayload && typeof rawPayload === "object" ? /** @type {Record<string, unknown>} */ (rawPayload) : {};
}

/**
 * @param {string} status
 * @param {string | null} paymentMethodType
 * @param {Record<string, unknown>} payload
 * @param {{ renewal_cycle_id?: string | null; renewal_status?: string | null }} [renewal]
 */
export function resolvePaymentHistoryAction(status, paymentMethodType, payload, renewal = {}) {
  const normalizedStatus = String(status || "").toLowerCase();
  const method = String(paymentMethodType || payload.billingType || payload.payment_method || "")
    .trim()
    .toUpperCase();

  if (normalizedStatus === "paid") {
    return { action_type: PAYMENT_HISTORY_ACTION_TYPE.GENERATE_INVOICE, action_label: "Gerar nota fiscal" };
  }

  if (normalizedStatus === "canceled" || normalizedStatus === "cancelled") {
    return { action_type: PAYMENT_HISTORY_ACTION_TYPE.NONE, action_label: "Cancelado" };
  }

  if (normalizedStatus === "failed") {
    if (method.includes("CARD") || method === "CREDIT_CARD") {
      return { action_type: PAYMENT_HISTORY_ACTION_TYPE.UPDATE_CARD, action_label: "Atualizar cartão" };
    }
    return { action_type: PAYMENT_HISTORY_ACTION_TYPE.NONE, action_label: "Falha no pagamento" };
  }

  const renewalStatus = asTrimmedString(renewal.renewal_status);
  const hasRenewalCycle = Boolean(renewal.renewal_cycle_id);
  const isRenewalPayable =
    hasRenewalCycle &&
    renewalStatus &&
    [RENEWAL_STATUS.PENDING_PAYMENT, RENEWAL_STATUS.PAYMENT_FAILED, RENEWAL_STATUS.GRACE_PERIOD].includes(
      renewalStatus
    );

  if (isRenewalPayable && ["pending", "overdue"].includes(normalizedStatus)) {
    return { action_type: PAYMENT_HISTORY_ACTION_TYPE.PAY_RENEWAL, action_label: "Realizar pagamento" };
  }

  if (["pending", "overdue"].includes(normalizedStatus)) {
    if (method === "PIX") {
      return { action_type: PAYMENT_HISTORY_ACTION_TYPE.VIEW_PIX_QR, action_label: "Visualizar QR Code" };
    }
    if (method === "BOLETO") {
      return { action_type: PAYMENT_HISTORY_ACTION_TYPE.VIEW_BOLETO, action_label: "Gerar 2ª via" };
    }
    if (method.includes("CARD") || method === "CREDIT_CARD") {
      return { action_type: PAYMENT_HISTORY_ACTION_TYPE.UPDATE_CARD, action_label: "Atualizar cartão" };
    }
  }

  return { action_type: PAYMENT_HISTORY_ACTION_TYPE.NONE, action_label: null };
}
