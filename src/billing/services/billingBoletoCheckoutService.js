// ======================================================================
// Checkout boleto — linha digitável e links (sem expor payload bruto)
// ======================================================================

import { logBillingError } from "../billingLog.js";
import { mapPublicBoletoFieldsFromAsaasPayment } from "./billingBoletoPaymentPresentation.js";

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} identificationResponse
 */
function pickIdentificationFieldFromAsaasResponse(identificationResponse) {
  const row =
    identificationResponse && typeof identificationResponse === "object"
      ? /** @type {Record<string, unknown>} */ (identificationResponse)
      : null;
  if (!row) return null;
  return (
    asTrimmedString(row.identificationField) ??
    asTrimmedString(row.identification_field) ??
    asTrimmedString(row.barCode) ??
    asTrimmedString(row.digitableLine)
  );
}

/**
 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi
 * @param {string} providerPaymentId
 */
export async function fetchBoletoCheckoutPayload(providerApi, providerPaymentId) {
  if (!providerPaymentId) return null;

  try {
    /** @type {{ bank_slip_url: string | null, invoice_url: string | null, identification_field: string | null }} */
    let fields = {
      bank_slip_url: null,
      invoice_url: null,
      identification_field: null,
    };

    if (typeof providerApi.getPayment === "function") {
      const payment = await providerApi.getPayment(providerPaymentId);
      fields = mapPublicBoletoFieldsFromAsaasPayment(payment);
    }

    if (!fields.identification_field && typeof providerApi.getPaymentIdentificationField === "function") {
      const identificationResponse = await providerApi.getPaymentIdentificationField(providerPaymentId);
      const code = pickIdentificationFieldFromAsaasResponse(identificationResponse);
      if (code) {
        fields = { ...fields, identification_field: code };
      }
    }

    if (!fields.identification_field && !fields.bank_slip_url && !fields.invoice_url) {
      return null;
    }

    return fields;
  } catch (error) {
    logBillingError("billing", "boleto_details_fetch_failed", error, {
      provider_payment_id: providerPaymentId,
    });
    return null;
  }
}
