#!/usr/bin/env node
/**
 * Prova de paridade de conteúdo — Política de Privacidade (promoção FE → BE).
 * Permite SOMENTE substituição autorizada dos placeholders de e-mail de privacidade.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  montarTextoCanonicoDocumentoLegal,
  obterCatalogoPoliticaPrivacidade,
} from "../src/legal/domain/catalogoDocumentosLegais.js";
import { CANAL_CONTATO_OFICIAL_SUSE7 } from "../src/legal/domain/contatoInstitucionalSuse7.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const parentFeCommit = "6e6b92b182a89b56f4b53a2b48b97b8fa466b4c7";

const feBlocksSource = execSync(
  `git -C "${path.join(repoRoot, "../suse7-frontend")}" show ${parentFeCommit}:src/domain/legal/privacidadeBlocosProvisorio20260813.js`,
  { encoding: "utf8" },
);

function aplicarSubstituicoesCanalPrivacidade(texto) {
  return texto
    .replace(/\[E-MAIL DE PRIVACIDADE DO SUSE7\]/g, CANAL_CONTATO_OFICIAL_SUSE7)
    .replace(/\[E-MAIL DE PRIVACIDADE\]/g, CANAL_CONTATO_OFICIAL_SUSE7);
}

const feBlocksMatch = feBlocksSource.match(/export const PRIVACIDADE_BLOCOS_PROVISORIO_20260813 = (\[[\s\S]*?\n\]);/);
assert.ok(feBlocksMatch, "blocos FE homologados não encontrados no commit 6e6b92b");

/** @type {readonly object[]} */
const feBlocks = Function(`"use strict"; return (${feBlocksMatch[1]});`)();

const textoAntes = aplicarSubstituicoesCanalPrivacidade(montarTextoCanonicoDocumentoLegal(feBlocks));
const catalog = obterCatalogoPoliticaPrivacidade();
const textoDepois = montarTextoCanonicoDocumentoLegal(catalog.blocks);

assert.equal(textoAntes, textoDepois, "PRIVACY_CONTENT_DRIFT");

assert.doesNotMatch(textoDepois, /\[E-MAIL DE PRIVACIDADE/);
assert.match(textoDepois, /contato@suse7\.com\.br/);

console.log(
  JSON.stringify(
    {
      pass: true,
      test: "legal_privacy_content_parity",
      privacy_content_drift: 0,
      privacy_channel: CANAL_CONTATO_OFICIAL_SUSE7,
      document_version: catalog.document_version,
      document_hash: `${catalog.document_hash.slice(0, 8)}…${catalog.document_hash.slice(-8)}`,
    },
    null,
    2,
  ),
);
