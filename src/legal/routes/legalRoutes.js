// ======================================================================
// Rotas HTTP — Documentos legais (catálogo SSOT + aceites)
// ======================================================================

import { ok, fail, getTraceId } from "../../infra/http.js";
import { requireAuthUser } from "../../handlers/ml/_helpers/requireAuthUser.js";
import { readRequestJson } from "../../billing/utils/readRequestJson.js";
import { validarMetadadosDocumentoLegal } from "../domain/documentosLegaisCanonicos.js";
import { obterCatalogoDocumentoLegal, listarTiposDocumentosLegaisPublicos } from "../domain/catalogoDocumentosLegais.js";

const TERMS_CATALOG_PATH = "/api/legal/documents/terms-of-use";
const LEGAL_DOCUMENT_PREFIX = "/api/legal/documents/";
const TERMS_CATALOG_CACHE_SECONDS = 3600;

function responderCatalogoPublico(res, catalog, traceId) {
  res.setHeader("Cache-Control", `public, max-age=${TERMS_CATALOG_CACHE_SECONDS}, stale-while-revalidate=86400`);
  return ok(res, {
    ok: true,
    catalog,
    traceId,
  });
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} path
 */
export async function handleLegalRoutes(req, res, path) {
  const method = String(req.method || "GET").toUpperCase();
  const pathNorm = String(path || "").split("?")[0];
  const traceId = getTraceId(req);

  if (pathNorm === TERMS_CATALOG_PATH || pathNorm.startsWith(LEGAL_DOCUMENT_PREFIX)) {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }

    const documentSlug = pathNorm.slice(LEGAL_DOCUMENT_PREFIX.length).replace(/\/+$/, "");
    const documentType =
      pathNorm === TERMS_CATALOG_PATH
        ? "TERMS_OF_USE"
        : documentSlug === "terms-of-use"
          ? "TERMS_OF_USE"
          : documentSlug === "privacy-policy"
            ? "PRIVACY_POLICY"
            : documentSlug.toUpperCase().replace(/-/g, "_");

    const catalog = obterCatalogoDocumentoLegal(documentType);
    if (!catalog) {
      return fail(res, { code: "DOCUMENT_NOT_FOUND", message: "Documento legal não disponível." }, 404, traceId);
    }

    return responderCatalogoPublico(res, catalog, traceId);
  }

  if (pathNorm === "/api/legal/documents") {
    if (method !== "GET") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use GET" }, 405, traceId);
    }
    res.setHeader("Cache-Control", `public, max-age=${TERMS_CATALOG_CACHE_SECONDS}, stale-while-revalidate=86400`);
    return ok(res, {
      ok: true,
      documents: listarTiposDocumentosLegaisPublicos(),
      traceId,
    });
  }

  if (pathNorm === "/api/legal/document-acceptances") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }

    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }

    const body = await readRequestJson(req);
    const documentType = String(body?.document_type || "").trim();
    const documentVersion = String(body?.document_version || "").trim();
    const documentHash = String(body?.document_hash || "").trim().toLowerCase();
    const source = String(body?.source || "SIGNUP").trim();
    const scrolledToEnd = body?.scrolled_to_end === true;
    const acceptedAtRaw = body?.accepted_at;

    if (!documentType || !documentVersion || !documentHash) {
      return fail(res, { code: "INVALID_PAYLOAD", message: "Metadados do documento incompletos." }, 400, traceId);
    }
    if (!scrolledToEnd) {
      return fail(
        res,
        { code: "SCROLL_REQUIRED", message: "Aceite exige percurso até o final do documento." },
        400,
        traceId
      );
    }

    const validation = validarMetadadosDocumentoLegal(documentType, documentVersion, documentHash);
    if (!validation.ok) {
      return fail(res, { code: validation.code, message: validation.message }, 409, traceId);
    }

    const acceptedAt = acceptedAtRaw ? new Date(acceptedAtRaw) : new Date();
    if (Number.isNaN(acceptedAt.getTime())) {
      return fail(res, { code: "INVALID_ACCEPTED_AT", message: "Data de aceite inválida." }, 400, traceId);
    }

    const { user, supabase } = auth;
    const row = {
      user_id: user.id,
      document_type: documentType,
      document_version: documentVersion,
      document_hash: documentHash,
      accepted_at: acceptedAt.toISOString(),
      source,
      scrolled_to_end: true,
    };

    const { data, error } = await supabase.from("legal_document_acceptances").insert(row).select("id").maybeSingle();
    if (error) {
      return fail(
        res,
        { code: "PERSISTENCE_ERROR", message: "Não foi possível registrar o aceite do documento." },
        500,
        traceId
      );
    }

    return ok(res, {
      ok: true,
      acceptance_id: data?.id ?? null,
      document_type: documentType,
      document_version: documentVersion,
      traceId,
    });
  }

  return null;
}
