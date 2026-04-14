// ======================================================
// /api/ml/callback — RECEBE code + state (token seguro)
// Objetivo:
// - Resolver state -> user_id via oauth_states
// - Trocar code por token no Mercado Livre
// - Buscar dados do seller (GET /users/me) para capturar nickname
// - Salvar tokens + ml_nickname no Supabase (ml_tokens)
// - Redirecionar para /perfil/integracoes/mercado-livre
//
// Persistência: createClient com SUPABASE_SERVICE_ROLE_KEY (bypass RLS).
// Se upsert(onConflict) falhar (índice/constraint incompatível com PostgREST),
// fallback explícito: UPDATE por (user_id, marketplace) ou INSERT.
//
// Redirect final:
// - Usa FRONTEND_URL do ambiente (DEV: ex. http://localhost:5173 | PROD: https://suse7.com.br)
// - Validação explícita evita redirect silencioso para URL inválida ou placeholder
// ======================================================

import { createClient } from "@supabase/supabase-js";
import {
  resolveAndConsumeOAuthState,
  validateEnv,
  validateMlConnectOAuthEnv,
} from "./_helpers/oauthConnect.js";
import { ML_MARKETPLACE_SLUG } from "./_helpers/mlMarketplace.js";
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

// ======================================================
// Helpers — URL base do frontend (redirect pós-OAuth)
// ======================================================

/**
 * Remove espaços e barras finais da URL base (sem alterar path interno).
 */
function sanitizeFrontendBaseUrl(value) {
  if (value == null) return "";
  const trimmed = String(value).trim();
  return trimmed.replace(/\/+$/, "");
}

/**
 * Detecta valores típicos de tutorial / .env de exemplo que não devem ir para produção.
 */
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

/**
 * Valida FRONTEND_URL para uso em res.redirect.
 * Exige esquema http(s) e URL parseável; rejeita placeholders óbvios.
 *
 * @returns {{ ok: true, base: string } | { ok: false, reason: string }}
 */
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

/**
 * Monta URL da tela de integração ML com query fixa.
 */
function buildMlIntegrationRedirect(frontendBase, querySuffix) {
  const path = "/perfil/integracoes/mercado-livre";
  return `${frontendBase}${path}?${querySuffix}`;
}

/**
 * Log estruturado de erro PostgREST / Supabase (diagnóstico persistência).
 */
function logSupabasePersistError(context, err) {
  const e = err && typeof err === "object" ? err : { message: String(err) };
  console.error("[ml/callback] supabase_error", context, {
    message: e.message ?? null,
    code: e.code ?? null,
    details: e.details ?? null,
    hint: e.hint ?? null,
    // PostgREST / pg
    constraint: e.constraint ?? e?.cause ?? null,
  });
}

/**
 * Payload enviado ao banco sem vazar tokens completos.
 */
function summarizeMlTokensRowForLog(row) {
  if (!row || typeof row !== "object") return {};
  const at = row.access_token;
  const rt = row.refresh_token;
  return {
    user_id: row.user_id,
    marketplace: row.marketplace,
    ml_user_id: row.ml_user_id,
    ml_nickname: row.ml_nickname,
    expires_at: row.expires_at,
    expires_in: row.expires_in,
    scope: row.scope,
    token_type: row.token_type,
    access_token_prefix: typeof at === "string" ? `${at.slice(0, 14)}…` : null,
    refresh_token_present: typeof rt === "string" && rt.length > 0,
  };
}

/**
 * Cliente Supabase com service role (nunca anon key).
 */
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

/**
 * Persiste ml_tokens: tenta upsert; em falha, update ou insert manual.
 */
async function persistMlTokens(supabase, row) {
  const logSummary = summarizeMlTokensRowForLog(row);

  console.log("[ml/callback] persist_ml_tokens_start", {
    strategy: "upsert",
    onConflict: "user_id,marketplace",
    payload_summary: logSummary,
  });

  const upsertResult = await supabase
    .from("ml_tokens")
    .upsert(row, { onConflict: "user_id,marketplace" })
    .select("id, user_id, marketplace, updated_at");

  if (!upsertResult.error) {
    console.log("[ml/callback] persist_ml_tokens_ok", {
      via: "upsert",
      rows_returned: upsertResult.data?.length ?? 0,
      first: upsertResult.data?.[0] ?? null,
    });
    return { ok: true };
  }

  logSupabasePersistError("persist_tokens_upsert_failed", upsertResult.error);

  console.warn("[ml/callback] persist_ml_tokens_fallback", {
    reason: "upsert_failed_trying_update_then_insert",
  });

  const { data: existing, error: selErr } = await supabase
    .from("ml_tokens")
    .select("id")
    .eq("user_id", row.user_id)
    .eq("marketplace", row.marketplace)
    .maybeSingle();

  if (selErr) {
    logSupabasePersistError("persist_tokens_select_existing_failed", selErr);
    return { ok: false, error: selErr };
  }

  if (existing?.id) {
    const { data: updated, error: updErr } = await supabase
      .from("ml_tokens")
      .update({
        ml_user_id: row.ml_user_id,
        ml_nickname: row.ml_nickname,
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        expires_in: row.expires_in,
        expires_at: row.expires_at,
        scope: row.scope,
        token_type: row.token_type,
        updated_at: row.updated_at,
      })
      .eq("user_id", row.user_id)
      .eq("marketplace", row.marketplace)
      .select("id, updated_at");

    if (updErr) {
      logSupabasePersistError("persist_tokens_update_failed", updErr);
      return { ok: false, error: updErr };
    }

    console.log("[ml/callback] persist_ml_tokens_ok", {
      via: "update",
      rows: updated?.length ?? 0,
      first: updated?.[0] ?? null,
    });
    return { ok: true };
  }

  const { data: inserted, error: insErr } = await supabase
    .from("ml_tokens")
    .insert(row)
    .select("id, user_id, marketplace, updated_at");

  if (insErr) {
    logSupabasePersistError("persist_tokens_insert_failed", insErr);
    return { ok: false, error: insErr };
  }

  console.log("[ml/callback] persist_ml_tokens_ok", {
    via: "insert",
    rows_returned: inserted?.length ?? 0,
    first: inserted?.[0] ?? null,
  });
  return { ok: true };
}

// ======================================================
// Handler principal
// ======================================================

async function handleMLCallback(req, res) {
  const errorId = Date.now();
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Método não permitido" });
    }

    console.log("[ml/callback] EXECUTADO", new Date().toISOString());
    console.log("[ml/callback] req.query.code present?", !!req.query?.code);
    console.log("[ml/callback] req.query.state present?", !!req.query?.state);

    const code = req.query?.code;
    const state = req.query?.state;

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

    // ------------------------------
    // ENV obrigatórias
    // ------------------------------
    const envCheck = validateEnv(ML_CALLBACK_ENV_KEYS);
    if (!envCheck.ok) {
      const msg = `Missing env: ${envCheck.missing.join(", ")}`;
      console.error("[ml/callback] errorId:", errorId, { missingEnv: envCheck.missing });
      return res.status(500).json({
        ok: false,
        error: msg,
        errorId,
      });
    }

    const mlOAuth = validateMlConnectOAuthEnv(req);
    if (!mlOAuth.ok) {
      console.error("[ml/callback] invalid_ml_oauth_env", { errorId, errors: mlOAuth.errors });
      return res.status(500).json({
        ok: false,
        error: "Configuração OAuth do Mercado Livre inválida no servidor",
        errorId,
        details: mlOAuth.errors,
      });
    }

    console.log("[ml/callback] supabase_client", {
      supabase_url_host: (() => {
        try {
          return new URL(config.supabaseUrl).hostname;
        } catch {
          return "(invalid_url)";
        }
      })(),
      service_role_key_prefix: config.supabaseServiceRoleKey
        ? `${String(config.supabaseServiceRoleKey).slice(0, 12)}…`
        : "(missing)",
    });

    // ------------------------------
    // FRONTEND_URL: validar ANTES de consumir state / trocar code
    // (evita perder state e deixar usuário sem redirect utilizável)
    // ------------------------------
    const frontendResolution = resolveValidatedFrontendBaseUrl(process.env.FRONTEND_URL);
    if (!frontendResolution.ok) {
      console.error("[ml/callback] FRONTEND_URL inválida — não redirecionando", {
        errorId,
        reason: frontendResolution.reason,
        rawLength: process.env.FRONTEND_URL?.length ?? 0,
        rawPreview: (() => {
          const r = String(process.env.FRONTEND_URL || "");
          if (!r) return "(empty)";
          return r.length > 80 ? `${r.slice(0, 80)}…` : r;
        })(),
      });
      return res.status(500).json({
        ok: false,
        error: "FRONTEND_URL inválida no ambiente atual",
        detail: frontendResolution.reason,
        errorId,
      });
    }

    const frontendBase = frontendResolution.base;

    // ------------------------------
    // State OAuth (one-time) — mesmo service role
    // ------------------------------
    const supabaseUserId = await resolveAndConsumeOAuthState(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      state,
      "ml"
    );

    if (!supabaseUserId) {
      console.error("[ml/callback] step_failed: resolve_state", { state });
      return res.status(401).json({ ok: false, error: "Invalid/expired state" });
    }

    const supabase = createServiceRoleSupabase();

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", supabaseUserId)
      .maybeSingle();

    if (profileError || !profile) {
      console.error("❌ Usuário inválido no callback ML:", supabaseUserId);
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
      console.error("[ml/callback] step_failed: exchange_code", {
        http_status: tokenResponse.status,
        ml_error: mlData.error ?? null,
        ml_message: mlData.message ?? mlData.cause ?? null,
        body_preview: typeof rawTokenText === "string" ? rawTokenText.slice(0, 400) : null,
      });
      sendRedirect(res, buildMlIntegrationRedirect(frontendBase, "ml_error=token"), 302);
      return;
    }

    const expiresAt = new Date(Date.now() + mlData.expires_in * 1000).toISOString();

    let mlNickname = null;

    try {
      const meResponse = await fetch("https://api.mercadolibre.com/users/me", {
        headers: {
          Authorization: `Bearer ${mlData.access_token}`,
        },
      });

      if (meResponse.ok) {
        const meData = await meResponse.json();
        mlNickname = meData?.nickname || null;
        console.log("✅ ML nickname capturado:", mlNickname);
      } else {
        console.warn("⚠️ Falha ao buscar /users/me:", meResponse.status);
      }
    } catch (meErr) {
      console.warn("⚠️ Erro ao buscar /users/me (ignorado):", meErr?.message);
    }

    const mlUserIdForRow =
      mlData.user_id != null && mlData.user_id !== "" ? String(mlData.user_id) : "";
    if (!mlUserIdForRow) {
      console.error("[ml/callback] step_failed: ml_user_id_missing_from_token_response", {
        keys: Object.keys(mlData || {}),
      });
      sendRedirect(res, buildMlIntegrationRedirect(frontendBase, "ml_error=token"), 302);
      return;
    }

    const row = {
      user_id: supabaseUserId,
      marketplace: ML_MARKETPLACE_SLUG,
      ml_user_id: mlUserIdForRow,
      ml_nickname: mlNickname,
      access_token: mlData.access_token,
      refresh_token: mlData.refresh_token ?? null,
      expires_in: mlData.expires_in,
      expires_at: expiresAt,
      scope: mlData.scope ?? "",
      token_type: mlData.token_type ?? "bearer",
      updated_at: new Date().toISOString(),
    };

    if (!row.refresh_token) {
      console.warn("[ml/callback] ml_refresh_token_absent", {
        user_id: supabaseUserId,
        marketplace: ML_MARKETPLACE_SLUG,
      });
    }

    const persist = await persistMlTokens(supabase, row);

    if (!persist.ok) {
      sendRedirect(res, buildMlIntegrationRedirect(frontendBase, "ml_error=save"), 302);
      return;
    }

    const successUrl = buildMlIntegrationRedirect(frontendBase, "ml=connected");
    console.log("[ml/callback] redirect sucesso → integração ML", {
      errorId,
      host: new URL(frontendBase).hostname,
    });
    sendRedirect(res, successUrl, 302);
    return;
  } catch (err) {
    const envCheck = validateEnv(ML_CALLBACK_ENV_KEYS);
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
