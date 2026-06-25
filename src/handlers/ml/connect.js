// ======================================================
// /api/ml/connect — OAuth Mercado Livre (Vercel)
// Inicia o OAuth (NÃO exige usuário logado)
// Padrão Strategy/Adapter para futuros marketplaces
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
import { sendRedirect } from "../../infra/httpRedirect.js";
import { config } from "../../infra/config.js";

// ----------------------------------------------
// Env keys necessárias para ML connect
// ----------------------------------------------
const ML_CONNECT_ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

// ----------------------------------------------
// UUID v4 regex (simplificado)
// ----------------------------------------------
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ----------------------------------------------
// maskSupabaseUrl — Mascara URL mostrando só project ref (server-side log)
// ----------------------------------------------
function maskSupabaseUrl(url) {
  if (!url?.trim()) return "(empty)";
  try {
    const m = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
    return m ? `https://${m[1]}.supabase.co` : "(unknown)";
  } catch {
    return "(parse-error)";
  }
}

export async function handleMlConnect(req, res) {
  const errorId = Date.now();
  const path = "/api/ml/connect";
  const userId = req.query?.user_id ?? null;

  try {
    // ------------------------------
    // 1) Validar método e user_id
    // ------------------------------
    if (req.method !== "GET") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed",
        errorId,
      });
    }

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Missing query: user_id",
        errorId,
      });
    }

    const trimmedUserId = userId.trim();
    if (!UUID_REGEX.test(trimmedUserId)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid user_id format (expected UUID)",
        errorId,
      });
    }

    console.info("[ml/connect] connect_started", {
      errorId,
      path,
      user_id: trimmedUserId,
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

    // ------------------------------
    // 2) Validar ENV vars necessárias
    // ------------------------------
    const envCheck = validateEnv(ML_CONNECT_ENV_KEYS);
    if (!envCheck.ok) {
      const msg = `Missing env: ${envCheck.missing.join(", ")}`;
      console.error("[ml/connect]", {
        errorId,
        path,
        user_id: trimmedUserId,
        missingEnv: envCheck.missing,
      });
      return res.status(500).json({
        ok: false,
        error: msg,
        errorId,
      });
    }

    const mlOAuth = validateMlConnectOAuthEnv(req);
    if (!mlOAuth.ok) {
      console.error("[ml/connect] invalid_ml_oauth_env", { errorId, errors: mlOAuth.errors });
      return res.status(500).json({
        ok: false,
        error: "Configuração OAuth do Mercado Livre inválida no servidor",
        errorId,
        details: mlOAuth.errors,
      });
    }

    const envCoherence = evaluateMlOAuthBackendEnvCoherence(req);
    console.info("[ml/connect] env_coherence", {
      errorId,
      ...envCoherence,
    });
    if (envCoherence.errors.length > 0) {
      console.error("[ml/connect] env_coherence_failed", { errorId, errors: envCoherence.errors });
      return res.status(500).json({
        ok: false,
        error: "Configuração de ambiente inconsistente no backend (DEV/PROD misturados)",
        errorId,
        code: "ml_oauth_env_mismatch",
        details: envCoherence.errors,
        env: {
          supabaseProjectRef: envCoherence.supabaseProjectRef,
          expectedSupabaseProjectRef: envCoherence.expectedSupabaseProjectRef,
          backendHost: envCoherence.backendHost,
          redirectHost: envCoherence.redirectHost,
          frontendHost: envCoherence.frontendHost,
        },
      });
    }

    const supabaseUrl = config.supabaseUrl?.trim();
    const serviceKey = config.supabaseServiceRoleKey?.trim();
    let existingMlAccountCount = 0;
    if (supabaseUrl && serviceKey) {
      const adm = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
      const { count, error: cntErr } = await adm
        .from("marketplace_accounts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", trimmedUserId)
        .eq("marketplace", ML_MARKETPLACE_SLUG)
        .neq("status", "removed");
      if (!cntErr && typeof count === "number") {
        existingMlAccountCount = count;
      }
    }

    const flowType = existingMlAccountCount >= 1 ? "additional_account" : "first_account";
    console.info("[ml/connect] resolved_flow_type", {
      errorId,
      flow_type: flowType,
      existing_ml_account_count: existingMlAccountCount,
    });
    console.info("[ml/connect] seller_company_id_received", {
      errorId,
      seller_company_id: oauthSellerCompanyId,
      received: oauthSellerCompanyId != null,
    });

    if (!oauthSellerCompanyId) {
      console.warn("[ml/connect] seller_company_id_required_for_ml_connect", {
        errorId,
        user_id: trimmedUserId,
        flow_type: flowType,
      });
      return res.status(400).json({
        ok: false,
        error:
          "Selecione a empresa (CNPJ) que receberá esta conexão Mercado Livre. Cadastre empresas em Perfil → Dados da Empresa.",
        errorId,
        code: "seller_company_id_required_for_ml_connect",
      });
    }

    if (supabaseUrl && serviceKey) {
      const adm = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
      const ownership = await assertSellerCompanyOwnedForMlConnect(
        adm,
        trimmedUserId,
        oauthSellerCompanyId,
        supabaseUrl
      );
      if (!ownership.ok) {
        console.error("[ml/connect] seller_company_not_owned_by_user", {
          errorId,
          user_id: trimmedUserId,
          seller_company_id_preview: `${oauthSellerCompanyId.slice(0, 8)}…`,
          supabase_project_ref: ownership.supabase_project_ref,
          expected_supabase_project_ref: ownership.expected_supabase_project_ref,
          hint: ownership.hint,
          reason: ownership.reason,
          diagnostics: ownership.diagnostics,
        });
        return res.status(400).json({
          ok: false,
          error: "seller_company_id não encontrado para este usuário ou não pertence ao user_id informado.",
          errorId,
          code: ownership.code,
          hint: ownership.hint,
          reason: ownership.reason,
          supabaseProjectRef: ownership.supabase_project_ref,
          expectedSupabaseProjectRef: ownership.expected_supabase_project_ref,
          supabaseEnvMismatchProbable: ownership.supabase_env_mismatch_probable === true,
          diagnostics: ownership.diagnostics,
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
        connect_host: hostProxy.connectHost,
        callback_host: hostProxy.callbackHost,
        supabase_project_ref_local: supabaseProjectRef,
        proxy_url: proxyUrl,
        note:
          "Connect local redirecionado para o host do ML_REDIRECT_URI — state e callback usam o mesmo Supabase.",
      });
      sendRedirect(res, proxyUrl, 302);
      return;
    }

    // ------------------------------
    // 3) Gerar state seguro
    // ------------------------------
    const state = generateSecureState();

    console.info("[ml/oauth/start] state_created", {
      errorId,
      path,
      user_id: trimmedUserId,
      state_len: state.length,
      flow_type: flowType,
      existing_ml_account_count: existingMlAccountCount,
    });
    console.info("[ml/oauth/start] seller_company_context", {
      errorId,
      user_id: trimmedUserId,
      flow_type: flowType,
      seller_company_id: oauthSellerCompanyId ?? null,
    });

    // ------------------------------
    // 4) Persistir state no Supabase (diagnóstico)
    // ------------------------------
    console.log("[ml/connect] SUPABASE_URL (masked):", maskSupabaseUrl(supabaseUrl));
    console.info("[ml/connect] oauth_state_persist_target", {
      errorId,
      supabase_project_ref: supabaseProjectRef,
      connect_host: req.headers?.host ?? null,
      callback_host: hostProxy.callbackHost || null,
    });
    console.log("[ml/connect] persistOAuthState:start", { state, user_id: trimmedUserId });

    const persistResult = await persistOAuthState(
      supabaseUrl,
      serviceKey,
      state,
      trimmedUserId,
      "ml",
      oauthSellerCompanyId,
      { flow_type: flowType }
    );

    console.log("[ml/connect] persistOAuthState:result", {
      data: persistResult.data,
      error: persistResult.error ? { message: persistResult.error.message, code: persistResult.error.code } : null,
    });

    if (!persistResult.error) {
      console.info("[ml/connect] oauth_state_inserted", {
        errorId,
        user_id: trimmedUserId,
        seller_company_id: oauthSellerCompanyId ?? null,
        flow_type: flowType,
        existing_ml_account_count: existingMlAccountCount,
      });
    }

    if (persistResult.error) {
      console.error("[ml/connect] persistOAuthState failed, NOT redirecting", persistResult.error);
      return res.status(500).json({
        ok: false,
        error: "persistOAuthState failed",
        errorId,
        details: persistResult.error?.message || String(persistResult.error),
      });
    }

    // ------------------------------
    // 5) Montar URL OAuth e redirecionar 302
    // ------------------------------
    const authUrl = buildMlAuthUrl(
      process.env.ML_CLIENT_ID,
      process.env.ML_REDIRECT_URI,
      state
    );

    console.info("[ML_AUTH] connect_redirect", {
      state_len: state?.length ?? 0,
      redirectUri: process.env.ML_REDIRECT_URI?.trim() ?? null,
    });

    sendRedirect(res, authUrl, 302);
    return;
  } catch (err) {
    // ------------------------------
    // Erro: log completo + mensagem diagnóstica
    // ------------------------------
    const envCheck = validateEnv(ML_CONNECT_ENV_KEYS);
    console.error("[ml/connect] errorId:", errorId, {
      path,
      user_id: userId,
      missingEnv: envCheck.missing,
      stack: err?.stack,
    });

    const diagnosticMsg = envCheck.ok
      ? err?.message || "Internal error"
      : `Missing env: ${envCheck.missing.join(", ")}`;

    return res.status(500).json({
      ok: false,
      error: diagnosticMsg,
      errorId,
    });
  }
}
