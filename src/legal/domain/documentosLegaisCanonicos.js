// ======================================================================
// Termos de Uso — metadados canônicos (validação backend)
// ======================================================================

export const TERMOS_USO_TIPO_DOCUMENTO = "TERMS_OF_USE";
export const TERMOS_USO_VERSAO_ID = "2025-11-27-v1";
export const TERMOS_USO_HASH_CONTEUDO = "4969d335da583efffd42bfa5b57915d1512a6b1b46d9396195b58a3329fe2a97";

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
