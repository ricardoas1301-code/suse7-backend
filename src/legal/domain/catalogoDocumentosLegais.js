// ======================================================================
// Catálogo legal canônico — SSOT backend (LEGAL.DOCUMENT.SSOT.01)
// Registro genérico por document_type — extensível a PRIVACY_POLICY.
// ======================================================================

import { createHash } from "node:crypto";
import { TERMOS_USO_BLOCOS_CANONICOS } from "./termosUsoBlocosCanonicos.js";

export const TERMOS_USO_TIPO_DOCUMENTO = "TERMS_OF_USE";
export const TERMOS_USO_VERSAO_ID = "2026-08-13-v2-provisional";
export const TERMOS_USO_DATA_PUBLICACAO_ROTULO = "13 de agosto de 2026";
export const TERMOS_USO_TITULO_PAGINA = "Termos e Condições de Uso do SUSE7";
export const TERMOS_USO_TITULO_MODAL = "Termos de Uso do SUSE7";

/**
 * Serializa blocos jurídicos para hash/auditoria.
 * @param {readonly object[]} blocos
 */
export function montarTextoCanonicoDocumentoLegal(blocos) {
  return blocos
    .map((bloco) => {
      if (bloco.type === "paragraph" || bloco.type === "footer") {
        return bloco.parts.map((parte) => parte.text).join("");
      }
      if (bloco.type === "heading" || bloco.type === "subheading") return bloco.text;
      if (bloco.type === "list") {
        return bloco.items
          .map((item) => item.map((parte) => parte.text).join(""))
          .join("\n");
      }
      if (bloco.type === "contact") {
        return `${bloco.email}\n${bloco.website}`;
      }
      if (bloco.type === "contact_details") {
        const intro = bloco.intro ? [bloco.intro] : [];
        return [
          ...intro,
          ...bloco.lines.map((line) => `${line.label}${line.value ? ` ${line.value}` : ""}`),
        ].join("\n");
      }
      return "";
    })
    .join("\n\n");
}

/** @deprecated use montarTextoCanonicoDocumentoLegal */
export const montarTermosUsoTextoCanonico = montarTextoCanonicoDocumentoLegal;

/**
 * @param {{
 *   document_type: string;
 *   version_id: string;
 *   published_at_label: string;
 *   blocks: readonly object[];
 * }} def
 */
export function montarPayloadCanonicoDocumentoLegal(def) {
  return {
    document_type: def.document_type,
    version_id: def.version_id,
    published_at_label: def.published_at_label,
    content: montarTextoCanonicoDocumentoLegal(def.blocks),
  };
}

/**
 * @param {{
 *   document_type: string;
 *   version_id: string;
 *   published_at_label: string;
 *   title_page: string;
 *   title_modal?: string;
 *   blocks: readonly object[];
 * }} def
 */
export function computarHashDocumentoLegal(def) {
  return createHash("sha256").update(JSON.stringify(montarPayloadCanonicoDocumentoLegal(def))).digest("hex");
}

/** @type {Readonly<Record<string, {
 *   document_type: string;
 *   version_id: string;
 *   published_at_label: string;
 *   title_page: string;
 *   title_modal?: string;
 *   blocks: readonly object[];
 * }>>} */
const DEFINICOES_DOCUMENTOS_LEGAIS = {
  [TERMOS_USO_TIPO_DOCUMENTO]: {
    document_type: TERMOS_USO_TIPO_DOCUMENTO,
    version_id: TERMOS_USO_VERSAO_ID,
    published_at_label: TERMOS_USO_DATA_PUBLICACAO_ROTULO,
    title_page: TERMOS_USO_TITULO_PAGINA,
    title_modal: TERMOS_USO_TITULO_MODAL,
    blocks: TERMOS_USO_BLOCOS_CANONICOS,
  },
};

/**
 * @param {string} documentType
 */
export function obterCatalogoDocumentoLegal(documentType) {
  const key = String(documentType || "").trim();
  const def = DEFINICOES_DOCUMENTOS_LEGAIS[key];
  if (!def) return null;

  const document_hash = computarHashDocumentoLegal(def);
  return {
    document_type: def.document_type,
    document_version: def.version_id,
    document_hash,
    published_at_label: def.published_at_label,
    title_page: def.title_page,
    title_modal: def.title_modal ?? def.title_page,
    blocks: def.blocks,
  };
}

export function listarTiposDocumentosLegaisPublicos() {
  return Object.keys(DEFINICOES_DOCUMENTOS_LEGAIS);
}

/** Compat — Termos de Uso */
export function montarTermosUsoPayloadCanonico() {
  return montarPayloadCanonicoDocumentoLegal(DEFINICOES_DOCUMENTOS_LEGAIS[TERMOS_USO_TIPO_DOCUMENTO]);
}

export const TERMOS_USO_HASH_CONTEUDO = computarHashDocumentoLegal(
  DEFINICOES_DOCUMENTOS_LEGAIS[TERMOS_USO_TIPO_DOCUMENTO]
);

/** Compat — Termos de Uso */
export function obterCatalogoTermosUso() {
  return obterCatalogoDocumentoLegal(TERMOS_USO_TIPO_DOCUMENTO);
}
