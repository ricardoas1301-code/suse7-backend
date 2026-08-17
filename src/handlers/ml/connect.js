// ======================================================
// /api/ml/connect — OAuth Mercado Livre (Vercel)
// Autoridade: Bearer JWT (requireAuthUser). Query user_id legado ignorado como authority.
// ======================================================

import { createClient } from "@supabase/supabase-js";
import {
  validateEnv,
  generateSecureState,
  buildMlAuthUrl,
  persistOAuthState,
  validateMlConnectOAuthEnv,
  getMlOAuthRuntimeLabel,
  classifyMlOAuthRedirect,
  maskMlClientIdForLog,
  maskSupabaseProjectRef,
  buildMlOAuthConnectProxyUrl,
  resolveMlOAuthConnectHostProxy,
  evaluateMlOAuthBackendEnvCoherence,
  assertSellerCompanyOwnedForMlConnect,
} from "./_helpers/oauthConnect.js";
import { ML_MARKETPLACE_SLUG } from "./_helpers/mlMarketplace.js";
import { requireAuthUser } from "./_helpers/requireAuthUser.js";
import { resolverContextoFluxoMlOAuth } from "./_helpers/resolverContextoFluxoMlOAuth.js";
import { assertInitialConfigurationCompleteForMlConnect } from "../../onboarding/domain/assertInitialConfigurationCompleteForMlConnect.js";
import { sendRedirect } from "../../infra/httpRedirect.js";
import { config } from "../../infra/config.js";

const ML_CONNECT_ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function maskSupabaseUrl(url) {
  if (!url?.trim()) return "(empty)";
  try {
    const m = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
    return m ? `https://${m[1]}.supabase.co` : "(unknown)";
  } catch {
    return "(parse-error)";
  }
}

function legacyUserIdQueryAllowed() {
  const raw = String(process.env.ML_CONNECT_LEGACY_USER_ID_QUERY ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no";
}

/**
 * Resolve user_id authority — Bearer first; legado query só se explicitamente permitido.
 * @param {import("http").IncomingMessage} req
 */
async function resolveMlConnectAuthenticatedUserId(req) {
  const auth = await requireAuthUser(req);
  if (!auth.error && auth.user?.id) {
    const authenticatedId = String(auth.user.id).trim();
    const queryUserId =
      req.query?.user_id != null && typeof req.query.user_id === "string" ? req.query.user_id.trim() : "";
    if (queryUserId && queryUserId !== authenticatedId) {
      return {
        ok: false,
        status: 403,
        code: "ml_connect_user_spoof",
        error: "Identidade da sessão não confere com user_id informado.",
      };
    }
    return { ok: true, userId: authenticatedId, source: "bearer" };
  }

  if (!legacyUserIdQueryAllowed()) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      error: auth.error?.message ?? "Token não informado",
    };
  }

  const userId = req.query?.user_id ?? null;
  if (!userId || typeof userId !== "string") {
    return { ok: false, status: 400, code: "missing_user_id", error: "Missing query: user_id" };
  }
  const trimmed = userId.trim();
  if (!UUID_REGEX.test(trimmed)) {
    return { ok: false, status: 400, code: "invalid_user_id", error: "Invalid user_id format (expected UUID)" };
  }

  console.warn("[ml/connect] legacy_user_id_query_authority", {
    hint: "ML_CONNECT_LEGACY_USER_ID_QUERY enabled — migrate clients to Bearer",
  });
  return { ok: true, userId: trimmed, source: "legacy_query" };
}

export async function handleMlConnect(req, res) {
  const errorId = Date.now();
  const path = "/api/ml/connect";

  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "Method not allowed", errorId });
    }

    const identity = await resolveMlConnectAuthenticatedUserId(req);
    if (!identity.ok) {
      return res.status(identity.status).json({
        ok: false,
        error: identity.error,
        errorId,
        code: identity.code,
      });
    }

    const trimmedUserId = identity.userId;

    console.info("[ml/connect] connect_started", {
      errorId,
      path,
      user_id: trimmedUserId,
      auth_source: identity.source,
      host: req.headers?.host ?? null,
    });

    const sellerCompanyIdRaw = req.query?.seller_company_id ?? null;
    let oauthSellerCompanyId = null;
    if (sellerCompanyIdRaw != null && typeof sellerCompanyIdRaw === "string") {
      const sc = sellerCompanyIdRaw.trim();
      if (sc) {
        if (!UUID_REGEX.test(sc)) {
          return res.status(400).json({
            ok: false,
            error: "seller_company_id deve ser um UUID válido.",
            errorId,
          });
        }
        oauthSellerCompanyId = sc;
      }
    }

    const envCheck = validateEnv(ML_CONNECT_ENV_KEYS);
    if (!envCheck.ok) {
      return res.status(500).json({
        ok: false,
        error: `Missing env: ${envCheck.missing.join(", ")}`,
        errorId,
      });
    }

    const mlOAuth = validateMlConnectOAuthEnv(req);
    if (!mlOAuth.ok) {
      return res.status(500).json({
        ok: false,
        error: "Configuração OAuth do Mercado Livre inválida no servidor",
        errorId,
        details: mlOAuth.errors,
      });
    }

    const envCoherence = evaluateMlOAuthBackendEnvCoherence(req);
    if (envCoherence.errors.length > 0) {
      return res.status(500).json({
        ok: false,
        error: "Configuração de ambiente inconsistente no backend (DEV/PROD misturados)",
        errorId,
        code: "ml_oauth_env_mismatch",
        details: envCoherence.errors,
      });
    }

    const supabaseUrl = config.supabaseUrl?.trim();
    const serviceKey = config.supabaseServiceRoleKey?.trim();
    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ ok: false, error: "Supabase indisponível", errorId });
    }

    const adm = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const flowCtx = await resolverContextoFluxoMlOAuth(adm, trimmedUserId);
    const flowTypePersist = flowCtx.onboarding_first_connection
      ? "onboarding_first_connection"
      : flowCtx.flow_type;

    console.info("[ml/connect] resolved_flow_type", {
      errorId,
      flow_type: flowTypePersist,
      server_derived: true,
      onboarding_first_connection: flowCtx.onboarding_first_connection,
      active_ml_account_count: flowCtx.active_ml_account_count,
    });

    if (!oauthSellerCompanyId) {
      return res.status(400).json({
        ok: false,
        error:
          "Selecione a empresa (CNPJ) que receberá esta conexão Mercado Livre. Cadastre empresas em Perfil → Dados da Empresa.",
        errorId,
        code: "seller_company_id_required_for_ml_connect",
      });
    }

    const ownership = await assertSellerCompanyOwnedForMlConnect(
      adm,
      trimmedUserId,
      oauthSellerCompanyId,
      supabaseUrl,
    );
    if (!ownership.ok) {
      return res.status(400).json({
        ok: false,
        error: "seller_company_id não encontrado para este usuário ou não pertence ao user_id informado.",
        errorId,
        code: ownership.code,
        hint: ownership.hint,
        reason: ownership.reason,
      });
    }

    if (flowCtx.onboarding_first_connection) {
      const precond = await assertInitialConfigurationCompleteForMlConnect(adm, trimmedUserId);
      if (!precond.ok) {
        console.warn("[ml/connect] initial_configuration_incomplete", {
          errorId,
          user_id: trimmedUserId,
          incomplete: precond.incomplete_milestones ?? [],
        });
        return res.status(409).json({
          ok: false,
          error: precond.message,
          errorId,
          code: precond.code,
          incomplete_milestones: precond.incomplete_milestones ?? [],
        });
      }
    }

    const cid = process.env.ML_CLIENT_ID?.trim() || "";
    const ru = process.env.ML_REDIRECT_URI?.trim() || "";
    const { oauthMode } = classifyMlOAuthRedirect(ru);
    const supabaseProjectRef = maskSupabaseProjectRef(supabaseUrl);
    console.info("[ML_AUTH] oauth_config_final", {
      clientIdPreview: maskMlClientIdForLog(cid),
      redirectUri: ru,
      env: getMlOAuthRuntimeLabel(),
      host: req.headers?.host ?? null,
      oauthMode,
      supabase_project_ref: supabaseProjectRef,
    });

    const hostProxy = resolveMlOAuthConnectHostProxy(req, ru);
    if (hostProxy.shouldProxy && hostProxy.targetConnectUrl) {
      const proxyUrl = buildMlOAuthConnectProxyUrl(hostProxy.targetConnectUrl, req);
      console.warn("[ml/connect] oauth_connect_host_proxy", {
        errorId,
        reason: hostProxy.reason,
        proxy_url: proxyUrl,
      });
      sendRedirect(res, proxyUrl, 302);
      return;
    }

    const state = generateSecureState();

    console.info("[ml/oauth/start] state_created", {
      errorId,
      user_id: trimmedUserId,
      state_len: state.length,
      flow_type: flowTypePersist,
      seller_company_id: oauthSellerCompanyId,
    });

    const persistResult = await persistOAuthState(
      supabaseUrl,
      serviceKey,
      state,
      trimmedUserId,
      "ml",
      oauthSellerCompanyId,
      { flow_type: flowTypePersist },
    );

    if (persistResult.error) {
      console.error("[ml/connect] persistOAuthState failed", persistResult.error);
      return res.status(500).json({
        ok: false,
        error: "persistOAuthState failed",
        errorId,
        details: persistResult.error?.message || String(persistResult.error),
      });
    }

    const authUrl = buildMlAuthUrl(process.env.ML_CLIENT_ID, process.env.ML_REDIRECT_URI, state);
    console.info("[ML_AUTH] connect_redirect", {
      state_len: state?.length ?? 0,
      redirectUri: process.env.ML_REDIRECT_URI?.trim() ?? null,
    });

    sendRedirect(res, authUrl, 302);
    return;
  } catch (err) {
    const envCheck = validateEnv(ML_CONNECT_ENV_KEYS);
    console.error("[ml/connect] errorId:", errorId, {
      message: err?.message,
      stack: err?.stack,
      missingEnv: envCheck.missing,
    });
    return res.status(500).json({
      ok: false,
      error: envCheck.ok ? err?.message || "Internal error" : `Missing env: ${envCheck.missing.join(", ")}`,
      errorId,
    });
  }
}
