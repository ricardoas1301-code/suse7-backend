// ======================================================================

// Cartão — tokenização Asaas + persistência segura local

// ======================================================================



import { logBilling, logBillingError } from "../billingLog.js";

import { sanitizeBillingCardPayload, maskCardNumberForLog } from "../utils/billingCardSanitize.js";

import {

  cardTypeFromPaymentMethodRow,

  normalizePersistedCardType,

  supportsAutoRenewFromPaymentMethodRow,

} from "../utils/billingCardType.js";

import {

  buildAsaasCreditCardHolderInfo,

  buildAsaasCreditCardPayload,

  resolveCardHolderSupplement,

} from "../utils/billingCardHolderInfo.js";

import { ensureBillingCustomerForUser } from "./billingCustomerService.js";

import {

  getSellerPaymentMethodById,

  insertSellerCardPaymentMethod,

} from "./billingPaymentMethodsService.js";



/**

 * @param {unknown} tokenResponse

 */

function pickTokenizeResponse(tokenResponse) {

  const row = tokenResponse && typeof tokenResponse === "object" ? /** @type {Record<string, unknown>} */ (tokenResponse) : null;

  if (!row) return null;

  const token = typeof row.creditCardToken === "string" ? row.creditCardToken.trim() : null;

  if (!token) return null;

  return {

    creditCardToken: token,

    brand: typeof row.creditCardBrand === "string" ? row.creditCardBrand.trim() : null,

    last4: typeof row.creditCardNumber === "string" ? row.creditCardNumber.trim() : null,

  };

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi

 * @param {{ id: string; email?: string | null; user_metadata?: Record<string, unknown> }} user

 * @param {{

 *   holder_name: string;

 *   card_number: string;

 *   expiry_month: string;

 *   expiry_year: string;

 *   cvv: string;

 *   cpf_cnpj?: string;

 *   postal_code?: string;

 *   address_number?: string;

 *   phone?: string;

 *   card_type?: string;

 *   set_default?: boolean;

 *   persist?: boolean;

 * }} body

 * @param {string} remoteIp
 * @param {{ user_id?: string; plan_key?: string; card_type?: string; request_id?: string }} [audit]
 */

export async function tokenizeAndPersistSellerCard(supabase, providerApi, user, body, remoteIp, audit = {}) {

  providerApi.assertConfigured();

  const customer = await ensureBillingCustomerForUser(supabase, providerApi, "asaas", user);

  const cardType = normalizePersistedCardType(body.card_type);

  const shouldPersist = body.persist !== false;



  const creditCard = buildAsaasCreditCardPayload(body);

  const holderAudit = {
    user_id: audit.user_id ?? user.id,
    plan_key: audit.plan_key,
    card_type: audit.card_type ?? cardType,
    request_id: audit.request_id,
  };

  const supplement = await resolveCardHolderSupplement(
    supabase,
    user,
    {
      cpf_cnpj: body.cpf_cnpj,
      postal_code: body.postal_code,
      cep: body.cep,
      phone: body.phone,
      address_number: body.address_number,
    },
    holderAudit
  );

  const creditCardHolderInfo = buildAsaasCreditCardHolderInfo({
    user,
    holderName: creditCard.holderName,
    cpfCnpj: supplement.cpfCnpj,
    remoteIp,
    postalCode: supplement.postalCode,
    addressNumber: supplement.addressNumber,
    phone: supplement.phone,
    audit: {
      ...holderAudit,
      postal_code_source: supplement.postalCodeSource ?? null,
    },
  });



  logBilling("billing", "BILLING_CARD_PAYMENT_METHOD_CREATE", {

    user_id: user.id,

    card_type: cardType,

    last4: maskCardNumberForLog(creditCard.number),

    persist: shouldPersist,

    set_default: Boolean(body.set_default),

  });



  let tokenResponse;

  try {

    tokenResponse = await providerApi.tokenizeCreditCard({

      customer: customer.provider_customer_id,

      creditCard: {

        holderName: creditCard.holderName,

        number: creditCard.number,

        expiryMonth: creditCard.expiryMonth,

        expiryYear: creditCard.expiryYear,

        ccv: creditCard.ccv,

      },

      creditCardHolderInfo,

      remoteIp,

    });

  } catch (error) {

    logBillingError("billing", "BILLING_CARD_PAYMENT_METHOD_CREATE_FAILED", error, {

      user_id: user.id,

      card_type: cardType,

      last4: maskCardNumberForLog(creditCard.number),

    });

    throw error;

  }



  const parsed = pickTokenizeResponse(tokenResponse);

  if (!parsed) {

    const err = new Error("Token do cartão indisponível no provedor.");

    /** @type {any} */ (err).code = "CARD_TOKEN_UNAVAILABLE";

    throw err;

  }



  let saved = null;

  if (shouldPersist) {

    saved = await insertSellerCardPaymentMethod(supabase, {

      userId: user.id,

      asaasCustomerId: customer.provider_customer_id,

      gatewayPaymentMethodId: parsed.creditCardToken,

      brand: parsed.brand,

      last4: parsed.last4 || creditCard.number.slice(-4),

      holderName: creditCard.holderName,

      expirationMonth: creditCard.expiryMonth,

      expirationYear: creditCard.expiryYear,

      cardType,

      setDefault: body.set_default !== false,

      rawPayload: sanitizeBillingCardPayload(tokenResponse),

    });

  }



  return { creditCardToken: parsed.creditCardToken, paymentMethod: saved, customer };

}



/**

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {import("../providers/BillingProvider.js").BillingProvider} providerApi

 * @param {{ id: string; email?: string | null; user_metadata?: Record<string, unknown> }} user

 * @param {{

 *   payment_method_id?: string | null;

 *   card?: Record<string, unknown> | null;

 *   card_type?: string;

 *   cpf_cnpj?: string;

 *   postal_code?: string;

 *   address_number?: string;

 *   phone?: string;

 *   set_default?: boolean;

 *   persist?: boolean;

 *   expectedCardType?: "CREDIT" | "DEBIT" | "credit" | "debit" | string;

 *   requireAutoRenew?: boolean;
 *   audit?: { user_id?: string; plan_key?: string; card_type?: string; request_id?: string };
 * }} options

 * @param {string} remoteIp

 */

export async function resolveSellerCreditCardToken(supabase, providerApi, user, options, remoteIp) {

  const paymentMethodId =

    typeof options.payment_method_id === "string" ? options.payment_method_id.trim() : "";

  const expectedCardType =

    options.expectedCardType != null && String(options.expectedCardType).trim() !== ""

      ? normalizePersistedCardType(options.expectedCardType)

      : null;



  if (paymentMethodId) {

    const row = await getSellerPaymentMethodById(supabase, user.id, paymentMethodId);

    if (!row?.gateway_payment_method_id) {

      const err = new Error("PAYMENT_METHOD_NOT_FOUND");

      /** @type {any} */ (err).code = "PAYMENT_METHOD_NOT_FOUND";

      throw err;

    }



    const rowCardType = cardTypeFromPaymentMethodRow(/** @type {Record<string, unknown>} */ (row));

    if (expectedCardType && rowCardType !== expectedCardType) {

      const err = new Error("Este cartão salvo não corresponde ao tipo selecionado.");

      /** @type {any} */ (err).code = "CARD_TYPE_MISMATCH";

      throw err;

    }

    if (options.requireAutoRenew && !supportsAutoRenewFromPaymentMethodRow(/** @type {Record<string, unknown>} */ (row))) {

      const err = new Error("Cartão de débito não pode ser usado em cobrança recorrente automática.");

      /** @type {any} */ (err).code = "CARD_AUTO_RENEW_NOT_SUPPORTED";

      throw err;

    }



    const customer = await ensureBillingCustomerForUser(supabase, providerApi, "asaas", user);

    return {

      creditCardToken: String(row.gateway_payment_method_id),

      paymentMethod: null,

      customer,

    };

  }



  if (!options.card || typeof options.card !== "object") {

    const err = new Error("Informe payment_method_id ou card.");

    /** @type {any} */ (err).code = "CARD_PAYLOAD_REQUIRED";

    throw err;

  }



  const cardBody = /** @type {Record<string, unknown>} */ (options.card);

  const inlineCardType = normalizePersistedCardType(

    options.card_type ?? cardBody.card_type ?? (expectedCardType === "DEBIT" ? "DEBIT" : "CREDIT")

  );

  if (expectedCardType && inlineCardType !== expectedCardType) {

    const err = new Error("Tipo do cartão informado não corresponde ao checkout.");

    /** @type {any} */ (err).code = "CARD_TYPE_MISMATCH";

    throw err;

  }

  if (options.requireAutoRenew && inlineCardType === "DEBIT") {

    const err = new Error("Cartão de débito não pode ser usado em cobrança recorrente automática.");

    /** @type {any} */ (err).code = "CARD_AUTO_RENEW_NOT_SUPPORTED";

    throw err;

  }



  const result = await tokenizeAndPersistSellerCard(

    supabase,

    providerApi,

    user,

    {

      holder_name: String(cardBody.holder_name ?? cardBody.holderName ?? ""),

      card_number: String(cardBody.card_number ?? cardBody.cardNumber ?? ""),

      expiry_month: String(cardBody.expiry_month ?? cardBody.expiryMonth ?? ""),

      expiry_year: String(cardBody.expiry_year ?? cardBody.expiryYear ?? ""),

      cvv: String(cardBody.cvv ?? cardBody.ccv ?? ""),

      cpf_cnpj: options.cpf_cnpj,

      postal_code: options.postal_code,

      address_number: options.address_number,

      phone: options.phone,

      card_type: inlineCardType,

      set_default: options.set_default,

      persist: options.persist,

    },

    remoteIp,
    options.audit ?? {}
  );

  return result;

}


