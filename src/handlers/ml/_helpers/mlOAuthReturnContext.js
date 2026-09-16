// ======================================================================
// Contexto seguro de retorno pós-OAuth ML — origem allowlisted + state assinado.
// Sem schema migration: envelope v1 embutido no parâmetro `state` do OAuth.
// ======================================================================

import { createHmac, timingSafeEqual } from "crypto";
import { generateSecureState } from "./oauthConnect.js";

export const DEFAULT_ML_INTEGRATION_RETURN_PATH = "/perfil/integracoes/mercado-livre";

const STATE_VERSION = "v1";
const STATE_TTL_MS = 15 * 60 * 1000;

const STATIC_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://suse7.com.br",
  "https://www.suse7.com.br",
];

/** @param {string | null | undefined} value */
function base64urlEncode(value) {
  return Buffer.from(String(value ?? ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** @param {string} value */
function base64urlDecode(value) {
  const padded = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64").toString("utf8");
}

/**
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function normalizeFrontendOrigin(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * @param {string | null | undefined} rawPath
 * @returns {string | null}
 */
export function normalizeMlIntegrationReturnPath(rawPath) {
  const fallback = DEFAULT_ML_INTEGRATION_RETURN_PATH;
  const trimmed = rawPath != null ? String(rawPath).trim() : "";
  if (!trimmed) return fallback;
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.startsWith("//")) return null;
  if (trimmed.includes("://")) return null;
  if (trimmed.includes("?") || trimmed.includes("#")) return null;
  if (trimmed !== DEFAULT_ML_INTEGRATION_RETURN_PATH) return null;
  return trimmed;
}

/** @returns {Set<string>} */
export function getAllowedMlOAuthFrontendOrigins() {
  /** @type {string[]} */
  const extra = [];
  const fromList = String(process.env.ML_OAUTH_ALLOWED_FRONTEND_ORIGINS ?? "")
    .split(",")
    .map((s) => normalizeFrontendOrigin(s))
    .filter(Boolean);
  extra.push(...fromList);

  const fromFrontend = normalizeFrontendOrigin(process.env.FRONTEND_URL);
  if (fromFrontend) extra.push(fromFrontend);

  return new Set([...STATIC_ALLOWED_ORIGINS, ...extra].filter(Boolean));
}

/** @param {string} origin */
export function isAllowlistedMlOAuthFrontendOrigin(origin) {
  const normalized = normalizeFrontendOrigin(origin);
  if (!normalized) return false;
  return getAllowedMlOAuthFrontendOrigins().has(normalized);
}

function getMlOAuthStateSigningSecret() {
  const explicit = String(process.env.ML_OAUTH_STATE_SECRET ?? "").trim();
  if (explicit) return explicit;
  const serviceRole = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (serviceRole.length >= 16) {
    return `ml-oauth-state:${serviceRole.slice(0, 32)}`;
  }
  return null;
}

/** @param {string} payloadB64 */
function signMlOAuthStatePayload(payloadB64) {
  const secret = getMlOAuthStateSigningSecret();
  if (!secret) {
    throw new Error("ML_OAUTH_STATE_SECRET_OR_SERVICE_ROLE_REQUIRED");
  }
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/** @param {string} payloadB64 @param {string} signature */
function verifyMlOAuthStateSignature(payloadB64, signature) {
  const expected = signMlOAuthStatePayload(payloadB64);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature ?? ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * @param {{
 *   frontendOrigin: string;
 *   returnPath?: string | null;
 *   nowMs?: number;
 * }} params
 */
export function buildSignedMlOAuthState(params) {
  const origin = normalizeFrontendOrigin(params.frontendOrigin);
  if (!origin || !isAllowlistedMlOAuthFrontendOrigin(origin)) {
    return { ok: false, reason: "origin_not_allowlisted" };
  }
  const rawReturnPath = params.returnPath != null ? String(params.returnPath).trim() : "";
  let returnPath = DEFAULT_ML_INTEGRATION_RETURN_PATH;
  if (rawReturnPath) {
    const normalizedPath = normalizeMlIntegrationReturnPath(rawReturnPath);
    if (!normalizedPath) {
      return { ok: false, reason: "return_path_rejected" };
    }
    returnPath = normalizedPath;
  }
  const nowMs = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
  const nonce = generateSecureState();
  /** @type {{ v: number; n: string; o: string; p: string; e: number }} */
  const payload = {
    v: 1,
    n: nonce,
    o: origin,
    p: returnPath,
    e: nowMs + STATE_TTL_MS,
  };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  let signature;
  try {
    signature = signMlOAuthStatePayload(payloadB64);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "signing_secret_unavailable",
    };
  }
  const state = `${STATE_VERSION}.${payloadB64}.${signature}`;
  return {
    ok: true,
    state,
    frontendOrigin: origin,
    returnPath,
    expiresAtMs: payload.e,
  };
}

/**
 * @param {string | null | undefined} stateParam
 * @param {{ nowMs?: number }} [options]
 */
export function verifySignedMlOAuthState(stateParam, options = {}) {
  const state = String(stateParam ?? "").trim();
  if (!state) return { ok: false, reason: "state_missing" };
  if (!state.startsWith(`${STATE_VERSION}.`)) {
    return { ok: false, reason: "legacy_state", legacy: true };
  }
  const parts = state.split(".");
  if (parts.length !== 3 || parts[0] !== STATE_VERSION) {
    return { ok: false, reason: "state_format_invalid" };
  }
  const payloadB64 = parts[1];
  const signature = parts[2];
  if (!payloadB64 || !signature) {
    return { ok: false, reason: "state_format_invalid" };
  }
  if (!verifyMlOAuthStateSignature(payloadB64, signature)) {
    return { ok: false, reason: "state_signature_invalid" };
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64));
  } catch {
    return { ok: false, reason: "state_payload_invalid" };
  }
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const exp = Number(payload?.e);
  if (!Number.isFinite(exp) || exp < nowMs) {
    return { ok: false, reason: "state_expired" };
  }
  const origin = normalizeFrontendOrigin(payload?.o);
  if (!origin || !isAllowlistedMlOAuthFrontendOrigin(origin)) {
    return { ok: false, reason: "origin_not_allowlisted" };
  }
  const returnPath = normalizeMlIntegrationReturnPath(payload?.p);
  if (!returnPath) {
    return { ok: false, reason: "return_path_rejected" };
  }
  return {
    ok: true,
    frontendOrigin: origin,
    returnPath,
    nonce: payload?.n != null ? String(payload.n) : null,
    expiresAtMs: exp,
  };
}

/**
 * Resolve origem confiável no /connect (query > Origin > Referer > FRONTEND_URL).
 * @param {{
 *   queryOrigin?: string | null;
 *   headerOrigin?: string | null;
 *   headerReferer?: string | null;
 *   fallbackFrontendUrl?: string | null;
 * }} input
 */
export function resolveTrustedMlOAuthFrontendOrigin(input = {}) {
  const candidates = [
    input.queryOrigin,
    input.headerOrigin,
    input.headerReferer,
    input.fallbackFrontendUrl,
  ];
  for (const candidate of candidates) {
    const origin = normalizeFrontendOrigin(candidate);
    if (origin && isAllowlistedMlOAuthFrontendOrigin(origin)) {
      return {
        ok: true,
        origin,
        returnPath: DEFAULT_ML_INTEGRATION_RETURN_PATH,
        source: candidate === input.fallbackFrontendUrl ? "fallback_frontend_url" : "request",
      };
    }
  }
  return { ok: false, reason: "origin_not_allowlisted" };
}

/**
 * @param {{
 *   stateParam?: string | null;
 *   envFrontendUrl?: string | null;
 *   nowMs?: number;
 * }} input
 */
export function resolveMlOAuthCallbackFrontendBase(input = {}) {
  const verified = verifySignedMlOAuthState(input.stateParam, { nowMs: input.nowMs });
  if (verified.ok) {
    return {
      ok: true,
      base: verified.frontendOrigin,
      returnPath: verified.returnPath,
      source: "signed_state",
    };
  }
  const fallbackOrigin = normalizeFrontendOrigin(input.envFrontendUrl);
  if (fallbackOrigin && isAllowlistedMlOAuthFrontendOrigin(fallbackOrigin)) {
    return {
      ok: true,
      base: fallbackOrigin,
      returnPath: DEFAULT_ML_INTEGRATION_RETURN_PATH,
      source: verified.legacy ? "legacy_state_env_fallback" : "env_fallback",
      stateWarning: verified.reason,
    };
  }
  return {
    ok: false,
    reason: verified.reason ?? "frontend_origin_unresolved",
    source: "fail_closed",
  };
}

/**
 * @param {string} frontendBase
 * @param {string} [returnPath]
 * @param {string} querySuffix
 */
export function buildMlOAuthIntegrationRedirectUrl(frontendBase, returnPath, querySuffix) {
  const base = normalizeFrontendOrigin(frontendBase) ?? String(frontendBase || "").replace(/\/+$/, "");
  const path = normalizeMlIntegrationReturnPath(returnPath) ?? DEFAULT_ML_INTEGRATION_RETURN_PATH;
  const qs = String(querySuffix ?? "").replace(/^\?/, "");
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}
