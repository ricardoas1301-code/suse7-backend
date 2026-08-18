// ==================================================
// SUSE7 — CORS SSOT (Edge + Serverless)
// Fonte única de allowlist e headers para preflight/runtime.
// ==================================================

/** @type {readonly string[]} */
export const BASE_ALLOWED_ORIGINS = [
  "https://suse7.com.br",
  "https://www.suse7.com.br",
  "https://suse7-frontend-dev.vercel.app",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:5176",
  "https://localhost:5173",
  "http://localhost:3000",
  "https://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
  "http://127.0.0.1:5176",
  "https://127.0.0.1:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://[::1]:5173",
  "http://[::1]:5174",
  "http://[::1]:5175",
  "http://[::1]:5176",
  "http://[::1]:3000",
];

export const CORS_ALLOW_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
export const CORS_MAX_AGE = "86400";

const BASE_ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",
  "X-Trace-Id",
  "X-Job-Secret",
  "Accept",
  "Prefer",
  "Apikey",
  "X-Client-Info",
];

/**
 * @param {string | undefined} origin
 */
export function isLocalDevOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function buildAllowedOriginsSet(env = process.env) {
  /** @type {Set<string>} */
  const allowed = new Set(BASE_ALLOWED_ORIGINS);
  const extraRaw = [env.CORS_ALLOWED_ORIGINS, env.CORS_ORIGINS].filter(Boolean).join(",");
  if (extraRaw.trim()) {
    for (const o of extraRaw.split(",")) {
      const t = o.trim();
      if (t) allowed.add(t);
    }
  }
  return allowed;
}

/**
 * @param {string | null | undefined} origin
 * @param {string | null | undefined} referer
 * @param {{ strictLocal?: boolean; env?: Record<string, string | undefined> }} [options]
 * @returns {string | null}
 */
export function resolvePermittedOrigin(origin, referer, options = {}) {
  const env = options.env ?? process.env;
  const strictLocal = options.strictLocal ?? env.CORS_STRICT_LOCALHOST === "1";
  const allowedOrigins = buildAllowedOriginsSet(env);

  let inferredOrigin = null;
  if (!origin && typeof referer === "string" && referer.trim()) {
    try {
      const u = new URL(referer);
      inferredOrigin = `${u.protocol}//${u.host}`;
    } catch {
      inferredOrigin = null;
    }
  }

  const originCandidate = origin ?? inferredOrigin;
  if (
    originCandidate &&
    (allowedOrigins.has(originCandidate) || (!strictLocal && isLocalDevOrigin(originCandidate)))
  ) {
    return originCandidate;
  }
  return null;
}

/**
 * @param {string | undefined | null} accessControlRequestHeaders
 */
export function buildAllowHeaders(accessControlRequestHeaders) {
  /** @type {Set<string>} */
  const set = new Set(BASE_ALLOW_HEADERS.map((s) => s.toLowerCase()));
  if (typeof accessControlRequestHeaders === "string" && accessControlRequestHeaders.trim()) {
    for (const part of accessControlRequestHeaders.split(",")) {
      const t = part.trim();
      if (t) set.add(t.toLowerCase());
    }
  }
  const ordered = [...set].sort();
  return ordered
    .map((h) =>
      h === "content-type"
        ? "Content-Type"
        : h === "authorization"
          ? "Authorization"
          : h === "x-requested-with"
            ? "X-Requested-With"
            : h === "x-trace-id"
              ? "X-Trace-Id"
              : h === "x-job-secret"
                ? "X-Job-Secret"
                : h === "x-client-info"
                  ? "X-Client-Info"
                  : h === "apikey"
                    ? "Apikey"
                    : h === "accept"
                      ? "Accept"
                      : h === "prefer"
                        ? "Prefer"
                        : h
    )
    .join(", ");
}

/**
 * Monta headers CORS para uma origem permitida (ou vazio se bloqueada).
 * @param {{
 *   originPermitida: string | null;
 *   method?: string;
 *   accessControlRequestHeaders?: string | null;
 * }} input
 * @returns {Record<string, string>}
 */
export function buildCorsResponseHeaders(input) {
  const { originPermitida, method = "GET", accessControlRequestHeaders = null } = input;
  /** @type {Record<string, string>} */
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": buildAllowHeaders(accessControlRequestHeaders),
    "Access-Control-Max-Age": CORS_MAX_AGE,
  };

  if (originPermitida) {
    headers["Access-Control-Allow-Origin"] = originPermitida;
    headers["Access-Control-Allow-Credentials"] = "true";
  } else if (!(method === "OPTIONS")) {
    // Respostas reais sem origem legítima não recebem credenciais espelhadas.
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}
