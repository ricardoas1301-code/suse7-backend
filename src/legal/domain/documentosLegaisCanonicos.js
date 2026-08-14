// ======================================================================
// Termos de Uso — metadados canônicos (validação backend)
// Derivado do catálogo SSOT — não duplicar version/hash manualmente aqui.
// ======================================================================

import {
  TERMOS_USO_HASH_CONTEUDO,
  TERMOS_USO_TIPO_DOCUMENTO,
  TERMOS_USO_VERSAO_ID,
  POLITICA_PRIVACIDADE_HASH_CONTEUDO,
  POLITICA_PRIVACIDADE_TIPO_DOCUMENTO,
  POLITICA_PRIVACIDADE_VERSAO_ID,
} from "./catalogoDocumentosLegais.js";

export {
  TERMOS_USO_HASH_CONTEUDO,
  TERMOS_USO_TIPO_DOCUMENTO,
  TERMOS_USO_VERSAO_ID,
  POLITICA_PRIVACIDADE_HASH_CONTEUDO,
  POLITICA_PRIVACIDADE_TIPO_DOCUMENTO,
  POLITICA_PRIVACIDADE_VERSAO_ID,
};

/** @type {Readonly<Record<string, { versionId: string; contentHash: string }>>} */
export const DOCUMENTOS_LEGAIS_CANONICOS = {
  [TERMOS_USO_TIPO_DOCUMENTO]: {
    versionId: TERMOS_USO_VERSAO_ID,
    contentHash: TERMOS_USO_HASH_CONTEUDO,
  },
  [POLITICA_PRIVACIDADE_TIPO_DOCUMENTO]: {
    versionId: POLITICA_PRIVACIDADE_VERSAO_ID,
    contentHash: POLITICA_PRIVACIDADE_HASH_CONTEUDO,
  },
};

/**
 * @param {string} documentType
 * @param {string} documentVersion
 * @param {string} documentHash
 */
export function validarMetadadosDocumentoLegal(documentType, documentVersion, documentHash) {
  const canonico = DOCUMENTOS_LEGAIS_CANONICOS[String(documentType || "").trim()];
  if (!canonico) {
    return { ok: false, code: "UNKNOWN_DOCUMENT", message: "Tipo de documento inválido." };
  }
  if (String(documentVersion || "").trim() !== canonico.versionId) {
    return { ok: false, code: "VERSION_MISMATCH", message: "Versão do documento desatualizada." };
  }
  if (String(documentHash || "").trim().toLowerCase() !== canonico.contentHash) {
    return { ok: false, code: "HASH_MISMATCH", message: "Hash do documento inválido." };
  }
  return { ok: true, canonico };
}
