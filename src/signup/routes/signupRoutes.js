// ======================================================================
// Rotas HTTP — Signup two-phase (pending birth + bind + complete)
// ======================================================================

import { createClient } from "@supabase/supabase-js";
import { config } from "../../infra/config.js";
import { ok, fail, getTraceId } from "../../infra/http.js";
import { readRequestJson } from "../../billing/utils/readRequestJson.js";
import { requireAuthUser } from "../../handlers/ml/_helpers/requireAuthUser.js";
import {
  validatePendingBirthPayload,
  generateCorrelationToken,
  hashCorrelationToken,
  computePendingExpiresAt,
  maskSignupEmail,
} from "../domain/signupPendingBirthValidation.js";
import {
  rpcCreatePendingBirth,
  rpcBindPendingBirth,
  rpcAbortPendingBirth,
} from "../services/signupPendingBirthRepository.js";
import { completeSignupBirthOnce } from "../services/completeSignupBirthService.js";
import { checkSignupRateLimit, resolveSignupRateLimitKey } from "../infra/signupRateLimit.js";

function createServiceSupabase() {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} path
 */
export async function handleSignupRoutes(req, res, path) {
  const method = String(req.method || "GET").toUpperCase();
  const pathNorm = String(path || "").split("?")[0];
  const traceId = getTraceId(req);

  if (!config.supabaseUrl?.trim() || !config.supabaseServiceRoleKey?.trim()) {
    return fail(res, { code: "CONFIG_ERROR", message: "Configuração indisponível." }, 503, traceId);
  }

  const supabase = createServiceSupabase();

  if (pathNorm === "/api/signup/pending-birth") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }

    const body = await readRequestJson(req);
    const validated = validatePendingBirthPayload(body);
    if (!validated.ok) {
      return fail(res, { code: validated.code, message: validated.message }, 400, traceId);
    }

    const rate = checkSignupRateLimit(resolveSignupRateLimitKey(req, validated.normalizedEmail));
    if (!rate.allowed) {
      return fail(
        res,
        { code: "RATE_LIMITED", message: "Muitas tentativas. Aguarde e tente novamente." },
        429,
        traceId
      );
    }

    const bindToken = generateCorrelationToken();
    const tokenHash = hashCorrelationToken(bindToken);
    const expiresAt = computePendingExpiresAt();

    const { data, error } = await rpcCreatePendingBirth(supabase, {
      p_correlation_token_hash: tokenHash,
      p_normalized_email: validated.normalizedEmail,
      p_profile_payload: validated.profilePayload,
      p_document_type: validated.legalEvidence.document_type,
      p_document_version: validated.legalEvidence.document_version,
      p_document_hash: validated.legalEvidence.document_hash,
      p_source: validated.legalEvidence.source,
      p_scrolled_to_end: validated.legalEvidence.scrolled_to_end,
      p_client_accepted_at: validated.legalEvidence.client_accepted_at,
      p_expires_at: expiresAt.toISOString(),
    });

    if (error) {
      return fail(res, { code: "PERSISTENCE_ERROR", message: "Não foi possível registrar o cadastro." }, 500, traceId);
    }

    const result = data && typeof data === "object" ? data : {};
    if (result.ok !== true) {
      const status =
        result.code === "EMAIL_ALREADY_REGISTERED" || result.code === "CNPJ_ALREADY_REGISTERED" ? 409 : 400;
      const message =
        result.code === "EMAIL_ALREADY_REGISTERED"
          ? "Este e-mail já está cadastrado."
          : result.code === "CNPJ_ALREADY_REGISTERED"
            ? "Este CNPJ já está cadastrado."
            : "Não foi possível registrar o cadastro.";
      return fail(res, { code: result.code ?? "CREATE_FAILED", message }, status, traceId);
    }

    return ok(res, {
      ok: true,
      pending_id: result.pending_id,
      bind_token: bindToken,
      email_masked: maskSignupEmail(validated.normalizedEmail),
      expires_at: result.expires_at,
      server_received_at: result.server_received_at,
      traceId,
    });
  }

  if (pathNorm === "/api/signup/pending-birth/bind") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }

    const body = await readRequestJson(req);
    const bindToken = String(body?.bind_token || "").trim();
    const authUserId = String(body?.auth_user_id || "").trim();
    const authEmail = String(body?.auth_email || "").trim();

    if (!bindToken || !authUserId || !authEmail) {
      return fail(res, { code: "INVALID_PAYLOAD", message: "Dados de vínculo incompletos." }, 400, traceId);
    }

    const { data, error } = await rpcBindPendingBirth(
      supabase,
      hashCorrelationToken(bindToken),
      authUserId,
      authEmail
    );

    if (error) {
      return fail(res, { code: "BIND_ERROR", message: "Não foi possível vincular o cadastro." }, 500, traceId);
    }

    const result = data && typeof data === "object" ? data : {};
    if (result.ok !== true) {
      const status = result.code === "EMAIL_MISMATCH" ? 403 : 400;
      return fail(res, { code: result.code ?? "BIND_FAILED", message: "Vínculo recusado." }, status, traceId);
    }

    return ok(res, { ok: true, code: "BOUND", pending_id: result.pending_id, traceId });
  }

  if (pathNorm === "/api/signup/pending-birth/abort") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }

    const body = await readRequestJson(req);
    const bindToken = String(body?.bind_token || "").trim();
    if (!bindToken) {
      return fail(res, { code: "INVALID_PAYLOAD", message: "Token ausente." }, 400, traceId);
    }

    const { data, error } = await rpcAbortPendingBirth(
      supabase,
      hashCorrelationToken(bindToken),
      String(body?.reason || "SIGNUP_FAILED")
    );

    if (error) {
      return fail(res, { code: "ABORT_ERROR", message: "Não foi possível abortar o cadastro." }, 500, traceId);
    }

    const result = data && typeof data === "object" ? data : {};
    if (result.ok !== true) {
      return fail(res, { code: result.code ?? "ABORT_FAILED", message: "Abort recusado." }, 400, traceId);
    }

    return ok(res, { ok: true, code: "ABORTED", traceId });
  }

  if (pathNorm === "/api/signup/complete-birth") {
    if (method !== "POST") {
      return fail(res, { code: "METHOD_NOT_ALLOWED", message: "Use POST" }, 405, traceId);
    }

    const auth = await requireAuthUser(req);
    if (auth.error) {
      return fail(res, { code: "UNAUTHORIZED", message: auth.error.message }, auth.error.status, traceId);
    }

    const completion = await completeSignupBirthOnce(auth.supabase, auth.user.id);
    if (!completion.ok) {
      const status =
        completion.code === "EMAIL_NOT_CONFIRMED"
          ? 403
          : completion.code === "PENDING_NOT_FOUND"
            ? 404
            : 500;
      return fail(
        res,
        { code: completion.code ?? "COMPLETION_FAILED", message: completion.message ?? "Falha na conclusão." },
        status,
        traceId
      );
    }

    return ok(res, { ...completion, traceId });
  }

  return null;
}
