// ======================================================================
// Checkout Pix — QR Code e copia e cola (sem expor checkout público Asaas)
// ======================================================================

import { logBilling, logBillingError } from "../billingLog.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {string} providerPaymentId
 */
export async function fetchPixCheckoutPayload(providerApi, providerPaymentId) {
  if (!providerPaymentId || typeof providerApi.getPaymentPixQrCode !== "function") {
    return null;
  }

  try {
    const qr = await providerApi.getPaymentPixQrCode(providerPaymentId);
    if (!qr || typeof qr !== "object") return null;

    const row = /** @type {Record<string, unknown>} */ (qr);
    const copyPaste = asTrimmedString(row.payload) ?? asTrimmedString(row.pixCopiaECola);
    const qrImage = asTrimmedString(row.encodedImage);
    const expirationDate = asTrimmedString(row.expirationDate);

    if (!copyPaste && !qrImage) return null;

    return {
      qr_code_image: qrImage,
      copy_paste_code: copyPaste,
      expiration_date: expirationDate,
    };
  } catch (error) {
    logBillingError("billing", "pix_qr_fetch_failed", error, { provider_payment_id: providerPaymentId });
    return null;
  }
}

/**
 * Pontos de evento futuros (motor de notificações).
 * @param {string} eventName
 * @param {Record<string, unknown>} payload
 */
export function emitBillingCommunicationPlaceholder(eventName, payload) {
  logBilling("billing", "communication_placeholder", { event: eventName, ...payload });
  // TODO(billing-comms): billing.pix_created | billing.payment_confirmed | billing.subscription_activated
}
