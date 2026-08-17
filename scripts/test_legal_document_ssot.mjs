#!/usr/bin/env node
/**
 * LEGAL.DOCUMENT.SSOT.01 — catálogo backend é autoridade única (Terms + Privacy).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePendingBirthPayload } from "../src/signup/domain/signupPendingBirthValidation.js";
import {
  obterCatalogoTermosUso,
  obterCatalogoPoliticaPrivacidade,
  obterCatalogoDocumentoLegal,
  listarTiposDocumentosLegaisPublicos,
  montarTermosUsoPayloadCanonico,
  montarPoliticaPrivacidadePayloadCanonico,
  TERMOS_USO_HASH_CONTEUDO,
  POLITICA_PRIVACIDADE_HASH_CONTEUDO,
} from "../src/legal/domain/catalogoDocumentosLegais.js";
import { CANAL_CONTATO_OFICIAL_SUSE7 } from "../src/legal/domain/contatoInstitucionalSuse7.js";
import { DPO_STATUS } from "../src/legal/domain/identidadeInstitucionalPendente.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const feRoot = join(__dirname, "../../suse7-frontend/src");
const feTermosDoc = readFileSync(join(feRoot, "domain/legal/termosUsoDocumento.js"), "utf8");
const fePrivDoc = readFileSync(join(feRoot, "domain/legal/privacidadeDocumento.js"), "utf8");
const feTermsContent = readFileSync(join(feRoot, "components/legal/TermsDocumentContent.jsx"), "utf8");
const fePrivacyContent = readFileSync(join(feRoot, "components/legal/PrivacyDocumentContent.jsx"), "utf8");
const feCatalogApi = readFileSync(join(feRoot, "services/legalDocumentCatalogApi.js"), "utf8");

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const catalogTerms = obterCatalogoTermosUso();
const catalogPrivacy = obterCatalogoPoliticaPrivacidade();
const payloadTerms = montarTermosUsoPayloadCanonico();
const payloadPrivacy = montarPoliticaPrivacidadePayloadCanonico();
const hashTerms = createHash("sha256").update(JSON.stringify(payloadTerms)).digest("hex");
const hashPrivacy = createHash("sha256").update(JSON.stringify(payloadPrivacy)).digest("hex");

assert("terms catalog hash matches computed payload", catalogTerms.document_hash === hashTerms);
assert("terms catalog hash constant stable", catalogTerms.document_hash === TERMOS_USO_HASH_CONTEUDO);
assert("privacy catalog hash matches computed payload", catalogPrivacy.document_hash === hashPrivacy);
assert("privacy catalog hash constant stable", catalogPrivacy.document_hash === POLITICA_PRIVACIDADE_HASH_CONTEUDO);

assert("frontend terms no manual version constant", !/export const TERMOS_USO_VERSAO_ID =/.test(feTermosDoc));
assert("frontend terms no manual hash constant", !/export const TERMOS_USO_HASH_CONTEUDO =/.test(feTermosDoc));
assert("frontend privacy no manual version constant", !/export const PRIVACIDADE_VERSAO_ID =/.test(fePrivDoc));
assert("frontend privacy no manual hash constant", !/export const PRIVACIDADE_HASH_CONTEUDO =/.test(fePrivDoc));
assert("frontend privacy no local blocks export", !/PRIVACIDADE_BLOCOS_PROVISORIO/.test(fePrivDoc));

assert("catalog registry supports generic lookup", typeof obterCatalogoDocumentoLegal === "function");
assert("catalog lists both public document types", listarTiposDocumentosLegaisPublicos().sort().join() === "PRIVACY_POLICY,TERMS_OF_USE");
assert("privacy catalog registered", obterCatalogoDocumentoLegal("PRIVACY_POLICY") !== null);
assert("terms catalog registered", obterCatalogoDocumentoLegal("TERMS_OF_USE") !== null);

assert("frontend terms consumes catalog hook", /useTermosUsoCatalogo/.test(feTermsContent));
assert("frontend privacy consumes catalog hook", /usePoliticaPrivacidadeCatalogo/.test(fePrivacyContent));
assert("catalog api supports privacy route", /privacy-policy/.test(feCatalogApi));
assert("catalog api supports generic document fetch", /buscarCatalogoDocumentoLegal/.test(feCatalogApi));

const privacyText = payloadPrivacy.content;
assert("privacy channel official email", privacyText.includes(CANAL_CONTATO_OFICIAL_SUSE7));
assert("privacy email placeholders removed", !/\[E-MAIL DE PRIVACIDADE/.test(privacyText));
assert("privacy identity placeholders pending", /\[RAZÃO SOCIAL\]/.test(privacyText) && /\[CNPJ\]/.test(privacyText) && /\[ENDEREÇO\]/.test(privacyText));
assert("privacy dpo placeholder conditional", /\[PREENCHER, SE APLICÁVEL\]/.test(privacyText));
assert("dpo status contract", DPO_STATUS === "TO_BE_DETERMINED_IF_APPLICABLE");

const valid = validatePendingBirthPayload({
  email: "ssot@teste.local",
  nome: "Empresa SSOT",
  nome_loja: "Loja SSOT",
  whatsapp: "11999998888",
  cpf_cnpj: "11222333000181",
  terms: {
    document_type: catalogTerms.document_type,
    document_version: catalogTerms.document_version,
    document_hash: catalogTerms.document_hash,
    accepted_at: new Date().toISOString(),
    source: "SIGNUP",
    scrolled_to_end: true,
  },
});
assert("catalog metadata accepted by signup validation", valid.ok === true);

const stale = validatePendingBirthPayload({
  email: "ssot@teste.local",
  nome: "Empresa SSOT",
  nome_loja: "Loja SSOT",
  whatsapp: "11999998888",
  cpf_cnpj: "11222333000181",
  terms: {
    document_type: catalogTerms.document_type,
    document_version: "2025-11-27-v1",
    document_hash: catalogTerms.document_hash,
    accepted_at: new Date().toISOString(),
    source: "SIGNUP",
    scrolled_to_end: true,
  },
});
assert("stale version still rejected fail-closed", stale.ok === false && stale.code === "VERSION_MISMATCH");

if (failures.length) {
  console.error("FAIL", failures);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "legal_document_ssot",
      authority: "backend_catalog",
      legal_authority_count: 1,
      document_types: listarTiposDocumentosLegaisPublicos(),
      terms: {
        document_version: catalogTerms.document_version,
        document_hash: `${catalogTerms.document_hash.slice(0, 8)}…${catalogTerms.document_hash.slice(-8)}`,
      },
      privacy: {
        document_version: catalogPrivacy.document_version,
        document_hash: `${catalogPrivacy.document_hash.slice(0, 8)}…${catalogPrivacy.document_hash.slice(-8)}`,
        privacy_channel: CANAL_CONTATO_OFICIAL_SUSE7,
      },
    },
    null,
    2
  )
);
