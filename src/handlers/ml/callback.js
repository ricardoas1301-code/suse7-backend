// ======================================================
// /api/ml/callback — RECEBE code + state (token seguro)
// - Resolver state -> user_id
// - Trocar code por token
// - GET /users/me (obrigatório para sucesso) → external_seller_id, nickname, site_id
// - upsert marketplace_accounts (status = ciclo OAuth, ex. active; “aguardando sync” vem de sync-status/UI)
// - persist ml_tokens por (user_id, marketplace, ml_user_id) + marketplace_account_id quando existir coluna
// - sincronização inicial fica para a UI (ml_awaiting_sync); não enfileira jobs automaticamente aqui
// Redirect sucesso só com marketplace_account criada.
// ======================================================

import { createClient } from "@supabase/supabase-js";
import {
  resolveAndConsumeOAuthState,
  validateEnv,
  validateMlConnectOAuthEnv,
  diagnoseOAuthStateLookup,
  maskSupabaseProjectRef,
  extractUrlHostname,
  resolveRequestHostname,
} from "./_helpers/oauthConnect.js";
import { ML_MARKETPLACE_SLUG } from "./_helpers/mlMarketplace.js";
import { fetchMercadoLibreUserMe } from "./_helpers/mercadoLibreOrdersApi.js";
import {
  assertMlBindingAllowedBeforeUpsert,
  assertMlDocumentMatchesSellerCompanyCnpj,
  extractMlMeTaxDigits,
  fetchSellerCompanyTaxDigits,
} from "./_helpers/mlOAuthBindingGuards.js";
import {
  persistMlTokens,
  resolveSellerCompanyIdForMlCallback,
  upsertMercadoLivreMarketplaceAccount,
} from "./_helpers/mlOAuthConnectPersistence.js";
import { logMlOAuthBuildFingerprint } from "./_helpers/mlOAuthBuildFingerprint.js";
import { revokeMercadoLibreAccessToken } from "./_helpers/mlOAuthRevoke.js";
import { config } from "../../infra/config.js";
import { sendRedirect } from "../../infra/httpRedirect.js";

const ML_CALLBACK_ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ML_CLIENT_ID",
  "ML_CLIENT_SECRET",
  "ML_REDIRECT_URI",
  "FRONTEND_URL",
];

function sanitizeFrontendBaseUrl(value) {
  if (value == null) return "";
  const trimmed = String(value).trim();
  return trimmed.replace(/\/+$/, "");
}

function isPlaceholderFrontendUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return true;
  const lower = s.toLowerCase().replace(/_/g, "-");
  if (/url-exata-do-frontend/i.test(lower)) return true;
  if (/url-real-do-frontend/i.test(lower)) return true;
  if (lower.includes("placeholder-frontend")) return true;
  if (lower.includes("your-frontend-url")) return true;
  if (lower.includes("troque-por-sua-url")) return true;
  return false;
}

function resolveValidatedFrontendBaseUrl(raw) {
  const sanitized = sanitizeFrontendBaseUrl(raw);
  if (!sanitized) {
    return { ok: false, reason: "FRONTEND_URL ausente ou vazia após trim" };
  }
  if (!/^https?:\/\//i.test(sanitized)) {
    return {
      ok: false,
      reason: "FRONTEND_URL deve começar com http:// ou https://",
    };
  }
  if (isPlaceholderFrontendUrl(sanitized)) {
    return {
      ok: false,
      reason:
        "FRONTEND_URL parece placeholder de documentação; defina a URL real do frontend deste ambiente",
    };
  }
  try {
    const parsed = new URL(sanitized);
    if (!parsed.hostname || parsed.hostname.length < 1) {
      return { ok: false, reason: "FRONTEND_URL sem hostname válido" };
    }
  } catch {
    return { ok: false, reason: "FRONTEND_URL não é uma URL absoluta válida" };
  }
  return { ok: true, base: sanitized };
}

function buildMlIntegrationRedirect(frontendBase, querySuffix) {
  const path = "/perfil/integracoes/mercado-livre";
  return `${frontendBase}${path}?${querySuffix}`;
}

/** UUID v4 — validação antes de redirect de sucesso com marketplace_account_id. */
const ML_CALLBACK_ACCOUNT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseMlRedirectQueryForLog(fullUrl) {
  try {
    const u = new URL(fullUrl);
    const sp = u.searchParams;
    return {
      ml: sp.get("ml"),
      connected: sp.get("connected"),
      marketplace_account_id: sp.get("marketplace_account_id"),
      ml_account: sp.get("ml_account"),
      ml_error: sp.get("ml_error"),
      ml_error_detail: sp.get("ml_error_detail"),
    };
  } catch {
    return {
      ml: null,
      connected: null,
      marketplace_account_id: null,
      ml_account: null,
      ml_error: null,
      ml_error_detail: null,
    };
  }
}

/**
 * Único caminho de redirect para o frontend ML — loga URL real antes de enviar.
 * Se `is_success=true` e não houver UUID válido na URL, bloqueia e envia só `ml_error`.
 * @param {import("http").ServerResponse} res
 * @param {string} frontendBase
 * @param {string} querySuffix — query string sem "?"
 * @param {Record<string, unknown>} [meta]
 */
function sendMlCallbackIntegrationRedirect(res, frontendBase, querySuffix, meta = {}) {
  const redirectUrl = buildMlIntegrationRedirect(frontendBase, querySuffix);
  const parsed = parseMlRedirectQueryForLog(redirectUrl);
  const isSuccess = meta.is_success === true;
  const fromMeta =
    meta.marketplace_account_id != null && String(meta.marketplace_account_id).trim() !== ""
      ? String(meta.marketplace_account_id).trim()
      : null;
  const fromUrlMa =
    parsed.marketplace_account_id != null && String(parsed.marketplace_account_id).trim() !== ""
      ? String(parsed.marketplace_account_id).trim()
      : null;
  const fromUrlLegacy =
    parsed.ml_account != null && String(parsed.ml_account).trim() !== "" ? String(parsed.ml_account).trim() : null;
  const mid = fromMeta ?? fromUrlMa ?? fromUrlLegacy ?? null;
  const canonical =
    meta.canonical_account_id != null && String(meta.canonical_account_id).trim() !== ""
      ? String(meta.canonical_account_id).trim()
      : mid;

  console.info("[ml/callback] redirect_about_to_send", {
    reason: meta.reason != null ? String(meta.reason) : "unspecified",
    is_success: isSuccess,
    redirect_url: redirectUrl,
    marketplace_account_id: mid,
    canonical_account_id: canonical,
    account_from_upsert:
      meta.account_from_upsert != null && String(meta.account_from_upsert).trim() !== ""
        ? String(meta.account_from_upsert).trim()
        : null,
    persist_marketplace_account_id:
      meta.persist_marketplace_account_id != null && String(meta.persist_marketplace_account_id).trim() !== ""
        ? String(meta.persist_marketplace_account_id).trim()
        : null,
    ml_error: parsed.ml_error ?? null,
    ml_param: parsed.ml ?? null,
  });

  if (isSuccess && !ML_CALLBACK_ACCOUNT_UUID_RE.test(String(mid || "").trim())) {
    const emergencyQs = new URLSearchParams();
    emergencyQs.set("ml_error", "missing_marketplace_account_id");
    emergencyQs.set("ml_error_detail", "callback_guard");
    const emergencyUrl = buildMlIntegrationRedirect(frontendBase, emergencyQs.toString());
    const parsedEm = parseMlRedirectQueryForLog(emergencyUrl);
    console.error("[ml/callback] fatal_missing_marketplace_account_id", {
      attempt_url: redirectUrl,
      meta,
    });
    console.info("[ml/callback] redirect_about_to_send", {
      reason: "missing_marketplace_account_id_emergency",
      is_success: false,
      redirect_url: emergencyUrl,
      marketplace_account_id: null,
      canonical_account_id: null,
      account_from_upsert:
        meta.account_from_upsert != null && String(meta.account_from_upsert).trim() !== ""
          ? String(meta.account_from_upsert).trim()
          : null,
      persist_marketplace_account_id:
        meta.persist_marketplace_account_id != null && String(meta.persist_marketplace_account_id).trim() !== ""
          ? String(meta.persist_marketplace_account_id).trim()
          : null,
      ml_error: parsedEm.ml_error,
      ml_param: parsedEm.ml,
    });
    sendRedirect(res, emergencyUrl, 302);
    return;
  }

  sendRedirect(res, redirectUrl, 302);
}

/**
 * Log único de falha do callback (sem tokens).
 * @param {{ errorId: number | string, etapa: string, error_code?: string | null, error_message?: string | null, [k: string]: unknown }} p
 */
function logMlCallbackFailed(p) {
  const { errorId, etapa, error_code = null, error_message = null, ...rest } = p || {};
  console.error("[ml/callback] callback_failed", {
    error_id: errorId,
    etapa: etapa ?? "unknown",
    error_code: error_code ?? null,
    error_message:
      error_message != null && String(error_message).trim() !== ""
        ? String(error_message).slice(0, 2000)
        : null,
    ...rest,
  });
}

function createServiceRoleSupabase() {
  const url = config.supabaseUrl?.trim();
  const key = config.supabaseServiceRoleKey?.trim();
  if (!url || !key) {
    throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes em config");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function resolveExpiresAtIso(mlData) {
  const raw =
    typeof mlData.expires_in === "number" && Number.isFinite(mlData.expires_in)
      ? mlData.expires_in
      : parseInt(String(mlData.expires_in ?? "21600"), 10) || 21600;
  const sec = Math.min(Math.max(raw, 300), 86400 * 30);
  return new Date(Date.now() + sec * 1000).toISOString();
}

function fireMarketplaceSyncDrainNudge(req, marketplaceAccountId) {
  const host = req.headers?.host != null ? String(req.headers.host) : "";
  const protoHeader = req.headers?.["x-forwarded-proto"] != null ? String(req.headers["x-forwarded-proto"]) : "";
  const proto = protoHeader.includes("https") ? "https" : "http";
  const baseUrl = host ? `${proto}://${host}` : null;
  const dispatchUrl = baseUrl ? `${baseUrl}/api/jobs/marketplace-account-sync?limit=1` : null;
  if (!dispatchUrl) return;
  const headers = {};
  if (config.jobSecret) headers["x-job-secret"] = config.jobSecret;
  else if (config.cronSecret) headers.Authorization = `Bearer ${config.cronSecret}`;
  Promise.resolve()
    .then(async () => {
      try {
        const r = await fetch(dispatchUrl, { method: "POST", headers });
        console.info("[ml/callback] worker_drain_nudge", {
          marketplace_account_id: marketplaceAccountId,
          http_status: r.status,
        });
      } catch (e) {
        console.warn("[ml/callback] worker_drain_nudge_warn", {
          marketplace_account_id: marketplaceAccountId,
          error_message: e?.message ?? String(e),
        });
      }
    })
    .catch(() => {});
}

async function handleMLCallback(req, res) {
  const errorId = Date.now();
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Método não permitido" });
    }

    console.info("[ml/callback] EXECUTADO", { at: new Date().toISOString(), errorId });
    logMlOAuthBuildFingerprint("ml/callback");

    const code = req.query?.code;
    const state = req.query?.state;

    console.info("[ml/callback] callback_started", {
      errorId,
      has_code: Boolean(code),
      has_state: Boolean(state),
    });

    if (!code) {
      return res.status(400).json({ ok: false, error: "Code não encontrado" });
    }
    if (!state) {
      return res.status(400).json({ ok: false, error: "State não encontrado" });
    }

    {
      const ruProbe = process.env.ML_REDIRECT_URI?.trim() ?? "";
      const stStr = typeof state === "string" ? state : String(state);
      console.info("[ML_AUTH] callback_target", {
        redirectUri: ruProbe,
        statePreview: stStr.length > 16 ? `${stStr.slice(0, 10)}…` : stStr,
        host: req.headers?.host ?? null,
      });
    }

    const envCheck = validateEnv(ML_CALLBACK_ENV_KEYS);
    if (!envCheck.ok) {
      logMlCallbackFailed({
        errorId,
        etapa: "validate_env",
        error_code: "missing_env",
        error_message: `Missing env: ${envCheck.missing.join(", ")}`,
        missing_env: envCheck.missing,
      });
      console.error("[ml/callback] errorId:", errorId, { missingEnv: envCheck.missing });
      return res.status(500).json({
        ok: false,
        error: `Missing env: ${envCheck.missing.join(", ")}`,
        errorId,
      });
    }

    const mlOAuth = validateMlConnectOAuthEnv(req);
    if (!mlOAuth.ok) {
      logMlCallbackFailed({
        errorId,
        etapa: "ml_oauth_env",
        error_code: "invalid_ml_oauth_env",
        error_message: Array.isArray(mlOAuth.errors) ? mlOAuth.errors.join("; ") : "invalid",
        details: mlOAuth.errors,
      });
      console.error("[ml/callback] invalid_ml_oauth_env", { errorId, errors: mlOAuth.errors });
      return res.status(500).json({
        ok: false,
        error: "Configuração OAuth do Mercado Livre inválida no servidor",
        errorId,
        details: mlOAuth.errors,
      });
    }

    const frontendResolution = resolveValidatedFrontendBaseUrl(process.env.FRONTEND_URL);
    if (!frontendResolution.ok) {
      logMlCallbackFailed({
        errorId,
        etapa: "frontend_url",
        error_code: "invalid_frontend_url",
        error_message: frontendResolution.reason,
      });
      console.error("[ml/callback] FRONTEND_URL inválida — não redirecionando", {
        errorId,
        reason: frontendResolution.reason,
      });
      return res.status(500).json({
        ok: false,
        error: "FRONTEND_URL inválida no ambiente atual",
        detail: frontendResolution.reason,
        errorId,
      });
    }
    const frontendBase = frontendResolution.base;

    const oauthCtx = await resolveAndConsumeOAuthState(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      state,
      "ml"
    );

    const supabaseProjectRef = maskSupabaseProjectRef(config.supabaseUrl);
    console.info("[ml/callback] state_received", {
      errorId,
      state_ok: Boolean(oauthCtx),
      has_seller_company_id: Boolean(oauthCtx?.seller_company_id),
      supabase_project_ref: supabaseProjectRef,
      callback_host: resolveRequestHostname(req),
      redirect_uri_host: extractUrlHostname(process.env.ML_REDIRECT_URI),
    });

    const supabaseUserId = oauthCtx?.user_id ?? null;
    const sellerCompanyIdFromOAuthState = oauthCtx?.seller_company_id ?? null;
    const hadExplicitStateSellerCompany =
      sellerCompanyIdFromOAuthState != null && String(sellerCompanyIdFromOAuthState).trim() !== "";
    const flowTypeFromState =
      oauthCtx?.flow_type === "additional_account" || oauthCtx?.flow_type === "first_account"
        ? oauthCtx.flow_type
        : null;
    const prohibitPrimarySellerFallback = flowTypeFromState === "additional_account" || hadExplicitStateSellerCompany;

    if (!supabaseUserId) {
      const stateDiag = await diagnoseOAuthStateLookup(
        config.supabaseUrl,
        config.supabaseServiceRoleKey,
        typeof state === "string" ? state : String(state),
        "ml"
      );
      logMlCallbackFailed({
        errorId,
        etapa: "oauth_state",
        error_code: "invalid_state",
        error_message: "Invalid/expired state (user_id ausente)",
        supabase_project_ref: stateDiag.supabase_project_ref,
        state_found_expired: stateDiag.found_expired,
        state_found_active: stateDiag.found_active,
        callback_host: resolveRequestHostname(req),
        redirect_uri_host: extractUrlHostname(process.env.ML_REDIRECT_URI),
      });
      /** @type {Record<string, unknown>} */
      const body = { ok: false, error: "Invalid/expired state" };
      if (stateDiag.found_expired && !stateDiag.found_active) {
        body.hint = "oauth_state_expired";
        body.detail =
          "O state OAuth expirou (TTL ~15 min). Inicie a conexão novamente em Integrações.";
      } else if (!stateDiag.found_expired && !stateDiag.found_active) {
        body.hint = "oauth_state_not_in_this_database";
        body.detail =
          "State não encontrado neste ambiente Supabase. Verifique se ML_REDIRECT_URI e SUPABASE_URL do backend que iniciou o OAuth coincidem com este callback.";
        body.supabase_project_ref = stateDiag.supabase_project_ref;
      }
      return res.status(401).json(body);
    }

    console.info("[ml/callback] state_resolved", {
      errorId,
      user_id: supabaseUserId,
      seller_company_id_from_state: sellerCompanyIdFromOAuthState,
      flow_type: flowTypeFromState ?? (hadExplicitStateSellerCompany ? "additional_account" : "first_account"),
      flow_type_from_db: flowTypeFromState,
      prohibit_primary_seller_fallback: prohibitPrimarySellerFallback,
    });
    console.info("[ml/callback] state_resolved_full", {
      errorId,
      flow_type: flowTypeFromState ?? (hadExplicitStateSellerCompany ? "additional_account" : "first_account"),
      flow_type_from_db: flowTypeFromState,
      seller_company_id: sellerCompanyIdFromOAuthState,
      user_id: supabaseUserId,
    });

    const supabase = createServiceRoleSupabase();

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", supabaseUserId)
      .maybeSingle();

    if (profileError || !profile) {
      logMlCallbackFailed({
        errorId,
        etapa: "profile_verify",
        error_code: profileError?.code ?? "profile_not_found",
        error_message: profileError?.message ?? "profiles sem linha para user_id do state",
        user_id: supabaseUserId,
      });
      return res.status(401).json({ error: "Usuário inválido para este state" });
    }

    const redirectUri = process.env.ML_REDIRECT_URI?.trim();
    if (!redirectUri) {
      return res.status(500).json({
        ok: false,
        error: "ML_REDIRECT_URI não configurada",
        errorId,
      });
    }

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.ML_CLIENT_ID.trim(),
      client_secret: process.env.ML_CLIENT_SECRET.trim(),
      code: typeof code === "string" ? code : String(code),
      redirect_uri: redirectUri,
    });

    const tokenResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    });

    const rawTokenText = await tokenResponse.text();
    /** @type {Record<string, unknown>} */
    let mlData = {};
    try {
      mlData = rawTokenText ? JSON.parse(rawTokenText) : {};
    } catch {
      mlData = { _raw: rawTokenText?.slice?.(0, 500) ?? "" };
    }

    if (!tokenResponse.ok || !mlData.access_token) {
      logMlCallbackFailed({
        errorId,
        etapa: "token_exchange",
        error_code: mlData.error != null ? String(mlData.error) : `http_${tokenResponse.status}`,
        error_message: String(mlData.message ?? mlData.cause ?? "token_exchange_failed").slice(0, 500),
        http_status: tokenResponse.status,
        user_id: supabaseUserId,
      });
      sendMlCallbackIntegrationRedirect(res, frontendBase, "ml_error=token", {
        reason: "token_exchange",
        is_success: false,
      });
      return;
    }

    console.info("[ml/callback] token_exchange_ok", {
      errorId,
      user_id: supabaseUserId,
      http_status: tokenResponse.status,
      has_access_token: Boolean(mlData?.access_token),
      ml_user_id: mlData?.user_id != null ? String(mlData.user_id) : null,
      token_user_id_present: mlData.user_id != null && String(mlData.user_id).trim() !== "",
    });

    const expiresAt = resolveExpiresAtIso(mlData);

    console.info("[ml/callback] users_me_start", { errorId, user_id: supabaseUserId });
    /** @type {Record<string, unknown> | null} */
    let meData = null;
    try {
      meData = await fetchMercadoLibreUserMe(String(mlData.access_token), {});
    } catch (e) {
      const msg = e?.message ? String(e.message) : String(e);
      const st = e && typeof e === "object" && "status" in e ? /** @type {{ status?: number }} */ (e).status : null;
      logMlCallbackFailed({
        errorId,
        etapa: "users_me",
        error_code: st != null ? `http_${st}` : "users_me_fetch",
        error_message: msg,
        user_id: supabaseUserId,
      });
      sendMlCallbackIntegrationRedirect(
        res,
        frontendBase,
        new URLSearchParams({
          ml_error: "incomplete_connect",
          ml_error_detail: "users_me_failed",
        }).toString(),
        { reason: "users_me_failed", is_success: false }
      );
      return;
    }

    console.info("[ml/callback] seller_profile_loaded", {
      errorId,
      user_id: supabaseUserId,
      ml_user_id: meData?.id != null ? String(meData.id) : null,
      nickname: meData?.nickname != null ? String(meData.nickname) : null,
    });

    const externalFromMe =
      meData?.id != null && String(meData.id).trim() !== "" ? String(meData.id).trim() : "";
    const externalFromToken =
      mlData.user_id != null && String(mlData.user_id).trim() !== "" ? String(mlData.user_id).trim() : "";
    const externalSellerId = externalFromMe;

    console.info("[ml/callback] users_me_ok", {
      errorId,
      user_id: supabaseUserId,
      external_seller_id: externalSellerId,
      users_me_id: externalFromMe || null,
      used_token_user_id_fallback: !externalFromMe && Boolean(externalFromToken),
      nickname: meData?.nickname ?? null,
      site_id: meData?.site_id ?? null,
    });
    console.info("[ml/callback] ml_identity_resolved", {
      errorId,
      ml_user_id: externalSellerId,
      nickname: meData?.nickname != null ? String(meData.nickname) : null,
      user_id: supabaseUserId,
      seller_company_id: sellerCompanyIdFromOAuthState,
    });
    console.info("[ml/callback] users_me_id", {
      errorId,
      user_id: supabaseUserId,
      users_me_id: externalFromMe || null,
      token_user_id: externalFromToken || null,
    });

    console.info("[ml/callback] external_seller_resolved", {
      errorId,
      user_id: supabaseUserId,
      external_seller_id: externalSellerId,
      used_token_user_id_fallback: !externalFromMe && Boolean(externalFromToken),
    });

    if (!externalSellerId) {
      logMlCallbackFailed({
        errorId,
        etapa: "resolve_external_seller_id",
        error_code: "users_me_id_missing",
        error_message: "users/me sem id; callback não pode inferir seller por fallback do token",
        user_id: supabaseUserId,
        oauth_token_keys: Object.keys(mlData || {}).filter((k) => !/token|secret|access|refresh/i.test(k)),
      });
      sendMlCallbackIntegrationRedirect(
        res,
        frontendBase,
        new URLSearchParams({
          ml_error: "incomplete_connect",
          ml_error_detail: "users_me_id_missing",
        }).toString(),
        { reason: "users_me_id_missing", is_success: false }
      );
      return;
    }

    const mlNickname =
      meData?.nickname != null && String(meData.nickname).trim() !== ""
        ? String(meData.nickname).trim()
        : null;
    const siteId = meData?.site_id != null ? String(meData.site_id) : null;

    if (!mlData.refresh_token) {
      console.warn("[ml/callback] ml_refresh_token_absent", {
        errorId,
        user_id: supabaseUserId,
      });
    }

    const resolvedSellerCompanyId = await resolveSellerCompanyIdForMlCallback(
      supabase,
      supabaseUserId,
      sellerCompanyIdFromOAuthState,
      { prohibitPrimaryFallback: prohibitPrimarySellerFallback }
    );

    console.info("[ml/callback] seller_company_resolved", {
      errorId,
      user_id: supabaseUserId,
      seller_company_id: resolvedSellerCompanyId,
      from_oauth_state: hadExplicitStateSellerCompany,
      flow_type_from_state: flowTypeFromState,
      prohibit_primary_seller_fallback: prohibitPrimarySellerFallback,
    });

    if (!resolvedSellerCompanyId) {
      if (hadExplicitStateSellerCompany || flowTypeFromState === "additional_account") {
        logMlCallbackFailed({
          errorId,
          etapa: "seller_company_state_invalid",
          error_code: "oauth_seller_company_mismatch",
          error_message:
            "Não foi possível identificar o CNPJ desta conexão (seller_company_id do state inválido ou não pertence ao usuário). Refaça pela tela de Integrações.",
          user_id: supabaseUserId,
          external_seller_id: externalSellerId,
        });
        sendMlCallbackIntegrationRedirect(
          res,
          frontendBase,
          new URLSearchParams({
            ml_error: "oauth_company",
            ml_error_detail: "invalid_seller_company",
          }).toString(),
          { reason: "oauth_company", is_success: false }
        );
        return;
      }
      logMlCallbackFailed({
        errorId,
        etapa: "seller_company_resolve",
        error_code: "no_seller_company",
        error_message: "Nenhuma seller_company para o usuário; cadastro da conta ML não pode ser concluído.",
        user_id: supabaseUserId,
        external_seller_id: externalSellerId,
      });
      sendMlCallbackIntegrationRedirect(res, frontendBase, "ml_error=no_seller_company", {
        reason: "no_seller_company",
        is_success: false,
      });
      return;
    }

    if (hadExplicitStateSellerCompany && resolvedSellerCompanyId) {
      console.info("[ml/callback] state_seller_company_validated", {
        errorId,
        user_id: supabaseUserId,
        seller_company_id: resolvedSellerCompanyId,
        external_seller_id: externalSellerId,
      });
    }

    console.info("[ml/callback] seller_company_for_account", {
      errorId,
      user_id: supabaseUserId,
      seller_company_id: resolvedSellerCompanyId,
      external_seller_id: externalSellerId,
      from_oauth_state: hadExplicitStateSellerCompany,
    });

    const mlMeTaxDigits = extractMlMeTaxDigits(meData);
    const { digits: companyTaxDigits } = await fetchSellerCompanyTaxDigits(supabase, supabaseUserId, resolvedSellerCompanyId);

    console.info("[ml/callback] document_validation_start", {
      errorId,
      user_id: supabaseUserId,
      seller_company_id: resolvedSellerCompanyId,
      ml_tax_digits_len: mlMeTaxDigits.length,
      company_tax_digits_len: companyTaxDigits.length,
    });

    const docMatch = assertMlDocumentMatchesSellerCompanyCnpj(mlMeTaxDigits, companyTaxDigits);
    if (!docMatch.ok) {
      console.warn("[ml/callback] document_validation_failed", {
        errorId,
        user_id: supabaseUserId,
        seller_company_id: resolvedSellerCompanyId,
        external_seller_id: externalSellerId,
        reason: docMatch.reason,
      });
      const rev = await revokeMercadoLibreAccessToken(String(mlData.access_token));
      console.info("[ml/callback] cleanup_after_document_mismatch", {
        errorId,
        user_id: supabaseUserId,
        revoke_ok: rev.ok === true,
        revoke_skipped: rev.skipped === true,
        revoke_http_status: rev.http_status ?? null,
      });
      logMlCallbackFailed({
        errorId,
        etapa: "ml_cnpj_mismatch",
        error_code: "ml_cnpj_mismatch",
        error_message: "Documento da conta Mercado Livre difere do CNPJ da empresa selecionada no Suse7.",
        user_id: supabaseUserId,
        seller_company_id: resolvedSellerCompanyId,
        external_seller_id: externalSellerId,
        document_validation_reason: docMatch.reason,
      });
      sendMlCallbackIntegrationRedirect(
        res,
        frontendBase,
        new URLSearchParams({
          ml_error: "ml_cnpj_mismatch",
          ml_error_detail: String(docMatch.reason || "users_me_identification"),
        }).toString(),
        { reason: "ml_cnpj_mismatch", is_success: false }
      );
      return;
    }

    console.info("[ml/callback] document_validation_ok", {
      errorId,
      user_id: supabaseUserId,
      seller_company_id: resolvedSellerCompanyId,
      reason: docMatch.reason,
    });

    const bindingCheck = await assertMlBindingAllowedBeforeUpsert(
      supabase,
      supabaseUserId,
      ML_MARKETPLACE_SLUG,
      externalSellerId,
      resolvedSellerCompanyId
    );
    if (!bindingCheck.ok) {
      logMlCallbackFailed({
        errorId,
        etapa: "ml_binding_guard",
        error_code: bindingCheck.code,
        error_message: bindingCheck.message,
        user_id: supabaseUserId,
        seller_company_id: resolvedSellerCompanyId,
        external_seller_id: externalSellerId,
      });
      sendMlCallbackIntegrationRedirect(
        res,
        frontendBase,
        new URLSearchParams({
          ml_error: bindingCheck.code,
          ml_error_detail: "binding_conflict",
        }).toString(),
        { reason: bindingCheck.code, is_success: false }
      );
      return;
    }

    console.info("[ml/callback] marketplace_account_upsert_input", {
      errorId,
      user_id: supabaseUserId,
      seller_company_id: resolvedSellerCompanyId,
      external_seller_id: externalSellerId,
    });

    console.info("[ml/callback] account_upsert_before", {
      errorId,
      user_id: supabaseUserId,
      seller_company_id: resolvedSellerCompanyId,
      external_seller_id: externalSellerId,
      flow_type_from_state: flowTypeFromState,
      prefer_explicit_seller_company: hadExplicitStateSellerCompany,
    });

    console.info("[ml/callback] account_upsert_start", {
      errorId,
      external_seller_id: externalSellerId,
      seller_company_id: resolvedSellerCompanyId,
      user_id: supabaseUserId,
    });

    const accResult = await upsertMercadoLivreMarketplaceAccount(supabase, {
      userId: supabaseUserId,
      marketplace: ML_MARKETPLACE_SLUG,
      externalSellerId,
      sellerCompanyIdCandidate: resolvedSellerCompanyId,
      preferExplicitSellerCompany: hadExplicitStateSellerCompany,
      mlNickname,
      tokenExpiresAt: expiresAt,
      siteId,
      rawMeJson: meData,
    });

    console.info("[ml/callback] account_upsert_after", {
      errorId,
      user_id: supabaseUserId,
      ok: accResult.ok === true,
      account_id: accResult.accountId ?? null,
      created: accResult.created === true,
      external_seller_id: externalSellerId,
      seller_company_id: resolvedSellerCompanyId,
    });

    if (!accResult.ok || !accResult.accountId) {
      const er = accResult.error && typeof accResult.error === "object" ? accResult.error : {};
      logMlCallbackFailed({
        errorId,
        etapa: "marketplace_account_upsert",
        error_code: er.code ?? "upsert_failed",
        error_message: er.message ?? String(accResult.error),
        user_id: supabaseUserId,
        seller_company_id: resolvedSellerCompanyId,
        external_seller_id: externalSellerId,
      });
      console.error("[ml/callback] marketplace_account_upsert_error", {
        errorId,
        user_id: supabaseUserId,
        seller_company_id: resolvedSellerCompanyId,
        external_seller_id: externalSellerId,
        error_code: er.code ?? null,
        error_message: er.message ?? String(accResult.error),
      });
      const errCode = er.code != null ? String(er.code) : "";
      const mlErr =
        errCode === "ml_seller_wrong_company" || errCode === "ml_company_already_connected" ? errCode : "account_save";
      const detail =
        errCode === "ml_seller_wrong_company" || errCode === "ml_company_already_connected"
          ? errCode
          : "marketplace_accounts";
      sendMlCallbackIntegrationRedirect(
        res,
        frontendBase,
        new URLSearchParams({
          ml_error: mlErr,
          ml_error_detail: detail,
        }).toString(),
        { reason: "marketplace_account_upsert_failed", is_success: false }
      );
      return;
    }

    const { data: verifyAcc, error: verifyErr } = await supabase
      .from("marketplace_accounts")
      .select("id, user_id, marketplace, external_seller_id, status, seller_company_id")
      .eq("id", accResult.accountId)
      .eq("user_id", supabaseUserId)
      .maybeSingle();

    if (verifyErr || !verifyAcc?.id) {
      logMlCallbackFailed({
        errorId,
        etapa: "marketplace_account_verify",
        error_code: verifyErr?.code ?? "post_upsert_row_missing",
        error_message: verifyErr?.message ?? "SELECT pós-upsert não retornou linha esperada",
        user_id: supabaseUserId,
        marketplace_account_id: accResult.accountId,
        seller_company_id: resolvedSellerCompanyId,
        external_seller_id: externalSellerId,
      });
      sendMlCallbackIntegrationRedirect(
        res,
        frontendBase,
        new URLSearchParams({
          ml_error: "account_save",
          ml_error_detail: "marketplace_account_verify",
        }).toString(),
        { reason: "marketplace_account_verify_failed", is_success: false }
      );
      return;
    }

    console.info("[ml/callback] marketplace_account_upsert_result", {
      errorId,
      user_id: supabaseUserId,
      marketplace_account_id: verifyAcc?.id ?? accResult.accountId ?? null,
      seller_company_id: verifyAcc?.seller_company_id ?? null,
      external_seller_id: verifyAcc?.external_seller_id ?? null,
    });

    console.info("[ml/callback] marketplace_account_bound_to_company", {
      errorId,
      marketplace_account_id: verifyAcc?.id ?? null,
      seller_company_id_on_account: verifyAcc?.seller_company_id ?? null,
      seller_company_id_resolved_from_oauth: resolvedSellerCompanyId,
      external_seller_id: verifyAcc?.external_seller_id ?? null,
    });

    console.info("[ml/callback] account_upsert_done", {
      errorId,
      user_id: supabaseUserId,
      marketplace_account_id: verifyAcc?.id ?? accResult.accountId ?? null,
      external_seller_id: verifyAcc?.external_seller_id ?? externalSellerId,
      seller_company_id: verifyAcc?.seller_company_id ?? resolvedSellerCompanyId,
      status: verifyAcc?.status ?? null,
    });

    const accExt = verifyAcc?.external_seller_id != null ? String(verifyAcc.external_seller_id).trim() : "";
    const prePersistAligned = accExt !== "" && accExt === String(externalSellerId).trim();
    if (!prePersistAligned) {
      logMlCallbackFailed({
        errorId,
        etapa: "token_alignment_pre_persist",
        error_code: "token_account_mismatch",
        error_message:
          "marketplace_account.external_seller_id diferente de users_me.id; bloqueando persistência de token",
        user_id: supabaseUserId,
        marketplace_account_id: accResult.accountId,
        marketplace_account_external_seller_id: accExt || null,
        users_me_id: externalSellerId,
      });
      sendMlCallbackIntegrationRedirect(
        res,
        frontendBase,
        new URLSearchParams({
          ml_error: "token_account_mismatch",
          ml_error_detail: "pre_persist_alignment",
        }).toString(),
        { reason: "token_alignment_pre_persist", is_success: false }
      );
      return;
    }

    const tokenRow = {
      user_id: supabaseUserId,
      marketplace: ML_MARKETPLACE_SLUG,
      ml_user_id: externalSellerId,
      external_seller_id: externalSellerId,
      marketplace_account_id: accResult.accountId,
      seller_company_id: resolvedSellerCompanyId,
      ml_nickname: mlNickname,
      access_token: mlData.access_token,
      refresh_token: mlData.refresh_token ?? null,
      expires_in:
        typeof mlData.expires_in === "number" && Number.isFinite(mlData.expires_in)
          ? mlData.expires_in
          : parseInt(String(mlData.expires_in ?? "21600"), 10) || 21600,
      expires_at: expiresAt,
      scope: mlData.scope ?? "",
      token_type: mlData.token_type ?? "bearer",
      updated_at: new Date().toISOString(),
    };
    console.info("[ml/callback] persist_token_input", {
      errorId,
      user_id: supabaseUserId,
      seller_company_id: resolvedSellerCompanyId,
      users_me_id: externalSellerId,
      external_seller_id: externalSellerId,
      ml_user_id: tokenRow.ml_user_id,
      marketplace_account_id: accResult.accountId,
    });

    console.info("[ml/callback] before_persist_tokens", {
      errorId,
      user_id: supabaseUserId,
      marketplace_account_id: accResult.accountId ?? null,
      ml_user_id: meData?.id != null ? String(meData.id) : null,
    });

    console.info("[ml/callback] token_upsert_start", {
      errorId,
      ml_user_id: externalSellerId,
      seller_company_id: resolvedSellerCompanyId,
      marketplace_account_id: accResult.accountId,
    });

    const persistResult = await persistMlTokens(supabase, tokenRow);

    const persistErrMsg =
      persistResult?.error && typeof persistResult.error === "object" && "message" in persistResult.error
        ? String(/** @type {{ message?: string }} */ (persistResult.error).message ?? "")
        : persistResult?.error != null
          ? String(persistResult.error)
          : null;
    console.info("[ml/callback] persist_result", {
      errorId,
      ok: persistResult?.ok === true,
      marketplace_account_id: persistResult?.marketplace_account_id ?? accResult.accountId ?? null,
      error_code:
        persistResult?.error && typeof persistResult.error === "object" && "code" in persistResult.error
          ? String(/** @type {{ code?: string }} */ (persistResult.error).code ?? "")
          : null,
      error: persistErrMsg,
    });

    if (!persistResult?.ok) {
      const per = persistResult.error && typeof persistResult.error === "object" ? persistResult.error : {};
      logMlCallbackFailed({
        errorId,
        etapa: "persist_ml_tokens",
        error_code: /** @type {{ code?: string }} */ (per).code ?? "persist_ml_tokens_failed",
        error_message: /** @type {{ message?: string }} */ (per).message ?? String(persistResult.error ?? "persist_ml_tokens"),
        user_id: supabaseUserId,
        external_seller_id: externalSellerId,
        marketplace_account_id: accResult.accountId,
      });
      sendMlCallbackIntegrationRedirect(
        res,
        frontendBase,
        new URLSearchParams({
          ml_error: "persist_tokens_failed",
          ml_error_detail: String(/** @type {{ code?: string }} */ (per).code ?? "unknown").slice(0, 200),
        }).toString(),
        { reason: "persist_ml_tokens_failed", is_success: false }
      );
      return;
    }

    console.info("[ml/callback] token_upsert_done", {
      errorId,
      user_id: supabaseUserId,
      ml_user_id: externalSellerId,
      marketplace_account_id: persistResult?.marketplace_account_id ?? accResult.accountId ?? null,
      seller_company_id: resolvedSellerCompanyId,
    });

    let dbMlTokenUserId = tokenRow.ml_user_id;
    try {
      const rowSel = await supabase
        .from("ml_tokens")
        .select("ml_user_id, marketplace_account_id")
        .eq("user_id", supabaseUserId)
        .eq("marketplace", ML_MARKETPLACE_SLUG)
        .eq("ml_user_id", externalSellerId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!rowSel.error && rowSel.data?.ml_user_id != null) {
        dbMlTokenUserId = String(rowSel.data.ml_user_id);
      }
    } catch {
      /* ignore */
    }

    const accountMatchesOauth = accExt !== "" && accExt === String(externalSellerId).trim();
    const tokenMatchesOauth = String(dbMlTokenUserId || "").trim() === String(externalSellerId).trim();
    const aligned = accountMatchesOauth && tokenMatchesOauth;
    console.info("[ml/callback] token_account_alignment_check", {
      errorId,
      user_id: supabaseUserId,
      marketplace_account_id: accResult.accountId,
      external_seller_id: verifyAcc?.external_seller_id ?? externalSellerId,
      ml_token_user_id: dbMlTokenUserId,
      account_matches_oauth: accountMatchesOauth,
      token_matches_oauth: tokenMatchesOauth,
      aligned,
    });
    if (!aligned) {
      logMlCallbackFailed({
        errorId,
        etapa: "token_alignment_post_persist",
        error_code: "token_account_mismatch",
        error_message: "Token persistido, porém conta/token desalinhados com users/me",
        user_id: supabaseUserId,
        marketplace_account_id: accResult.accountId,
        marketplace_account_external_seller_id: accExt || null,
        oauth_external_seller_id: externalSellerId,
        ml_token_user_id: dbMlTokenUserId,
      });
      sendMlCallbackIntegrationRedirect(
        res,
        frontendBase,
        new URLSearchParams({
          ml_error: "token_account_mismatch",
          ml_error_detail: "post_persist_alignment",
        }).toString(),
        { reason: "token_alignment_post_persist", is_success: false }
      );
      return;
    }
    let tokenLookupProbe = await supabase
      .from("ml_tokens")
      .select("id, ml_user_id, marketplace_account_id")
      .eq("user_id", supabaseUserId)
      .eq("marketplace", ML_MARKETPLACE_SLUG)
      .eq("ml_user_id", externalSellerId)
      .order("updated_at", { ascending: false })
      .limit(2);
    if (
      tokenLookupProbe.error &&
      (String(tokenLookupProbe.error?.code ?? "") === "42703" ||
        String(tokenLookupProbe.error?.message ?? "").toLowerCase().includes("column"))
    ) {
      tokenLookupProbe = await supabase
        .from("ml_tokens")
        .select("id, ml_user_id")
        .eq("user_id", supabaseUserId)
        .eq("marketplace", ML_MARKETPLACE_SLUG)
        .eq("ml_user_id", externalSellerId)
        .order("updated_at", { ascending: false })
        .limit(2);
    }
    const probeRows = Array.isArray(tokenLookupProbe.data) ? tokenLookupProbe.data : [];
    const tokenPresent = probeRows.length > 0;
    const tokenRowAccountId =
      probeRows[0]?.marketplace_account_id != null ? String(probeRows[0].marketplace_account_id).trim() : "";
    const tokenAccountAligned = !tokenRowAccountId || tokenRowAccountId === String(accResult.accountId);
    if (tokenLookupProbe.error || !tokenPresent || !tokenAccountAligned) {
      logMlCallbackFailed({
        errorId,
        etapa: "token_lookup_by_marketplace_account",
        error_code: "token_account_mismatch",
        error_message: tokenLookupProbe.error
          ? tokenLookupProbe.error.message
          : !tokenPresent
            ? "Token não encontrado para users_me.id"
            : "Token encontrado com marketplace_account_id diferente",
        user_id: supabaseUserId,
        marketplace_account_id: accResult.accountId,
        users_me_id: externalSellerId,
        token_marketplace_account_id: tokenRowAccountId || null,
      });
      sendMlCallbackIntegrationRedirect(
        res,
        frontendBase,
        new URLSearchParams({
          ml_error: "token_account_mismatch",
          ml_error_detail: "token_lookup_failed",
        }).toString(),
        { reason: "token_lookup_failed", is_success: false }
      );
      return;
    }

    console.info("[ml/callback] persist_token_ok", {
      errorId,
      user_id: supabaseUserId,
      marketplace_account_id: accResult.accountId,
      external_seller_id: externalSellerId,
      ml_user_id: tokenRow.ml_user_id,
      users_me_id: externalSellerId,
      seller_company_id: resolvedSellerCompanyId,
    });
    console.info("[ml/callback] token_persisted_for_account", {
      errorId,
      user_id: supabaseUserId,
      marketplace_account_id: accResult.accountId,
      external_seller_id: externalSellerId,
      seller_company_id: resolvedSellerCompanyId,
    });

    /** Sincronização inicial fica manual (Integrações → Iniciar sincronização). */
    const jobsCreated = 0;
    const jobsSkipped = true;
    console.info("[ml/callback] initial_sync_jobs_deferred", {
      errorId,
      user_id: supabaseUserId,
      marketplace_account_id: accResult.accountId,
      seller_company_id: resolvedSellerCompanyId,
      note: "OAuth não enfileira jobs; seller dispara POST start-initial-sync na UI.",
    });

    const verifyId = verifyAcc?.id != null ? String(verifyAcc.id).trim() : "";
    const canonicalAccountId = String(
      verifyId || persistResult?.marketplace_account_id || accResult.accountId || ""
    ).trim();

    if (!ML_CALLBACK_ACCOUNT_UUID_RE.test(canonicalAccountId)) {
      console.error("[ml/callback] canonical_account_id_null_trace", {
        errorId,
        user_id: supabaseUserId,
        verify_id_empty: !verifyId,
        acc_result_account_id: accResult.accountId ?? null,
        persist_marketplace_account_id: persistResult?.marketplace_account_id ?? null,
        canonical_computed: canonicalAccountId || "(empty)",
        branch: !verifyId
          ? "verifyAcc.id_missing"
          : !accResult.accountId
            ? "accResult.accountId_missing"
            : !ML_CALLBACK_ACCOUNT_UUID_RE.test(String(accResult.accountId || "").trim())
              ? "accResult.accountId_invalid_uuid"
              : "canonical_concat_failed",
      });
      logMlCallbackFailed({
        errorId,
        etapa: "success_redirect_guard",
        error_code: "invalid_marketplace_account_id",
        error_message: "UUID da conta ausente ou inválido antes do redirect de sucesso — não enviar ml=connected",
        user_id: supabaseUserId,
        marketplace_account_id_verify: verifyId || null,
        marketplace_account_id_raw: accResult.accountId ?? null,
        persist_marketplace_account_id: persistResult?.marketplace_account_id ?? null,
      });
      const failQs = new URLSearchParams();
      failQs.set("ml_error", "missing_marketplace_account_id");
      failQs.set("ml_error_detail", "invalid_uuid_before_success_redirect");
      console.error("[ml/callback] fatal_missing_marketplace_account_id", {
        errorId,
        user_id: supabaseUserId,
        marketplace_account_id_verify: verifyId || null,
        marketplace_account_id_raw: accResult.accountId ?? null,
        persist_marketplace_account_id: persistResult?.marketplace_account_id ?? null,
      });
      sendMlCallbackIntegrationRedirect(res, frontendBase, failQs.toString(), {
        reason: "missing_marketplace_account_id",
        is_success: false,
        account_from_upsert: accResult.accountId ?? null,
        persist_marketplace_account_id: persistResult?.marketplace_account_id ?? null,
      });
      return;
    }

    const q = new URLSearchParams();
    q.set("ml", "connected");
    q.set("connected", "1");
    q.set("ml_account", canonicalAccountId);
    q.set("marketplace_account_id", canonicalAccountId);
    q.set("jobs_created", "0");
    q.set("ml_awaiting_sync", "1");

    console.info("[ml/callback] final_redirect_payload", {
      errorId,
      marketplace_account_id: canonicalAccountId,
      external_seller_id: externalSellerId,
      seller_company_id: resolvedSellerCompanyId,
      persist_marketplace_account_id: persistResult?.marketplace_account_id ?? null,
      account_from_upsert: accResult.accountId ?? null,
      verify_account_id: verifyId || null,
      ml_awaiting_sync: true,
      jobs_created: jobsCreated,
      redirect_query: q.toString(),
    });

    console.info("[ml/oauth/redirect] marketplace_account_id_from_url", {
      marketplace_account_id: canonicalAccountId,
      user_id: supabaseUserId,
      seller_company_id: resolvedSellerCompanyId,
      external_seller_id: externalSellerId,
    });
    console.info("[ml/callback] redirect_with_marketplace_account_id", {
      errorId,
      user_id: supabaseUserId,
      marketplace_account_id: canonicalAccountId,
      seller_company_id: resolvedSellerCompanyId,
      external_seller_id: externalSellerId,
      status: "active",
      ml_awaiting_sync: true,
    });

    sendMlCallbackIntegrationRedirect(res, frontendBase, q.toString(), {
      reason: "oauth_success",
      is_success: true,
      marketplace_account_id: canonicalAccountId,
      canonical_account_id: canonicalAccountId,
      account_from_upsert: accResult.accountId ?? null,
      persist_marketplace_account_id: persistResult?.marketplace_account_id ?? null,
    });
  } catch (err) {
    const envCheck = validateEnv(ML_CALLBACK_ENV_KEYS);
    logMlCallbackFailed({
      errorId,
      etapa: "unhandled_exception",
      error_code: "internal",
      error_message: err?.message ? String(err.message) : String(err),
      missing_env: !envCheck.ok ? envCheck.missing : null,
    });
    console.error("[ml/callback] errorId:", errorId, {
      message: err?.message,
      stack: err?.stack,
      missingEnv: envCheck.missing,
    });
    const diagnosticMsg = envCheck.ok
      ? err?.message || "Erro interno no callback ML"
      : `Missing env: ${envCheck.missing.join(", ")}`;
    return res.status(500).json({
      ok: false,
      error: diagnosticMsg,
      errorId,
    });
  }
}

export default handleMLCallback;
