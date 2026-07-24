// ======================================================================
// Classificação de eventos financeiros (S1.HF.6.9A.12A)
// Pendente ≠ confirmação. Somente CONFIRMED entra na fachada.
// ======================================================================

import { isAsaasPaymentConfirmedStatus } from "./billingSubscriptionActivationService.js";

/** Eventos / status que NÃO quitam competência. */
export const BILLING_PENDING_FINANCIAL_EVENTS = Object.freeze([
  "PAYMENT_CREATED",
  "PAYMENT_PENDING",
  "AWAITING_PAYMENT",
  "PIX_CREATED",
  "BOLETO_CREATED",
  "CHECKOUT_OPENED",
  "CARD_TOKENIZED",
  "CARD_PROCESSING",
  "PAYMENT_OVERDUE",
  "PAYMENT_UPDATED",
  "PAYMENT_DELETED",
  "PAYMENT_BANK_SLIP_VIEWED",
  "PAYMENT_CHECKOUT_VIEWED",
]);

/** Eventos oficiais de confirmação financeira. */
export const BILLING_CONFIRMED_FINANCIAL_EVENTS = Object.freeze([
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
]);

/**
 * @param {unknown} eventType
 * @param {unknown} paymentStatus
 */
export function classifyFinancialPaymentEvent(eventType, paymentStatus) {
  const event = String(eventType ?? "")
    .trim()
    .toUpperCase();
  const status = String(paymentStatus ?? "")
    .trim()
    .toUpperCase();

  if (BILLING_CONFIRMED_FINANCIAL_EVENTS.includes(event) || isAsaasPaymentConfirmedStatus(status)) {
    return {
      class: /** @type {const} */ ("CONFIRMED"),
      may_enter_confirm_facade: true,
      may_quit_competence: true,
      may_reactivate: true,
      may_advance_period: false, // só a fachada decide (early vs activate)
      event,
      status,
    };
  }

  if (BILLING_PENDING_FINANCIAL_EVENTS.includes(event) || status === "PENDING" || status === "AWAITING_PAYMENT") {
    return {
      class: /** @type {const} */ ("PENDING"),
      may_enter_confirm_facade: false,
      may_quit_competence: false,
      may_reactivate: false,
      may_advance_period: false,
      event,
      status,
    };
  }

  return {
    class: /** @type {const} */ ("OTHER"),
    may_enter_confirm_facade: false,
    may_quit_competence: false,
    may_reactivate: false,
    may_advance_period: false,
    event,
    status,
  };
}
