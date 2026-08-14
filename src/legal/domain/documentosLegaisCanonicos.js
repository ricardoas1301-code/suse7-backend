// ======================================================================
// Termos de Uso — metadados canônicos (validação backend)
// ======================================================================

export const TERMOS_USO_TIPO_DOCUMENTO = "TERMS_OF_USE";
/** Alinhado ao SSOT frontend — termosUsoDocumento.js (2026-08-13 provisório). */
export const TERMOS_USO_VERSAO_ID = "2026-08-13-v2-provisional";
export const TERMOS_USO_HASH_CONTEUDO = "92364df98d295ad434c5413b5288eb0457f691edebdd0c7cfde98e6f54efc63c";

/** @type {Readonly<Record<string, { versionId: string; contentHash: string }>>} */
export const DOCUMENTOS_LEGAIS_CANONICOS = {
  [TERMOS_USO_TIPO_DOCUMENTO]: {
    versionId: TERMOS_USO_VERSAO_ID,
    contentHash: TERMOS_USO_HASH_CONTEUDO,
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
