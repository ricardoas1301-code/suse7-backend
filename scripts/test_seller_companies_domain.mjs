#!/usr/bin/env node
/**
 * Domínio seller_companies — normalização, create validation, round-trip de campos.
 */
import {
  buildSellerCompanyWritableFields,
  normalizeSellerCompanyPercentDecimal,
  resolveAuthenticatedContactEmail,
  validateSellerCompanyConfigurationOnboardingCreateBody,
  validateSellerCompanyCreateBody,
} from "../src/domain/seller/sellerCompanyRecord.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert("percent 9,00", normalizeSellerCompanyPercentDecimal("9,00") === "9.00");
assert("percent 1.33", normalizeSellerCompanyPercentDecimal("1.33") === "1.33");
assert("percent 12,50 %", normalizeSellerCompanyPercentDecimal("12,50 %") === "12.50");
assert("percent zero", normalizeSellerCompanyPercentDecimal("0,00") === "0.00");
assert("percent rejects invalid", normalizeSellerCompanyPercentDecimal("abc") === null);

const fullBody = {
  company_name: "Empresa Teste",
  trade_name: "Fantasia Teste",
  document_cnpj: "62194333000156",
  default_tax_rate: "9,00",
  operational_cost_rate: "1,33",
  contact_email: "empresa.teste@suse7.local",
  phone: "(17) 99999-8888",
  whatsapp: "(17) 98888-7777",
  cep: "15025-055",
  address_street: "Rua Teste",
  address_number: "3333",
  address_complement: "Sala 1",
  address_district: "Centro",
  address_city: "São José do Rio Preto",
  address_state: "sp",
  logo_url: "https://example.com/logo.png",
};

const writable = buildSellerCompanyWritableFields(fullBody);
assert("writable email", writable.contact_email === "empresa.teste@suse7.local");
assert("writable tax", writable.default_tax_rate === "9.00");
assert("writable op cost", writable.operational_cost_rate === "1.33");
assert("writable cep digits", writable.cep === "15025055");
assert("writable uf upper", writable.address_state === "SP");
assert("writable number", writable.address_number === "3333");

const createOk = validateSellerCompanyCreateBody(fullBody);
assert("create validation ok", createOk.ok === true);

const createMissingEmail = validateSellerCompanyCreateBody({ ...fullBody, contact_email: "" });
assert("create missing email", createMissingEmail.ok === false);

const onboardingBody = {
  company_name: "Empresa Teste",
  trade_name: "Fantasia Teste",
  document_cnpj: "62194333000156",
  contact_email: "seller@real.com",
  whatsapp: "17999998888",
};
const onboardingOk = validateSellerCompanyConfigurationOnboardingCreateBody(onboardingBody);
assert("onboarding create ok", onboardingOk.ok === true);

const onboardingMissingTax = validateSellerCompanyConfigurationOnboardingCreateBody({
  ...onboardingBody,
  default_tax_rate: undefined,
});
assert("onboarding create sem tax/cep ok", onboardingMissingTax.ok === true);

const emailOk = resolveAuthenticatedContactEmail("seller@real.com", "seller@real.com");
assert("email auth match", emailOk.ok === true && emailOk.email === "seller@real.com");

const emailMismatch = resolveAuthenticatedContactEmail("seller@real.com", "atacante@fake.com");
assert("email adulterado bloqueado", emailMismatch.ok === false && emailMismatch.code === "CONTACT_EMAIL_MISMATCH");

const emailCanonical = resolveAuthenticatedContactEmail("Seller@Real.com", null);
assert("email canônico da sessão", emailCanonical.ok === true && emailCanonical.email === "seller@real.com");

const patchBody = buildSellerCompanyWritableFields({ address_number: "3333", default_tax_rate: "9,00" });
assert("patch partial number", patchBody.address_number === "3333");
assert("patch partial tax", patchBody.default_tax_rate === "9.00");
assert("patch no email key", !Object.prototype.hasOwnProperty.call(patchBody, "contact_email"));

if (failures.length) {
  console.error("[seller-companies domain] FAIL", failures);
  process.exit(1);
}

console.log("[seller-companies domain] OK");
