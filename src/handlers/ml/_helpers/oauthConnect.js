// ======================================================
// HELPERS — OAuth Connect (Strategy/Adapter para marketplaces)
// Uso: ML connect, futuros marketplaces (Shopee, etc.)
// ======================================================

import { randomBytes } from "crypto";
import { createClient } from "@supabase/supabase-js";

// ----------------------------------------------
// validateEnv — Valida variáveis de ambiente necessárias
// Retorna: { ok: boolean, missing: string[] }
// ----------------------------------------------
export function validateEnv(requiredKeys) {
  const missing = requiredKeys.filter((key) => !process.env[key]?.trim());
  return {
    ok: missing.length === 0,
    missing,
  };
}

/** @param {string | undefined} host req.headers.host */
function isLocalBackendHost(host) {
  if (!host || typeof host !== "string") return false;
  const h = host.split(":")[0]?.toLowerCase() ?? "";
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]" ||
    host.includes("localhost") ||
    host.startsWith("127.0.0.1:")
  );
}

function isPlaceholderMlClientId(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return true;
  if (s === "your-ml-client-id" || s === "your_ml_client_id") return true;
  if (/your-|placeholder|changeme|example|dummy|replace|troque|test-client/i.test(s)) return true;
  return false;
}

function isPlaceholderMlClientSecret(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return true;
  if (s === "your-ml-client-secret" || s === "your_ml_client_secret") return true;
  if (/your-|placeholder|changeme|example|dummy|replace|troque/i.test(s)) return true;
  return false;
}

function isPlaceholderOrInvalidMlRedirectUri(raw) {
  const s = String(raw || "").trim();
  if (!s) return true;
  const lower = s.toLowerCase();
  if (/your-|placeholder|changeme|example\.com\/|dummy|replace_me|troque/i.test(lower)) return true;
  if (!/^https?:\/\//i.test(s)) return true;
  try {
    const u = new URL(s);
    const pathNorm = u.pathname.replace(/\/+$/, "") || "/";
    if (pathNorm !== "/api/ml/callback") {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Hosts públicos exigem HTTPS; localhost/127.0.0.1 podem usar http se estiverem cadastrados no ML.
 * @param {string} redirectUri
 * @returns {string | null} mensagem de erro ou null
 */
function mlRedirectUriHttpsPolicyError(redirectUri) {
  try {
    const u = new URL(String(redirectUri || "").trim());
    const h = u.hostname.toLowerCase();
    const isLocal = h === "localhost" || h === "127.0.0.1";
    if (isLocal) {
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return "ML_REDIRECT_URI: para localhost use http:// ou https://.";
      }
      return null;
    }
    if (u.protocol !== "https:") {
      return "ML_REDIRECT_URI deve usar HTTPS para hosts públicos e coincidir exatamente com a URI cadastrada no app Mercado Livre.";
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Ambiente lógico para logs (não confundir com NODE_ENV da Vercel).
 */
export function getMlOAuthRuntimeLabel() {
  const n = String(process.env.NODE_ENV || "development").toLowerCase();
  if (n === "production") return "production";
  if (n === "test") return "test";
  return "development";
}

/**
 * Preview mascarado do App ID (logs e diagnóstico; nunca logar o secret).
 * @param {string | undefined} clientId
 */
export function maskMlClientIdForLog(clientId) {
  const s = String(clientId || "").trim();
  if (!s) return "(empty)";
  if (s.length <= 8) return `***len=${s.length}`;
  return `${s.slice(0, 4)}…${s.slice(-4)} (len=${s.length})`;
}

/**
 * Classifica redirect para logs e política de callback (sem segredos).
 * @param {string | undefined} redirectUri
 * @returns {{ isLocalRedirect: boolean; oauthMode: "local" | "hosted-dev" | "public-tunnel" | "prod" }}
 */
export function classifyMlOAuthRedirect(redirectUri) {
  try {
    const u = new URL(String(redirectUri || "").trim());
    const h = u.hostname.toLowerCase();
    const isLocal = h === "localhost" || h === "127.0.0.1";
    if (isLocal) {
      return { isLocalRedirect: true, oauthMode: /** @type {const} */ ("local") };
    }
    if (/\.vercel\.app$/i.test(h)) {
      if (/-dev\.vercel\.app$/i.test(h)) {
        return { isLocalRedirect: false, oauthMode: /** @type {const} */ ("hosted-dev") };
      }
      return { isLocalRedirect: false, oauthMode: /** @type {const} */ ("prod") };
    }
    if (/(^|\.)suse7\.com\.br$/i.test(h)) {
      return { isLocalRedirect: false, oauthMode: /** @type {const} */ ("prod") };
    }
    if (
      /ngrok/i.test(h) ||
      /trycloudflare\.com$/i.test(h) ||
      /\.loca\.lt$/i.test(h) ||
      /localhost\.run$/i.test(h) ||
      /\.serveo\.net$/i.test(h)
    ) {
      return { isLocalRedirect: false, oauthMode: /** @type {const} */ ("public-tunnel") };
    }
    if (u.protocol === "https:") {
      return { isLocalRedirect: false, oauthMode: /** @type {const} */ ("public-tunnel") };
    }
    return { isLocalRedirect: false, oauthMode: /** @type {const} */ ("prod") };
  } catch {
    return { isLocalRedirect: false, oauthMode: /** @type {const} */ ("prod") };
  }
}

/**
 * Falha explícita se ML_CLIENT_ID / ML_REDIRECT_URI / ML_CLIENT_SECRET forem placeholders ou incoerentes com backend local.
 * @param {import("http").IncomingMessage | { headers?: Record<string, string | string[] | undefined> }} req
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateMlConnectOAuthEnv(req) {
  /** @type {string[]} */
  const errors = [];
  const clientId = process.env.ML_CLIENT_ID?.trim() ?? "";
  const redirectUri = process.env.ML_REDIRECT_URI?.trim() ?? "";
  const secret = process.env.ML_CLIENT_SECRET?.trim() ?? "";
  const frontendUrl = process.env.FRONTEND_URL?.trim() ?? "";
  const host = req?.headers?.host != null ? String(req.headers.host) : "";

  if (!frontendUrl) {
    errors.push(
      "FRONTEND_URL ausente: defina a URL base do frontend (DEV: http://localhost:5173 | PROD: https://app.suse7.com.br)."
    );
  }

  if (!clientId) errors.push("ML_CLIENT_ID ausente: defina o App ID do Mercado Livre (número do painel).");
  else if (isPlaceholderMlClientId(clientId)) {
    errors.push(
      "ML_CLIENT_ID parece valor de exemplo (ex.: your-ml-client-id). Copiar só o .env.example sem substituir quebra o OAuth. Use o ID real do aplicativo em https://developers.mercadolivre.com.br/"
    );
  } else if (host && isLocalBackendHost(host)) {
    const forbiddenRaw = (process.env.ML_LOCAL_DEV_FORBIDDEN_CLIENT_IDS || "").trim();
    if (forbiddenRaw) {
      const forbidden = forbiddenRaw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (forbidden.includes(clientId)) {
        errors.push(
          `DEV ML: ML_CLIENT_ID ${maskMlClientIdForLog(clientId)} está em ML_LOCAL_DEV_FORBIDDEN_CLIENT_IDS (ex.: app de produção). Use o app Suse7-DEV no painel com ML_CLIENT_ID, ML_CLIENT_SECRET e ML_REDIRECT_URI idênticos ao cadastro (ex.: HTTPS do deploy dev na Vercel). Verifique .env.local — o Vercel CLI pode sobrescrever o .env.`
        );
      }
    }
    const expected = (process.env.ML_LOCAL_DEV_EXPECTED_CLIENT_ID || "").trim();
    if (expected && clientId !== expected) {
      errors.push(
        `DEV ML: ML_CLIENT_ID (${maskMlClientIdForLog(clientId)}) diverge de ML_LOCAL_DEV_EXPECTED_CLIENT_ID (${maskMlClientIdForLog(expected)}). Ajuste o ID e o secret para o mesmo aplicativo cadastrado com redirect ${redirectUri || "(ML_REDIRECT_URI)"}.`
      );
    }
  }

  if (!redirectUri) {
    errors.push(
      "ML_REDIRECT_URI ausente: defina no .env a mesma Redirect URI cadastrada no app Mercado Livre (caracteres idênticos)."
    );
  } else if (isPlaceholderOrInvalidMlRedirectUri(redirectUri)) {
    errors.push(
      "ML_REDIRECT_URI inválida ou placeholder: URL absoluta terminando em /api/ml/callback, igual à do painel do app ML."
    );
  } else {
    const httpsErr = mlRedirectUriHttpsPolicyError(redirectUri);
    if (httpsErr) errors.push(httpsErr);
  }

  if (!secret) {
    errors.push("ML_CLIENT_SECRET ausente: necessário no callback para trocar o code por token.");
  } else if (isPlaceholderMlClientSecret(secret)) {
    errors.push(
      "ML_CLIENT_SECRET parece valor de exemplo. Use o Secret Key real do app no painel do Mercado Livre."
    );
  }

  if (host && isLocalBackendHost(host) && frontendUrl && !/localhost|127\.0\.0\.1/i.test(frontendUrl)) {
    errors.push(
      "Incoerência DEV: FRONTEND_URL não é local mas o backend é localhost. Para DEV use FRONTEND_URL=http://localhost:5173 (ou a porta do Vite)."
    );
  }

  if (process.env.ML_OAUTH_REQUIRE_PUBLIC_CALLBACK === "1" && redirectUri) {
    const { isLocalRedirect } = classifyMlOAuthRedirect(redirectUri);
    if (isLocalRedirect) {
      errors.push(
        "OAuth ML: ML_REDIRECT_URI aponta para localhost — se o painel não tiver essa URI cadastrada ou o ML bloquear, use HTTPS (ex.: deploy dev na Vercel ou túnel) e a mesma URI no .env e no app."
      );
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true };
}

// ----------------------------------------------
// generateSecureState — Gera state seguro (randomBytes + base64url)
// ----------------------------------------------
export function generateSecureState() {
  const bytes = randomBytes(32);
  return bytes.toString("base64url");
}

// ----------------------------------------------
// buildMlAuthUrl — Monta URL OAuth do Mercado Livre
// ----------------------------------------------
export function buildMlAuthUrl(clientId, redirectUri, state) {
  const base = "https://auth.mercadolivre.com.br/authorization";
  const params = new URLSearchParams({
    response_type: "code",
    client_id: String(clientId || "").trim(),
    redirect_uri: String(redirectUri || "").trim(),
    state,
    // Escopos explícitos (ML): sem read, /orders/search pode não retornar vendas do vendedor.
    scope: "offline_access read write",
  });
  return `${base}?${params.toString()}`;
}

// ----------------------------------------------
// persistOAuthState — Persiste state no Supabase (service role, bypass RLS)
// Retorna { data, error } para diagnóstico (não lança)
// ----------------------------------------------
export async function persistOAuthState(supabaseUrl, serviceRoleKey, state, userId, marketplace = "ml") {
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { data, error } = await supabase.from("oauth_states").insert({
    state,
    user_id: userId,
    marketplace,
    expires_at: expiresAt,
  });

  return { data, error };
}

// ----------------------------------------------
// resolveOAuthState — Busca user_id pelo state (callback)
// Retorna user_id ou null se expirado/inválido
// ----------------------------------------------
export async function resolveOAuthState(supabaseUrl, serviceRoleKey, state, marketplace = "ml") {
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await supabase
    .from("oauth_states")
    .select("user_id")
    .eq("state", state)
    .eq("marketplace", marketplace)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !data) return null;
  return data.user_id;
}

// ----------------------------------------------
// resolveAndConsumeOAuthState — Lê user_id e remove o state (one-time)
// ----------------------------------------------
export async function resolveAndConsumeOAuthState(
  supabaseUrl,
  serviceRoleKey,
  state,
  marketplace = "ml"
) {
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .eq("marketplace", marketplace)
    .gt("expires_at", now)
    .select("user_id")
    .maybeSingle();

  if (error) {
    console.error("[oauth] resolveAndConsumeOAuthState", error);
    return null;
  }
  return data?.user_id ?? null;
}
