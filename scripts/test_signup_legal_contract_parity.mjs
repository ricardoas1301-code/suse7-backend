#!/usr/bin/env node
/**
 * DEV.V2.SECOND-SIGNUP-LEGAL-CONTRACT-MISMATCH.22B (atualizado SSOT.01)
 * Garante paridade via catálogo backend — sem duplicar version/hash no FE.
 */
import { validatePendingBirthPayload } from "../src/signup/domain/signupPendingBirthValidation.js";
import { obterCatalogoTermosUso } from "../src/legal/domain/catalogoDocumentosLegais.js";

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const catalog = obterCatalogoTermosUso();

const baseBody = {
  email: "contrato.parity@teste.local",
  nome: "Empresa Contrato LTDA",
  nome_loja: "Loja Contrato",
  whatsapp: "11999998888",
  cpf_cnpj: "11222333000181",
};

const validTerms = {
  document_type: catalog.document_type,
  document_version: catalog.document_version,
  document_hash: catalog.document_hash,
  accepted_at: new Date().toISOString(),
  source: "SIGNUP",
  scrolled_to_end: true,
};

const valid = validatePendingBirthPayload({ ...baseBody, terms: validTerms });
assert("valid catalog terms payload passes backend validation", valid.ok === true);

const wrongVersion = validatePendingBirthPayload({
  ...baseBody,
  terms: { ...validTerms, document_version: "2025-11-27-v1" },
});
assert("stale version rejected", wrongVersion.ok === false && wrongVersion.code === "VERSION_MISMATCH");

const wrongHash = validatePendingBirthPayload({
  ...baseBody,
  terms: {
    ...validTerms,
    document_hash: "4969d335da583efffd42bfa5b57915d1512a6b1b46d9396195b58a3329fe2a97",
  },
});
assert("stale hash rejected", wrongHash.ok === false && wrongHash.code === "HASH_MISMATCH");

const wrongType = validatePendingBirthPayload({
  ...baseBody,
  terms: { ...validTerms, document_type: "PRIVACY_POLICY" },
});
assert("wrong document type rejected", wrongType.ok === false && wrongType.code === "UNKNOWN_DOCUMENT");

const noScroll = validatePendingBirthPayload({
  ...baseBody,
  terms: { ...validTerms, scrolled_to_end: false },
});
assert("scroll contract preserved", noScroll.ok === false && noScroll.code === "SCROLL_REQUIRED");

if (failures.length) {
  console.error("FAIL", failures);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "signup_legal_contract_parity",
      authority: "backend_catalog",
      document_type: catalog.document_type,
      document_version: catalog.document_version,
      document_hash: `${catalog.document_hash.slice(0, 8)}…${catalog.document_hash.slice(-8)}`,
    },
    null,
    2
  )
);
