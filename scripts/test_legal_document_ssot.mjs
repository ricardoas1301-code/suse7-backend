#!/usr/bin/env node
/**
 * LEGAL.DOCUMENT.SSOT.01 — catálogo backend é autoridade única.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePendingBirthPayload } from "../src/signup/domain/signupPendingBirthValidation.js";
import {
  obterCatalogoTermosUso,
  obterCatalogoDocumentoLegal,
  listarTiposDocumentosLegaisPublicos,
  montarTermosUsoPayloadCanonico,
  TERMOS_USO_HASH_CONTEUDO,
} from "../src/legal/domain/catalogoDocumentosLegais.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const feTermosDoc = readFileSync(join(__dirname, "../../suse7-frontend/src/domain/legal/termosUsoDocumento.js"), "utf8");
const feBlocos = readFileSync(
  join(__dirname, "../../suse7-frontend/src/domain/legal/termosUsoBlocosProvisorio20260813.js"),
  "utf8"
);

/** @type {string[]} */
const failures = [];

function assert(name, cond) {
  if (!cond) failures.push(name);
}

const catalog = obterCatalogoTermosUso();
const payload = montarTermosUsoPayloadCanonico();
const computedHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

assert("catalog hash matches computed payload", catalog.document_hash === computedHash);
assert("catalog hash constant stable", catalog.document_hash === TERMOS_USO_HASH_CONTEUDO);
assert("frontend no longer exports manual version constant", !/export const TERMOS_USO_VERSAO_ID =/.test(feTermosDoc));
assert("frontend no longer exports manual hash constant", !/export const TERMOS_USO_HASH_CONTEUDO =/.test(feTermosDoc));
assert("catalog registry supports generic lookup", typeof obterCatalogoDocumentoLegal === "function");
assert("catalog lists public document types", Array.isArray(listarTiposDocumentosLegaisPublicos()));
assert("privacy not migrated yet returns null", obterCatalogoDocumentoLegal("PRIVACY_POLICY") === null);
assert("multi document ready architecture", listarTiposDocumentosLegaisPublicos().includes("TERMS_OF_USE"));
assert("frontend modal consumes catalog hook", /useTermosUsoCatalogo/.test(
  readFileSync(join(__dirname, "../../suse7-frontend/src/components/legal/TermsAcceptanceModal.jsx"), "utf8")
));

const valid = validatePendingBirthPayload({
  email: "ssot@teste.local",
  nome: "Empresa SSOT",
  nome_loja: "Loja SSOT",
  whatsapp: "11999998888",
  cpf_cnpj: "11222333000181",
  terms: {
    document_type: catalog.document_type,
    document_version: catalog.document_version,
    document_hash: catalog.document_hash,
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
    document_type: catalog.document_type,
    document_version: "2025-11-27-v1",
    document_hash: catalog.document_hash,
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
      document_type: catalog.document_type,
      document_version: catalog.document_version,
      document_hash: `${catalog.document_hash.slice(0, 8)}…${catalog.document_hash.slice(-8)}`,
      fe_blocks_still_present_for_render_only: /\[RAZÃO SOCIAL RESPONSÁVEL PELO SUSE7\]/.test(feBlocos),
    },
    null,
    2
  )
);
