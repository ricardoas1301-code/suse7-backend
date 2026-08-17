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



const PAYABLE_RENEWAL_STATUSES = new Set([

  RENEWAL_STATUS.PRE_RENEWAL,

  RENEWAL_STATUS.PENDING_PAYMENT,

  RENEWAL_STATUS.PAYMENT_FAILED,

  RENEWAL_STATUS.GRACE_PERIOD,

  RENEWAL_STATUS.SCHEDULED,

]);



/**

 * @param {string} status

 * @param {string | null} paymentMethodType

 * @param {Record<string, unknown>} payload

 * @param {{ renewal_cycle_id?: string | null; renewal_status?: string | null; billing_state?: string | null; provider_payment_id?: string | null }} [renewal]

 */

export function resolvePaymentHistoryAction(status, paymentMethodType, payload, renewal = {}) {

  const normalizedStatus = String(status || "").toLowerCase();

  const method = String(paymentMethodType || payload.billingType || payload.payment_method || "")

    .trim()

    .toUpperCase();



  if (normalizedStatus === "paid") {

    return { action_type: PAYMENT_HISTORY_ACTION_TYPE.GENERATE_INVOICE, action_label: "Baixar nota fiscal" };

  }



  if (normalizedStatus === "canceled" || normalizedStatus === "cancelled") {

    return { action_type: PAYMENT_HISTORY_ACTION_TYPE.NONE, action_label: "Cancelado" };

  }



  if (normalizedStatus === "failed") {

    if (method.includes("CARD") || method === "CREDIT_CARD") {

      return { action_type: PAYMENT_HISTORY_ACTION_TYPE.NONE, action_label: "Pagamento recusado" };

    }

    return { action_type: PAYMENT_HISTORY_ACTION_TYPE.NONE, action_label: "Falha no pagamento" };

  }



  if (normalizedStatus === "overdue") {

    if (method === "BOLETO") {

      return { action_type: PAYMENT_HISTORY_ACTION_TYPE.NONE, action_label: "Boleto vencido" };

    }

    if (method === "PIX") {

      return { action_type: PAYMENT_HISTORY_ACTION_TYPE.NONE, action_label: "Pix expirado" };

    }

    return { action_type: PAYMENT_HISTORY_ACTION_TYPE.NONE, action_label: "Cobrança vencida" };

  }



  if (["pending", "awaiting_payment"].includes(normalizedStatus)) {

    if (method === "PIX" && renewal.provider_payment_id) {

      return { action_type: PAYMENT_HISTORY_ACTION_TYPE.VIEW_PIX_QR, action_label: "Visualizar QR Code do Pix" };

    }

    if (method === "BOLETO" && renewal.provider_payment_id) {

      return { action_type: PAYMENT_HISTORY_ACTION_TYPE.VIEW_BOLETO, action_label: "Gerar 2ª via do boleto" };

    }

    if (method.includes("CARD") || method === "CREDIT_CARD") {

      return { action_type: PAYMENT_HISTORY_ACTION_TYPE.UPDATE_CARD, action_label: "Atualizar cartão" };

    }

  }



  return { action_type: PAYMENT_HISTORY_ACTION_TYPE.NONE, action_label: null };

}

