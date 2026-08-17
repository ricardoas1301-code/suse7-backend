// ======================================================================
// Campos públicos de boleto — sem expor payload bruto do Asaas
// ======================================================================

/**
 * @param {unknown} value
 */
function asTrimmedString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} value
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} payment
 */
export function mapPublicBoletoFieldsFromAsaasPayment(payment) {
  const row = asObject(payment);
  if (!row) {
    return {
      bank_slip_url: null,
      invoice_url: null,
      identification_field: null,
    };
  }

  const bankSlipUrl = asTrimmedString(row.bankSlipUrl) ?? asTrimmedString(row.bank_slip_url);
  const invoiceUrl = asTrimmedString(row.invoiceUrl) ?? asTrimmedString(row.invoice_url);
  const identificationField =
    asTrimmedString(row.identificationField) ??
    asTrimmedString(row.bankSlipIdentificationField) ??
    asTrimmedString(row.identification_field) ??
    asTrimmedString(row.linhaDigitavel);

  return {
    bank_slip_url: bankSlipUrl,
    invoice_url: invoiceUrl,
    identification_field: identificationField,
  };
}

/**
 * @param {unknown} rawPayload
 */
export function mapPublicBoletoFieldsFromStoredPayload(rawPayload) {
  return mapPublicBoletoFieldsFromAsaasPayment(asObject(rawPayload));
}

/**
 * @param {string | null | undefined} bankSlipUrl
 * @param {string | null | undefined} invoiceUrl
 */
export function resolvePublicBoletoOfficialUrl(bankSlipUrl, invoiceUrl) {
  return asTrimmedString(bankSlipUrl) ?? asTrimmedString(invoiceUrl) ?? null;
}

/**
 * @param {string | null | undefined} url
 */
export function inferBillingSandboxFromUrl(url) {
  const value = asTrimmedString(url);
  if (!value) return false;
  const lower = value.toLowerCase();
  return lower.includes("sandbox.asaas.com") || lower.includes("api-sandbox.asaas.com");
}
