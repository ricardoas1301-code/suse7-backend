// ======================================================
// GET /api/ml/oauth-config — diagnóstico OAuth ML (sem segredos)
// Uso: página Integrações confere se o backend local carregou o .env certo.
// ======================================================

import {
  validateMlConnectOAuthEnv,
  getMlOAuthRuntimeLabel,
  classifyMlOAuthRedirect,
  maskMlClientIdForLog,
} from "./_helpers/oauthConnect.js";

/**
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 */
export default async function handleMlOAuthConfigProbe(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const validation = validateMlConnectOAuthEnv(req);
  const cid = (process.env.ML_CLIENT_ID || "").trim();
  const ru = (process.env.ML_REDIRECT_URI || "").trim();
  const fe = (process.env.FRONTEND_URL || "").trim();
  const secLen = (process.env.ML_CLIENT_SECRET || "").trim().length;
  const { isLocalRedirect, oauthMode } = classifyMlOAuthRedirect(ru);

  console.info("[ML_AUTH] oauth_config_probe", {
    ok: validation.ok,
    env: getMlOAuthRuntimeLabel(),
    nodeEnv: process.env.NODE_ENV ?? null,
    host: req.headers?.host ?? null,
    clientIdLength: cid.length,
    clientIdPreview: maskMlClientIdForLog(cid),
    clientSecretLength: secLen,
    redirectUri: ru || null,
    frontendUrl: fe || null,
    isLocalRedirect,
    oauthMode,
  });

  /** Contrato estável: sempre ok + errors (sem segredos). */
  return res.status(200).json({
    ok: validation.ok,
    errors: validation.ok ? [] : validation.errors,
    runtime: getMlOAuthRuntimeLabel(),
    nodeEnv: process.env.NODE_ENV ?? null,
    backendHost: req.headers?.host ?? null,
    clientIdLength: cid.length,
    clientIdPreview: maskMlClientIdForLog(cid),
    clientSecretLength: secLen,
    redirectUri: ru || null,
    frontendUrl: fe || null,
    isLocalRedirect,
    oauthMode,
    publicCallbackRequired: process.env.ML_OAUTH_REQUIRE_PUBLIC_CALLBACK === "1",
    mlLocalDevExpectedClientIdPreview: maskMlClientIdForLog(
      (process.env.ML_LOCAL_DEV_EXPECTED_CLIENT_ID || "").trim()
    ),
    mlForbiddenClientIdsConfigured: Boolean(
      (process.env.ML_LOCAL_DEV_FORBIDDEN_CLIENT_IDS || "").trim()
    ),
  });
}
