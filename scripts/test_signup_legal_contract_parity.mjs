#!/usr/bin/env node
/**
 * DEV.V2.SECOND-SIGNUP-LEGAL-CONTRACT-MISMATCH.22B
 * Garante paridade FE/BE do contrato jurídico usado no signup pending-birth.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePendingBirthPayload } from "../src/signup/domain/signupPendingBirthValidation.js";
import {
  TERMOS_USO_HASH_CONTEUDO as BE_HASH,
  TERMOS_USO_TIPO_DOCUMENTO as BE_TYPE,
  TERMOS_USO_VERSAO_ID as BE_VERSION,
} from "../src/legal/domain/documentosLegaisCanonicos.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FE_ROOT = join(__dirname, "../../suse7-frontend");

const feMod = await import(
  pathToFileURL(join(FE_ROOT, "src/domain/legal/termosUsoDocumento.js")).href
);

const fePayload = feMod.montarTermosUsoPayloadCanonico();
const feComputedHash = createHash("sha256").update(JSON.stringify(fePayload)).digest("hex");

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

assert("frontend hash constant matches canonical payload", feMod.TERMOS_USO_HASH_CONTEUDO === feComputedHash);
assert("frontend/backend document_type match", feMod.TERMOS_USO_TIPO_DOCUMENTO === BE_TYPE);
assert("frontend/backend document_version match", feMod.TERMOS_USO_VERSAO_ID === BE_VERSION);
assert("frontend/backend document_hash match", feMod.TERMOS_USO_HASH_CONTEUDO === BE_HASH);

const baseBody = {
  email: "contrato.parity@teste.local",
  nome: "Empresa Contrato LTDA",
  nome_loja: "Loja Contrato",
  whatsapp: "11999998888",
  cpf_cnpj: "11222333000181",
};

const validTerms = {
  document_type: feMod.TERMOS_USO_TIPO_DOCUMENTO,
  document_version: feMod.TERMOS_USO_VERSAO_ID,
  document_hash: feMod.TERMOS_USO_HASH_CONTEUDO,
  accepted_at: new Date().toISOString(),
  source: "SIGNUP",
  scrolled_to_end: true,
};

const valid = validatePendingBirthPayload({ ...baseBody, terms: validTerms });
assert("valid frontend terms payload passes backend validation", valid.ok === true);

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
      frontend: {
        document_type: feMod.TERMOS_USO_TIPO_DOCUMENTO,
        document_version: feMod.TERMOS_USO_VERSAO_ID,
        document_hash: `${feMod.TERMOS_USO_HASH_CONTEUDO.slice(0, 8)}…${feMod.TERMOS_USO_HASH_CONTEUDO.slice(-8)}`,
      },
      backend: {
        document_type: BE_TYPE,
        document_version: BE_VERSION,
        document_hash: `${BE_HASH.slice(0, 8)}…${BE_HASH.slice(-8)}`,
      },
    },
    null,
    2
  )
);
