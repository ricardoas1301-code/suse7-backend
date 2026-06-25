// ======================================================
// GET /api/ml/oauth-config — diagnóstico OAuth ML (sem segredos)
// Uso: página Integrações confere se o backend local carregou o .env certo.
// ======================================================

import {
  validateMlConnectOAuthEnv,
  getMlOAuthRuntimeLabel,
  classifyMlOAuthRedirect,
  maskMlClientIdForLog,
  maskSupabaseProjectRef,
  resolveMlOAuthConnectHostProxy,
  resolveRequestHostname,
  evaluateMlOAuthBackendEnvCoherence,
} from "./_helpers/oauthConnect.js";
import { config } from "../../infra/config.js";

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
  const hostProxy = resolveMlOAuthConnectHostProxy(req, ru);
  const envCoherence = evaluateMlOAuthBackendEnvCoherence(req);
  const supabaseProjectRef = maskSupabaseProjectRef(config.supabaseUrl);

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
    supabase_project_ref: supabaseProjectRef,
    expected_supabase_project_ref: envCoherence.expectedSupabaseProjectRef,
    env_coherence_errors: envCoherence.errors,
    env_coherence_warnings: envCoherence.warnings,
    connect_callback_host_aligned: !hostProxy.shouldProxy,
    connect_host: hostProxy.connectHost || resolveRequestHostname(req) || null,
    callback_host: hostProxy.callbackHost || null,
    connect_would_proxy_to: hostProxy.shouldProxy ? hostProxy.targetConnectUrl : null,
  });

  /** Contrato estável: sempre ok + errors (sem segredos). */
  const mergedErrors = [
    ...(validation.ok ? [] : validation.errors),
    ...envCoherence.errors,
  ];
  return res.status(200).json({
    ok: validation.ok && envCoherence.errors.length === 0,
    errors: mergedErrors,
    oauthEnvWarnings: envCoherence.warnings,
    envCoherence,
    runtime: getMlOAuthRuntimeLabel(),
    nodeEnv: process.env.NODE_ENV ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    backendHost: req.headers?.host ?? null,
    clientIdLength: cid.length,
    clientIdPreview: maskMlClientIdForLog(cid),
    clientSecretLength: secLen,
    redirectUri: ru || null,
    frontendUrl: fe || null,
    isLocalRedirect,
    oauthMode,
    supabaseProjectRef,
    expectedSupabaseProjectRef: envCoherence.expectedSupabaseProjectRef,
    connectCallbackHostAligned: !hostProxy.shouldProxy,
    connectHost: hostProxy.connectHost || resolveRequestHostname(req) || null,
    callbackHost: hostProxy.callbackHost || null,
    connectWouldProxyTo: hostProxy.shouldProxy ? hostProxy.targetConnectUrl : null,
    publicCallbackRequired: process.env.ML_OAUTH_REQUIRE_PUBLIC_CALLBACK === "1",
    mlLocalDevExpectedClientIdPreview: maskMlClientIdForLog(
      (process.env.ML_LOCAL_DEV_EXPECTED_CLIENT_ID || "").trim()
    ),
    mlForbiddenClientIdsConfigured: Boolean(
      (process.env.ML_LOCAL_DEV_FORBIDDEN_CLIENT_IDS || "").trim()
    ),
  });
}
