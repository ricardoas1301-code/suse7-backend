// ======================================================================
// Rotas HTTP — Aceites de documentos legais
// ======================================================================

import { ok, fail, getTraceId } from "../../infra/http.js";
import { requireAuthUser } from "../../handlers/ml/_helpers/requireAuthUser.js";
import { readRequestJson } from "../../billing/utils/readRequestJson.js";
import { validarMetadadosDocumentoLegal } from "../domain/documentosLegaisCanonicos.js";

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} path
 */
export async function handleLegalRoutes(req, res, path) {
  const method = String(req.method || "GET").toUpperCase();
  const pathNorm = String(path || "").split("?")[0];
  const traceId = getTraceId(req);

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
