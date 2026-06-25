// ======================================================================
// Cobrança pendente de checkout — action_type/label + payloads Pix/Boleto
// ======================================================================

import { PAYMENT_HISTORY_ACTION_TYPE } from "../billingConstants.js";
import { mapPublicBoletoFieldsFromStoredPayload, resolvePublicBoletoOfficialUrl } from "./billingBoletoPaymentPresentation.js";
import { fetchPixCheckoutPayload } from "./billingPixCheckoutService.js";
import { normalizeCheckoutPaymentMethod } from "./billingSubscriptionService.js";

const OPEN_PENDING_PAYMENT_STATUSES = new Set([
  "pending",
  "pendente",
  "awaiting_payment",
  "overdue",
  "vencido",
  "past_due",
]);

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
 * @param {Record<string, unknown>} pendingCheckout
 * @param {Record<string, unknown> | null} payRow
 */
export function resolvePendingCheckoutPaymentMethod(pendingCheckout, payRow) {
  const payload = readPayload(payRow?.raw_payload);
  const fromPayment =
    asTrimmedString(payload.billingType) ??
    asTrimmedString(payload.paymentMethod) ??
    asTrimmedString(payload.payment_method);
  const fromSub = asTrimmedString(pendingCheckout.payment_method);
  return normalizeCheckoutPaymentMethod(fromPayment ?? fromSub ?? "BOLETO");
}

/**
 * @param {string} status
 * @param {string} paymentMethod
 */
export function resolvePendingPaymentAction(status, paymentMethod) {
  const normalizedStatus = String(status || "").toLowerCase();
  const method = normalizeCheckoutPaymentMethod(paymentMethod);

  if (method === "PIX" && OPEN_PENDING_PAYMENT_STATUSES.has(normalizedStatus)) {
    return {
      action_type: PAYMENT_HISTORY_ACTION_TYPE.VIEW_PIX_QR,
      action_label: "Visualizar QR Code",
    };
  }

  if (method === "BOLETO" && OPEN_PENDING_PAYMENT_STATUSES.has(normalizedStatus)) {
    return {
      action_type: PAYMENT_HISTORY_ACTION_TYPE.VIEW_BOLETO,
      action_label: "Abrir boleto",
    };
  }

  if (method === "CREDIT_CARD") {
    if (["failed", "chargeback", "refused"].includes(normalizedStatus)) {
      return {
        action_type: PAYMENT_HISTORY_ACTION_TYPE.UPDATE_CARD,
        action_label: "Atualizar cartão",
      };
    }
    if (OPEN_PENDING_PAYMENT_STATUSES.has(normalizedStatus)) {
      return {
        action_type: PAYMENT_HISTORY_ACTION_TYPE.WAITING_CARD_CONFIRMATION,
        action_label: "Aguardando confirmação",
      };
    }
  }

  return {
    action_type: PAYMENT_HISTORY_ACTION_TYPE.NONE,
    action_label: null,
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {import("../providers/BillingProvider.js").BillingProvider | null} providerApi
 * @param {Record<string, unknown>} pendingCheckout
 */
export async function findPendingCheckoutPaymentRow(supabase, pendingCheckout) {
  const subscriptionId = asTrimmedString(pendingCheckout.subscription_id);
  if (!subscriptionId) return null;

  const { data, error } = await supabase
    .from("billing_payments")
    .select("id, provider_payment_id, status, amount, currency, created_at, raw_payload")
    .eq("subscription_id", subscriptionId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;

  for (const row of data ?? []) {
    const status = String(row.status || "").toLowerCase();
    if (OPEN_PENDING_PAYMENT_STATUSES.has(status)) {
      return /** @type {Record<string, unknown>} */ (row);
    }
  }

  return null;
}

/**
 * @param {import("../providers/BillingProvider.js").BillingProvider | null} providerApi
 * @param {Record<string, unknown>} pendingCheckout
 * @param {Record<string, unknown> | null} payRow
 */
export async function buildPendingPaymentPresentation(providerApi, pendingCheckout, payRow) {
  if (!payRow?.provider_payment_id) {
    const method = resolvePendingCheckoutPaymentMethod(pendingCheckout, null);
    const action = resolvePendingPaymentAction("pending", method);
    return {
      pending_payment_id: null,
      pending_payment_method: method,
      provider_payment_id: null,
      status: "pending",
      amount: pendingCheckout.amount ?? null,
      due_date: pendingCheckout.next_due_date ?? null,
      ...action,
      can_open: false,
      open_error_message: "Não foi possível carregar os dados deste pagamento. Tente atualizar o status.",
    };
  }

  const payload = readPayload(payRow.raw_payload);
  const paymentMethod = resolvePendingCheckoutPaymentMethod(pendingCheckout, payRow);
  const status = String(payRow.status || "pending").toLowerCase();
  const action = resolvePendingPaymentAction(status, paymentMethod);
  const boletoFields = mapPublicBoletoFieldsFromStoredPayload(payRow.raw_payload);

  /** @type {Record<string, unknown>} */
  const presentation = {
    id: payRow.id != null ? String(payRow.id) : null,
    pending_payment_id: payRow.id != null ? String(payRow.id) : null,
    pending_payment_method: paymentMethod,
    payment_method: paymentMethod,
    billing_type: paymentMethod,
    provider_payment_id: String(payRow.provider_payment_id),
    status,
    amount: payRow.amount ?? pendingCheckout.amount ?? null,
    value: payRow.amount ?? pendingCheckout.amount ?? null,
    due_date:
      asTrimmedString(payload.dueDate) ??
      asTrimmedString(payload.originalDueDate) ??
      asTrimmedString(pendingCheckout.next_due_date),
    ...action,
    bank_slip_url: boletoFields.bank_slip_url,
    invoice_url: boletoFields.invoice_url,
    identification_field: boletoFields.identification_field,
    boleto_url: resolvePublicBoletoOfficialUrl(boletoFields.bank_slip_url, boletoFields.invoice_url),
    pix_qr_code: null,
    pix_copy_paste: null,
    can_open: false,
    open_error_message: null,
  };

  if (action.action_type === PAYMENT_HISTORY_ACTION_TYPE.VIEW_PIX_QR && providerApi) {
    const pix = await fetchPixCheckoutPayload(providerApi, String(payRow.provider_payment_id));
    if (pix) {
      presentation.pix_qr_code = pix.qr_code_image ?? null;
      presentation.pix_copy_paste = pix.copy_paste_code ?? null;
      presentation.can_open = Boolean(pix.qr_code_image || pix.copy_paste_code);
    }
    if (!presentation.can_open) {
      presentation.open_error_message =
        "Não foi possível carregar os dados deste pagamento. Tente atualizar o status.";
    } else {
      presentation.can_open = true;
    }
  }

  if (action.action_type === PAYMENT_HISTORY_ACTION_TYPE.VIEW_BOLETO) {
    presentation.can_open = Boolean(presentation.boleto_url || presentation.identification_field);
    if (!presentation.can_open) {
      presentation.open_error_message =
        "Não foi possível carregar os dados deste pagamento. Tente atualizar o status.";
    }
  }

  if (action.action_type === PAYMENT_HISTORY_ACTION_TYPE.WAITING_CARD_CONFIRMATION) {
    presentation.can_open = false;
  }

  if (action.action_type === PAYMENT_HISTORY_ACTION_TYPE.UPDATE_CARD) {
    presentation.can_open = true;
  }

  return presentation;
}
