// ======================================================================
// Mapeamento de erros Asaas → HTTP da API Suse7 (checkout/cartão)
// ======================================================================

import { AsaasApiError } from "../providers/AsaasBillingProvider.js";
import { INVALID_CARD_HOLDER_POSTAL_CODE_MESSAGE } from "./billingCardPostalCode.js";
import { summarizeAsaasErrorBody } from "../providers/asaasApiHelpers.js";

/**
 * @param {unknown} error
 */
export function classifyAsaasCheckoutFailure(error) {
  if (!(error instanceof AsaasApiError)) return null;

  const summary = summarizeAsaasErrorBody(error.body);
  const gatewayErrorCode = summary.errors[0]?.code ?? null;
  const gatewayMessage = summary.message ?? "";
  const gatewayMessageLower = String(gatewayMessage).toLowerCase();

  const isInvalidPostalHolder =
    gatewayErrorCode === "invalid_holderInfo" &&
    (gatewayMessageLower.includes("cep") || gatewayMessageLower.includes("postal"));

  if (error.status === 400 && isInvalidPostalHolder) {
    return {
      httpStatus: 400,
      code: "invalid_card_holder_postal_code",
      message: INVALID_CARD_HOLDER_POSTAL_CODE_MESSAGE,
      gateway_status: error.status,
      gateway_error_code: gatewayErrorCode,
      gateway_error_message: gatewayMessage,
    };
  }

  if (error.status === 400) {
    return {
      httpStatus: 400,
      code: gatewayErrorCode === "invalid_holderInfo" ? "ASAAS_HOLDER_INFO_INVALID" : "ASAAS_VALIDATION_ERROR",
      message: gatewayMessage || "Dados do titular ou do cartão inválidos no gateway.",
      gateway_status: error.status,
      gateway_error_code: gatewayErrorCode,
      gateway_error_message: gatewayMessage,
    };
  }

  if (error.status === 401 || error.status === 403) {
    return {
      httpStatus: 502,
      code: "ASAAS_AUTH_ERROR",
      message: "Falha ao comunicar com o gateway de pagamento.",
      gateway_status: error.status,
      gateway_error_code: gatewayErrorCode,
      gateway_error_message: gatewayMessage,
    };
  }

  if (error.status >= 500) {
    return {
      httpStatus: 502,
      code: "ASAAS_ERROR",
      message: "Falha ao comunicar com o gateway de pagamento.",
      gateway_status: error.status,
      gateway_error_code: gatewayErrorCode,
      gateway_error_message: gatewayMessage,
    };
  }

  return {
    httpStatus: 502,
    code: "ASAAS_ERROR",
    message: "Falha ao comunicar com o gateway de pagamento.",
    gateway_status: error.status,
    gateway_error_code: gatewayErrorCode,
    gateway_error_message: gatewayMessage,
  };
}
