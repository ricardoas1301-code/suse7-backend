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

/**
 * Project ref Supabase (ex.: ujznkyvgqhxagemdgmor) — só para logs/diagnóstico.
 * @param {string | undefined | null} supabaseUrl
 */
export function maskSupabaseProjectRef(supabaseUrl) {
  const s = String(supabaseUrl || "").trim();
  if (!s) return "(empty)";
  try {
    const m = s.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
    return m?.[1] ? m[1] : "(unknown)";
  } catch {
    return "(parse-error)";
  }
}

/**
 * @param {string | undefined | null} rawUrl
 */
export function extractUrlHostname(rawUrl) {
  try {
    return new URL(String(rawUrl || "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Host efetivo da requisição (sem porta).
 * @param {import("http").IncomingMessage | { headers?: Record<string, string | string[] | undefined> }} req
 */
export function resolveRequestHostname(req) {
  const host = req?.headers?.host != null ? String(req.headers.host) : "";
  if (!host) return "";
  return host.split(":")[0]?.toLowerCase() ?? "";
}

/**
 * Base pública do backend derivada de ML_REDIRECT_URI (.../api/ml/callback).
 * @param {string | undefined | null} redirectUri
 */
export function deriveMlOAuthBackendBaseFromRedirectUri(redirectUri) {
  const s = String(redirectUri || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    const pathNorm = u.pathname.replace(/\/+$/, "") || "/";
    if (pathNorm !== "/api/ml/callback") return null;
    u.pathname = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * DEV típico: connect em localhost:3001, callback HTTPS na Vercel — state deve ser
 * persistido no mesmo Supabase que o callback. Redireciona o /connect para o host do callback.
 *
 * @param {import("http").IncomingMessage | { headers?: Record<string, string | string[] | undefined> }} req
 * @param {string | undefined | null} redirectUri
 * @returns {{ shouldProxy: boolean; reason: string | null; targetConnectUrl: string | null; connectHost: string; callbackHost: string }}
 */
export function resolveMlOAuthConnectHostProxy(req, redirectUri) {
  const connectHost = resolveRequestHostname(req);
  const callbackHost = extractUrlHostname(redirectUri);
  const empty = {
    shouldProxy: false,
    reason: null,
    targetConnectUrl: null,
    connectHost,
    callbackHost,
  };
  if (!connectHost || !callbackHost) return empty;
  if (connectHost === callbackHost) return empty;

  const connectIsLocal =
    connectHost === "localhost" || connectHost === "127.0.0.1" || connectHost === "::1";
  const callbackIsLocal = callbackHost === "localhost" || callbackHost === "127.0.0.1";
  if (connectIsLocal && callbackIsLocal) return empty;

  const backendBase = deriveMlOAuthBackendBaseFromRedirectUri(redirectUri);
  if (!backendBase) {
    return {
      ...empty,
      reason: "invalid_redirect_uri_for_proxy",
    };
  }

  return {
    shouldProxy: true,
    reason: "connect_callback_host_mismatch",
    targetConnectUrl: backendBase,
    connectHost,
    callbackHost,
  };
}

/**
 * Monta URL absoluta de /api/ml/connect no host do callback (preserva query OAuth).
 * @param {string} backendBase — ex.: https://suse7-backend-dev.vercel.app
 * @param {import("http").IncomingMessage & { url?: string; query?: Record<string, unknown> }} req
 */
export function buildMlOAuthConnectProxyUrl(backendBase, req) {
  const base = String(backendBase || "").trim().replace(/\/+$/, "");
  const qs = new URLSearchParams();
  const q = req.query && typeof req.query === "object" ? req.query : {};
  for (const [key, value] of Object.entries(q)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, String(v));
    } else {
      qs.set(key, String(value));
    }
  }
  if (!qs.has("user_id") && req.url) {
    try {
      const u = new URL(String(req.url), "http://local");
      for (const [key, value] of u.searchParams.entries()) {
        if (!qs.has(key)) qs.set(key, value);
      }
    } catch {
      /* ignore */
    }
  }
  const suffix = qs.toString();
  return `${base}/api/ml/connect${suffix ? `?${suffix}` : ""}`;
}

/**
 * Diagnóstico seguro quando resolveAndConsumeOAuthState retorna null.
 * @returns {Promise<{ found_expired: boolean; found_active: boolean; supabase_project_ref: string }>}
 */
export async function diagnoseOAuthStateLookup(supabaseUrl, serviceRoleKey, state, marketplace = "ml") {
  const ref = maskSupabaseProjectRef(supabaseUrl);
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const now = new Date().toISOString();
  let foundExpired = false;
  let foundActive = false;
  try {
    const { data: expiredRow } = await supabase
      .from("oauth_states")
      .select("state, expires_at")
      .eq("state", state)
      .eq("marketplace", marketplace)
      .lte("expires_at", now)
      .maybeSingle();
    foundExpired = Boolean(expiredRow?.state);
  } catch {
    /* ignore */
  }
  try {
    const { data: activeRow } = await supabase
      .from("oauth_states")
      .select("state, expires_at")
      .eq("state", state)
      .eq("marketplace", marketplace)
      .gt("expires_at", now)
      .maybeSingle();
    foundActive = Boolean(activeRow?.state);
  } catch {
    /* ignore */
  }
  return {
    found_expired: foundExpired,
    found_active: foundActive,
    supabase_project_ref: ref,
  };
}

/**
 * Detecta backend DEV servindo env de PROD (causa comum: seller_company “não existe” + Invalid/expired state).
 * @param {import("http").IncomingMessage | { headers?: Record<string, string | string[] | undefined> }} [req]
 */
export function evaluateMlOAuthBackendEnvCoherence(req) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const errors = [];
  const backendHost =
    resolveRequestHostname(req) ||
    extractUrlHostname(process.env.VERCEL_URL) ||
    extractUrlHostname(process.env.VERCEL_BRANCH_URL);
  const redirectHost = extractUrlHostname(process.env.ML_REDIRECT_URI);
  const frontendHost = extractUrlHostname(process.env.FRONTEND_URL);
  const supabaseRef = maskSupabaseProjectRef(process.env.SUPABASE_URL);
  const expectedRef = String(process.env.S7_EXPECTED_SUPABASE_PROJECT_REF || "")
    .trim()
    .toLowerCase();

  const s7AppEnv = String(process.env.S7_APP_ENV || "").trim().toLowerCase();
  const vercelEnv = String(process.env.VERCEL_ENV || "").trim().toLowerCase();
  const isDevBackendHost =
    /-dev\.vercel\.app$/i.test(backendHost) ||
    backendHost === "localhost" ||
    backendHost === "127.0.0.1" ||
    s7AppEnv === "development" ||
    vercelEnv === "preview" ||
    vercelEnv === "development";

  if (
    isDevBackendHost &&
    redirectHost &&
    /suse7-backend\.vercel\.app$/i.test(redirectHost) &&
    !/-dev\.vercel\.app$/i.test(redirectHost)
  ) {
    errors.push(
      "Backend DEV com ML_REDIRECT_URI apontando para suse7-backend.vercel.app (PROD). Defina https://suse7-backend-dev.vercel.app/api/ml/callback no projeto Vercel DEV."
    );
  }

  if (isDevBackendHost && /(^|\.)suse7\.com\.br$/i.test(frontendHost) && !/dev\.|staging\./i.test(frontendHost)) {
    warnings.push(
      "FRONTEND_URL aponta para domínio público de produção enquanto o backend parece DEV — redirects pós-OAuth podem ir para o app errado."
    );
  }

  if (expectedRef && supabaseRef !== "(empty)" && supabaseRef !== "(unknown)" && supabaseRef !== expectedRef) {
    errors.push(
      `SUPABASE_URL (ref ${supabaseRef}) diverge de S7_EXPECTED_SUPABASE_PROJECT_REF (${expectedRef}). seller_companies/OAuth state serão lidos do banco errado.`
    );
  }

  return {
    warnings,
    errors,
    supabaseProjectRef: supabaseRef,
    expectedSupabaseProjectRef: expectedRef || null,
    isDevBackendHost,
    backendHost: backendHost || null,
    redirectHost: redirectHost || null,
    frontendHost: frontendHost || null,
    vercelEnv: vercelEnv || null,
    s7AppEnv: s7AppEnv || null,
  };
}

/**
 * Valida seller_company_id ∈ seller_companies para user_id (service role).
 * Não filtra active=true — empresa inativa ainda pertence ao usuário.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function assertSellerCompanyOwnedForMlConnect(supabase, userId, sellerCompanyId, supabaseUrl) {
  const uid = String(userId || "").trim();
  const sid = String(sellerCompanyId || "").trim();
  const ref = maskSupabaseProjectRef(supabaseUrl);
  const expectedRef = String(process.env.S7_EXPECTED_SUPABASE_PROJECT_REF || "")
    .trim()
    .toLowerCase();
  const selectVariants = ["id, user_id, active", "id, user_id"];

  /** @type {Record<string, unknown> | null} */
  let rowById = null;
  /** @type {{ code?: string; message?: string } | null} */
  let rowByIdErr = null;

  for (const sel of selectVariants) {
    const { data, error } = await supabase.from("seller_companies").select(sel).eq("id", sid).maybeSingle();
    if (!error) {
      rowById = data;
      rowByIdErr = null;
      break;
    }
    if (isPostgrestUnknownColumnError(error)) continue;
    rowByIdErr = error;
    break;
  }

  for (const sel of selectVariants) {
    const { data, error } = await supabase
      .from("seller_companies")
      .select(sel)
      .eq("id", sid)
      .eq("user_id", uid)
      .maybeSingle();
    if (!error && data?.id) {
      return { ok: true, supabase_project_ref: ref };
    }
    if (error && !isPostgrestUnknownColumnError(error)) {
      rowByIdErr = rowByIdErr ?? error;
      break;
    }
  }

  const rowUserId =
    rowById?.user_id != null ? String(rowById.user_id).trim().toLowerCase() : null;
  const uidNorm = uid.toLowerCase();

  /** @type {"not_found_in_database" | "user_id_mismatch" | "query_error"} */
  let reason = "not_found_in_database";
  if (rowById?.id && rowUserId && rowUserId !== uidNorm) reason = "user_id_mismatch";
  else if (rowByIdErr && !rowById?.id) reason = "query_error";

  let hint = "supabase_env_mismatch_probable";
  if (reason === "user_id_mismatch") hint = "seller_company_belongs_to_other_user";
  if (reason === "query_error") hint = "seller_companies_query_failed";

  const envMismatchProbable =
    reason === "not_found_in_database" &&
    Boolean(expectedRef && ref !== "(empty)" && ref !== expectedRef);

  return {
    ok: false,
    code: "seller_company_not_owned_by_user",
    hint,
    reason,
    supabase_project_ref: ref,
    expected_supabase_project_ref: expectedRef || null,
    supabase_env_mismatch_probable: envMismatchProbable,
    diagnostics: {
      table: "seller_companies",
      filters_ownership_query: ["id", "user_id"],
      filters_active_applied: false,
      row_exists_by_id_only: Boolean(rowById?.id),
      row_user_id: rowById?.user_id ?? null,
      requested_user_id: uid,
      user_id_matches: Boolean(rowUserId && rowUserId === uidNorm),
      row_active: rowById?.active ?? null,
      postgrest_error_code: rowByIdErr?.code ?? null,
      postgrest_error_message:
        rowByIdErr?.message != null ? String(rowByIdErr.message).slice(0, 240) : null,
    },
  };
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
/**
 * @param {string | null | undefined} sellerCompanyId - UUID da empresa (opcional); validar no handler /connect.
 * @param {{ flow_type?: string | null }} [options] - flow_type persistido (first_account | additional_account).
 */
export async function persistOAuthState(
  supabaseUrl,
  serviceRoleKey,
  state,
  userId,
  marketplace = "ml",
  sellerCompanyId = null,
  options = {}
) {
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  /** @type {Record<string, unknown>} */
  const row = {
    state,
    user_id: userId,
    marketplace,
    expires_at: expiresAt,
  };
  const co =
    sellerCompanyId != null && String(sellerCompanyId).trim() !== ""
      ? String(sellerCompanyId).trim()
      : null;
  if (co) {
    row.seller_company_id = co;
  }
  const ft =
    options && options.flow_type != null && String(options.flow_type).trim() !== ""
      ? String(options.flow_type).trim()
      : null;
  if (ft) {
    row.flow_type = ft;
  }

  let { data, error } = await supabase.from("oauth_states").insert(row);

  if (error && ft && isPostgrestUnknownColumnError(error)) {
    const { flow_type: _f, ...rowNoFlow } = row;
    const r2 = await supabase.from("oauth_states").insert(rowNoFlow);
    data = r2.data;
    error = r2.error;
    if (!error) {
      console.warn("[oauth] persistOAuthState_flow_type_column_missing", {
        message: "Inseriu oauth_state sem flow_type; rode migration com flow_type para multi-conta.",
      });
    }
  }

  if (error && co && isPostgrestUnknownColumnError(error)) {
    console.error("[oauth] persistOAuthState_missing_seller_company_id_column", {
      message: error.message,
      code: error.code,
      user_id_preview: String(userId || "").slice(0, 8),
      hint: "Adicione a coluna oauth_states.seller_company_id (ver scripts/oauth_states_add_seller_company_id.sql). Não persistir state sem o CNPJ/empresa em fluxo multi-conta.",
    });
    return {
      data: null,
      error: {
        message:
          "oauth_states: coluna seller_company_id ausente. Rode a migration no Supabase antes de conectar nova conta com CNPJ.",
        code: "oauth_states_schema_seller_company_id",
        original: error,
      },
    };
  }

  return { data, error };
}

/** Coluna nova ainda não migrada no ambiente (ex.: seller_company_id em oauth_states). */
function isPostgrestUnknownColumnError(error) {
  const c = String(error?.code ?? "");
  const m = String(error?.message ?? "").toLowerCase();
  return c === "42703" || m.includes("column") || m.includes("does not exist");
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
// resolveAndConsumeOAuthState — Lê user_id (+ seller_company_id) e remove o state (one-time)
// ----------------------------------------------
/**
 * @returns {Promise<{ user_id: string; seller_company_id: string | null; flow_type: string | null } | null>}
 */
export async function resolveAndConsumeOAuthState(
  supabaseUrl,
  serviceRoleKey,
  state,
  marketplace = "ml"
) {
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const now = new Date().toISOString();
  let { data, error } = await supabase
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .eq("marketplace", marketplace)
    .gt("expires_at", now)
    .select("user_id, seller_company_id, flow_type")
    .maybeSingle();

  if (error && isPostgrestUnknownColumnError(error)) {
    console.warn("[oauth] resolveAndConsumeOAuthState_retry_select_user_id_only", {
      message: error.message,
      code: error.code,
    });
    const r2 = await supabase
      .from("oauth_states")
      .delete()
      .eq("state", state)
      .eq("marketplace", marketplace)
      .gt("expires_at", now)
      .select("user_id, seller_company_id")
      .maybeSingle();
    data = r2.data;
    error = r2.error;
  }

  if (error) {
    console.error("[oauth] resolveAndConsumeOAuthState", error);
    return null;
  }
  const uid = data?.user_id != null ? String(data.user_id).trim() : "";
  if (!uid) return null;
  const sid =
    data?.seller_company_id != null && String(data.seller_company_id).trim() !== ""
      ? String(data.seller_company_id).trim()
      : null;
  const flowType =
    data?.flow_type != null && String(data.flow_type).trim() !== "" ? String(data.flow_type).trim() : null;
  return { user_id: uid, seller_company_id: sid, flow_type: flowType };
}
