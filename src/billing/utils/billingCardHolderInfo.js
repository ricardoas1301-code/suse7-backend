// ======================================================================

// creditCardHolderInfo — montagem segura para Asaas

// ======================================================================



import {

  assertValidCardHolderPostalCode,

  onlyDigits,

} from "./billingCardPostalCode.js";

import {

  loadSellerCompaniesForBillingAddress,

  logBillingCardPostalCodeResolved,

  resolveBillingPostalCodeForCard,

} from "./billingCardPostalCodeResolver.js";



/**

 * @param {unknown} value

 */

function asTrimmedString(value) {

  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;

}



/**

 * @param {unknown} value

 */

function digitsFrom(value) {

  const digits = onlyDigits(value);

  return digits.length > 0 ? digits : null;

}



/**

 * @param {Record<string, unknown> | null | undefined} company

 */

function addressNumberFromCompany(company) {

  if (!company) return null;

  return (

    asTrimmedString(company.address_number) ??

    asTrimmedString(company.numero) ??

    null

  );

}



/**

 * @param {Record<string, unknown> | null | undefined} company

 */

function phoneFromCompany(company) {

  if (!company) return null;

  return digitsFrom(company.telefone) ?? digitsFrom(company.phone) ?? digitsFrom(company.whatsapp) ?? null;

}



/**

 * Resolve CPF, CEP e telefone a partir do body, perfil, empresa principal e metadata.

 *

 * @param {import("@supabase/supabase-js").SupabaseClient} supabase

 * @param {{ id: string; email?: string | null; user_metadata?: Record<string, unknown> }} user

 * @param {{

 *   cpf_cnpj?: string;

 *   postal_code?: string;

 *   cep?: string;

 *   phone?: string;

 *   address_number?: string;

 * }} overrides

 * @param {{

 *   user_id?: string;

 *   plan_key?: string;

 *   card_type?: string;

 *   request_id?: string;

 * }} [audit]

 */

export async function resolveCardHolderSupplement(supabase, user, overrides = {}, audit = {}) {

  const metadata =

    user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};



  const { data: profile } = await supabase

    .from("profiles")

    .select("cpf_cnpj, cep, telefone, whatsapp, numero")

    .eq("id", user.id)

    .maybeSingle();



  const sellerCompanies = await loadSellerCompaniesForBillingAddress(supabase, user.id);



  const postalResolution = resolveBillingPostalCodeForCard({

    body: overrides,

    profile: profile ?? null,

    sellerCompanies,

    metadata,

  });



  logBillingCardPostalCodeResolved(

    {

      user_id: audit.user_id ?? user.id,

      plan_key: audit.plan_key,

      card_type: audit.card_type,

      request_id: audit.request_id,

    },

    postalResolution

  );



  const selectedCompany =

    postalResolution.selectedSellerCompanyId != null

      ? sellerCompanies.find((row) => String(row.id) === postalResolution.selectedSellerCompanyId) ?? null

      : null;



  const cpfCnpj =

    digitsFrom(overrides.cpf_cnpj) ??

    digitsFrom(profile?.cpf_cnpj) ??

    digitsFrom(metadata.cpf_cnpj) ??

    digitsFrom(metadata.document) ??

    "";



  const phone =

    digitsFrom(overrides.phone) ??

    digitsFrom(profile?.telefone) ??

    digitsFrom(profile?.whatsapp) ??

    phoneFromCompany(selectedCompany) ??

    digitsFrom(metadata.telefone) ??

    digitsFrom(metadata.whatsapp) ??

    "";



  const addressNumber =

    asTrimmedString(overrides.address_number) ??

    addressNumberFromCompany(selectedCompany) ??

    asTrimmedString(profile?.numero) ??

    asTrimmedString(metadata.numero) ??

    "S/N";



  return {

    cpfCnpj,

    phone,

    postalCode: postalResolution.postalCode,

    postalCodeSource: postalResolution.postalCodeSource,

    addressNumber,

  };

}



/**

 * @param {{

 *   user: { email?: string | null; user_metadata?: Record<string, unknown> };

 *   holderName: string;

 *   cpfCnpj: string;

 *   remoteIp: string;

 *   postalCode?: string | null;

 *   addressNumber?: string | null;

 *   addressComplement?: string | null;

 *   phone?: string | null;

 *   mobilePhone?: string | null;

 *   audit?: {

 *     user_id?: string;

 *     plan_key?: string;

 *     card_type?: string;

 *     request_id?: string;

 *     postal_code_source?: string | null;

 *   };

 * }} input

 */

export function buildAsaasCreditCardHolderInfo(input) {

  const cpfCnpj = onlyDigits(input.cpfCnpj);

  if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) {

    const err = new Error("CPF/CNPJ do titular é obrigatório e deve ser válido.");

    /** @type {any} */ (err).code = "CARD_HOLDER_TAX_ID_REQUIRED";

    throw err;

  }



  const email = asTrimmedString(input.user.email);

  if (!email) {

    const err = new Error("E-mail do usuário é obrigatório para pagamento com cartão.");

    /** @type {any} */ (err).code = "CARD_HOLDER_EMAIL_REQUIRED";

    throw err;

  }



  const phone = onlyDigits(input.phone || input.mobilePhone);

  if (phone.length < 10) {

    const err = new Error(

      "Complete o telefone no seu perfil Suse7 para pagar com cartão (Configurações → Perfil)."

    );

    /** @type {any} */ (err).code = "CARD_HOLDER_PHONE_REQUIRED";

    throw err;

  }



  const postalCode = assertValidCardHolderPostalCode(input.postalCode, {

    ...(input.audit ?? {}),

    postal_code_source: input.audit?.postal_code_source ?? null,

  });

  const addressNumber = asTrimmedString(input.addressNumber) || "S/N";



  return {

    name: input.holderName.trim(),

    email,

    cpfCnpj,

    postalCode,

    addressNumber,

    addressComplement: asTrimmedString(input.addressComplement) || undefined,

    phone,

    mobilePhone: onlyDigits(input.mobilePhone) || phone,

  };

}



/**

 * @param {unknown} cardInput

 */

export function buildAsaasCreditCardPayload(cardInput) {

  const row = cardInput && typeof cardInput === "object" ? /** @type {Record<string, unknown>} */ (cardInput) : null;

  if (!row) {

    const err = new Error("Dados do cartão são obrigatórios.");

    /** @type {any} */ (err).code = "CARD_PAYLOAD_REQUIRED";

    throw err;

  }



  const holderName = asTrimmedString(row.holder_name ?? row.holderName);

  const number = onlyDigits(row.card_number ?? row.cardNumber ?? row.number);

  const expiryMonth = onlyDigits(row.expiry_month ?? row.expiryMonth).padStart(2, "0").slice(-2);

  const expiryYearRaw = onlyDigits(row.expiry_year ?? row.expiryYear);

  const expiryYear = expiryYearRaw.length === 2 ? `20${expiryYearRaw}` : expiryYearRaw;

  const ccv = onlyDigits(row.cvv ?? row.ccv);



  if (!holderName || number.length < 13 || expiryMonth.length !== 2 || expiryYear.length !== 4 || ccv.length < 3) {

    const err = new Error("Preencha nome, número, validade e CVV do cartão.");

    /** @type {any} */ (err).code = "CARD_PAYLOAD_INVALID";

    throw err;

  }



  return {

    holderName,

    number,

    expiryMonth,

    expiryYear,

    ccv,

  };

}


